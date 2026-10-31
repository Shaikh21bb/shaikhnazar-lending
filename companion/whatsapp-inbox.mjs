import { createHash } from 'node:crypto';
import { INBOX_BATCH_SIZE, INBOX_UUID_PATTERN, cleanInboxText, normalizeInboxEvent } from '../lib/whatsapp-inbox-contract.mjs';
import { personalWhatsAppJid } from '../lib/whatsapp-policy.mjs';
import { readPrivateJSON, writePrivateJSON } from './runtime.mjs';

const uuid = new RegExp(INBOX_UUID_PATTERN);
export const inboxUuid = value => typeof value === 'string' && uuid.test(value) ? value : null;
export const inboxId = value => createHash('sha256').update(value).digest('hex');
// Remove malformed Unicode before JSON/database transport as well as a cut pair.
const clean = (value, limit = 8000) => cleanInboxText(value, limit).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, '');

// This is deliberately separate from the agent's text parser. Media never
// reaches generation here, and only a kind/caption can cross the device API.
export function inboxMessageContent(value) {
    let content = value;
    for (let depth = 0; depth <= 5; depth++) {
        if (!content || typeof content !== 'object' || content.protocolMessage || content.editedMessage
            || content.reactionMessage || content.pollUpdateMessage || content.senderKeyDistributionMessage) return null;
        if (typeof content.conversation === 'string' || typeof content.extendedTextMessage?.text === 'string') {
            const raw = content.conversation ?? content.extendedTextMessage.text;
            const text = clean(raw);
            return text.trim() ? { kind: 'text', text, reason: raw.length > 8000 ? 'too_long' : null } : null;
        }
        const wrapper = content.ephemeralMessage || content.viewOnceMessage || content.viewOnceMessageV2
            || content.viewOnceMessageV2Extension || content.documentWithCaptionMessage;
        if (wrapper?.message) { if (depth === 5) return null; content = wrapper.message; continue; }
        for (const [field, kind] of [['imageMessage', 'image'], ['videoMessage', 'video'], ['audioMessage', 'audio'],
            ['documentMessage', 'document'], ['stickerMessage', 'sticker'], ['locationMessage', 'location'],
            ['liveLocationMessage', 'location'], ['contactMessage', 'contact'], ['contactsArrayMessage', 'contact']]) {
            if (content[field] && typeof content[field] === 'object') {
                const caption = ['image', 'video', 'document'].includes(kind) && typeof content[field].caption === 'string'
                    ? clean(content[field].caption) : null;
                return { kind, text: caption?.trim() ? caption : null,
                    reason: typeof content[field].caption === 'string' && content[field].caption.length > 8000 ? 'too_long' : null };
            }
        }
        // Known human interactions unsupported by this agent get a placeholder;
        // unknown protocol/control envelopes are not imported as conversations.
        if (['pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3', 'eventMessage',
            'buttonsResponseMessage', 'listResponseMessage', 'templateButtonReplyMessage', 'interactiveResponseMessage']
            .some(field => content[field])) return { kind: 'unsupported', text: null };
        return null;
    }
    return null;
}

export async function createWhatsAppInbox({ filename, deviceId, request, now = () => Date.now(), count = () => {} }) {
    if (!inboxUuid(deviceId)) throw new Error('Для истории WhatsApp требуется сопряжённый Mac.');
    const scope = deviceId.toLowerCase();
    const initialSince = Math.floor(now() / 1000) * 1000;
    const state = await readPrivateJSON(filename, { version: 1, deviceId: scope, captureSince: new Date(initialSince).toISOString(), announced: false, records: {} });
    if (state.version !== 1 || state.deviceId !== scope || !Number.isFinite(Date.parse(state.captureSince))
        || !state.records || typeof state.records !== 'object') throw new Error('Некорректный локальный журнал WhatsApp.');
    let writes = Promise.resolve(), flight, stopped = false;
    const persist = () => {
        writes = writes.catch(() => {}).then(() => writePrivateJSON(filename, state));
        return writes;
    };
    const normalize = event => normalizeInboxEvent({ ...event, text: event.text === null ? null : clean(event.text),
        contactName: event.contactName ? clean(event.contactName, 128) : null,
        agentId: inboxUuid(event.agentId), approvalId: inboxUuid(event.approvalId),
        reason: event.reason ? clean(event.reason, 80) : null }, { now: now() });
    const patch = async (id, changes) => {
        const record = state.records[id];
        if (!record?.event) return;
        const event = normalize({ ...record.event, ...changes, revision: record.event.revision + 1 });
        if (Object.entries(changes).every(([key]) => event[key] === record.event[key])) return;
        record.event = event; record.pending = true; record.updatedAt = now();
        await persist();
    };
    // The ledger keeps only metadata after two days, while unsynced content and
    // open approvals are retained until acknowledged. No pending event is pruned.
    const prune = () => {
        for (const record of Object.values(state.records)) {
            if (!record.pending && record.event && !['received', 'processing', 'awaiting_approval', 'sending'].includes(record.event.status)
                && now() - record.updatedAt > 2 * 24 * 3_600_000) {
                record.revision = record.event.revision; delete record.event;
            }
        }
    };
    for (const record of Object.values(state.records)) {
        if (record.event) {
            record.event = normalize(record.event);
            if (record.event.direction === 'outgoing' && record.event.status === 'sending') {
                record.event = normalize({ ...record.event, status: 'uncertain', reason: 'interrupted', revision: record.event.revision + 1 });
                record.pending = true; record.updatedAt = now();
            } else if (record.event.direction === 'incoming' && ['received', 'processing'].includes(record.event.status)) {
                record.event = normalize({ ...record.event, status: 'skipped', reason: 'interrupted', revision: record.event.revision + 1 });
                record.pending = true; record.updatedAt = now();
            }
        }
    }
    prune();
    await persist(); // Activation survives a restart before the first arrival.

    async function flush() {
        if (stopped) return;
        if (flight) return flight;
        flight = (async () => {
            await writes;
            if (!state.announced) {
                const result = await request({ action: 'whatsapp_inbox', captureSince: state.captureSince, events: [] });
                if (result?.ok !== true || result.accepted !== 0) throw new Error('Inbox acknowledgement missing');
                state.announced = true; await persist();
            }
            while (!stopped) {
                const events = Object.values(state.records).filter(item => item.pending && item.event)
                    .slice(0, INBOX_BATCH_SIZE).map(item => structuredClone(item.event));
                if (!events.length) break;
                const result = await request({ action: 'whatsapp_inbox', captureSince: state.captureSince, events });
                if (result?.ok !== true || result.accepted !== events.length) throw new Error('Inbox acknowledgement missing');
                for (const event of events) {
                    const record = state.records[event.id];
                    // An old response must never discard a newer disposition.
                    if (record?.event?.revision === event.revision) record.pending = false;
                }
                prune(); await persist(); count('inbox.uploaded');
            }
        })().catch(() => { count('inbox.uploadFailed'); }).finally(() => { flight = undefined; });
        return flight;
    }
    const record = async event => {
        if (state.records[event.id]) return; // Provider duplicates cannot rewind status.
        const normalized = normalize({ ...event, revision: 1 });
        state.records[event.id] = { event: normalized, pending: true, updatedAt: now() };
        await persist(); count('inbox.captured');
    };
    return {
        captureSince: state.captureSince,
        has: id => Boolean(id && state.records[id]),
        event: id => state.records[id]?.event,
        record, patch, flush,
        incoming(message, { timestamp, receivedAt, agentId }) {
            if (message.key?.fromMe || !personalWhatsAppJid(message.key?.remoteJid)
                || typeof message.key?.id !== 'string' || !message.key.id || message.key.id.length > 256
                || !Number.isFinite(timestamp) || timestamp < Date.parse(state.captureSince) || timestamp > receivedAt + 60_000) return null;
            const content = inboxMessageContent(message.message);
            if (!content) return null;
            const id = inboxId(`${message.key.remoteJid}:${message.key.id}`);
            return { id, duplicate: Boolean(state.records[id]), saved: record({ id, recipient: message.key.remoteJid, contactName: typeof message.pushName === 'string' ? message.pushName : null,
                agentId, direction: 'incoming', actor: 'contact', ...content, status: 'received',
                occurredAt: new Date(timestamp).toISOString(), approvalId: null, replyToId: null, origin: 'live', reason: content.reason || null }) };
        },
        async idle() { await writes; },
        async stop() { stopped = true; await writes; await flight; }
    };
}
