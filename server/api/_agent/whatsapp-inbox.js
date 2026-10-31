import { db } from '../_lib.js';
import { ensurePersonalAgent } from './personal.js';
import {
    INBOX_INGEST_SCHEMA, INBOX_RESPONSE_SCHEMA, INBOX_UUID_PATTERN, INBOX_ID_PATTERN,
    INBOX_THREAD_PAGE_SIZE, INBOX_MESSAGE_PAGE_SIZE, assertInboxSchema, normalizeInboxEvent,
    cleanInboxText
} from '../../../lib/whatsapp-inbox-contract.mjs';

const UUID = new RegExp(INBOX_UUID_PATTERN);
const MESSAGE_ID = new RegExp(INBOX_ID_PATTERN);
const encode = value => encodeURIComponent(String(value));
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const APPROVAL_FIELDS = 'id,agent_id,original,draft,reason,status,expires_at,created_at,decided_at,delivered_at,activity_at';

async function rest(path, options = {}) {
    const result = await db(path, options);
    if (!result.res.ok) {
        const conflict = ['22023', '23514', '23503', '23505'].includes(result.body?.code);
        const error = failure(conflict ? 'Некорректные данные переписки.' : 'Переписка временно недоступна. Повторите позже.', conflict ? 400 : 503);
        error.code = result.body?.code || String(result.res.status);
        throw error;
    }
    return result.body;
}

const rpc = (name, body) => rest(`rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });

export async function ingestWhatsAppInbox({ device, root }, body) {
    const payload = { captureSince: body.captureSince, events: body.events };
    let events;
    let captureSince;
    try {
        if (Object.keys(body).some(key => !['action', 'captureSince', 'events'].includes(key))) throw new Error('Unexpected field');
        assertInboxSchema(INBOX_INGEST_SCHEMA, payload);
        captureSince = new Date(payload.captureSince).toISOString();
        if (Date.parse(captureSince) > Date.now() + 5 * 60_000) throw new Error('Future capture');
        events = payload.events.map(event => normalizeInboxEvent(event));
        if (events.some(event => Date.parse(event.occurredAt) < Date.parse(captureSince))) throw new Error('Historical event');
    } catch {
        throw failure('Некорректные данные переписки.');
    }
    const result = await rpc('workspace_ingest_whatsapp_inbox', {
        p_root_id: root.id, p_device_id: device.id, p_capture_since: captureSince, p_events: events
    });
    if (result === null || result === false) throw failure('Подключение Mac отозвано.', 401);
    return { ok: true, accepted: events.length };
}

function parameter(value, maximum = 512) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) throw failure('Некорректные параметры переписки.');
    return value;
}

function decodeCursor(value, kind) {
    if (!value) return null;
    try {
        if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Encoding');
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        if (!parsed || Object.keys(parsed).sort().join(',') !== 'at,id,kind' || parsed.kind !== kind
            || typeof parsed.at !== 'string' || parsed.at.length > 40 || !Number.isFinite(Date.parse(parsed.at))
            || typeof parsed.id !== 'string' || !(kind === 'threads' ? UUID : MESSAGE_ID).test(parsed.id)) throw new Error('Cursor');
        return { at: new Date(parsed.at).toISOString(), id: parsed.id };
    } catch { throw failure('Некорректный указатель страницы.'); }
}

const cursorFor = (kind, at, id) => Buffer.from(JSON.stringify({ kind, at, id })).toString('base64url');
const iso = value => new Date(value).toISOString();

function threadView(row) {
    const address = row.recipient.endsWith('@s.whatsapp.net') ? `+${row.recipient.split('@')[0]}` : 'Личный чат WhatsApp';
    return {
        id: row.id, name: cleanInboxText(row.contact_name || address, 128), address,
        updatedAt: iso(row.last_message_at), preview: cleanInboxText(row.last_preview, 240),
        lastDirection: row.last_direction, lastStatus: row.last_status, origin: row.last_origin,
        needsApproval: row.needs_approval === true
    };
}

function messageView(row) {
    return {
        id: row.id, threadId: row.thread_id, direction: row.direction, actor: row.actor, kind: row.kind,
        text: row.text, status: row.status, occurredAt: iso(row.occurred_at), updatedAt: iso(row.updated_at),
        approvalId: row.approval_id || null, replyToId: row.reply_to_id || null,
        origin: row.origin, reason: row.reason || null
    };
}

function approvalView(row, now) {
    const result = {};
    for (const key of APPROVAL_FIELDS.split(',')) if (Object.hasOwn(row, key)) result[key] = row[key];
    if (['pending', 'approved'].includes(result.status) && Date.parse(result.expires_at) <= now) result.status = 'expired';
    return result;
}

// Root ownership comes exclusively from the signed session, never query data.
export async function whatsappInboxOverview(session, query = {}, { now = Date.now() } = {}) {
    const threadId = parameter(query.threadId, 36);
    if (threadId && !UUID.test(threadId)) throw failure('Некорректный чат.');
    const search = parameter(query.search, 120)?.trim() || null;
    const threadsCursor = decodeCursor(parameter(query.threadsCursor), 'threads');
    const messagesCursor = decodeCursor(parameter(query.messagesCursor), 'messages');
    if (messagesCursor && !threadId) throw failure('Выберите чат для загрузки сообщений.');
    const root = await ensurePersonalAgent(session);
    const [devices, page] = await Promise.all([
        rest(`workspace_devices?select=id,last_seen_at,status,whatsapp_inbox_since&root_id=eq.${encode(root.id)}&revoked_at=is.null&limit=1`),
        rpc('workspace_whatsapp_threads_page', {
            p_root_id: root.id, p_search: search,
            p_before_at: threadsCursor?.at || null, p_before_id: threadsCursor?.id || null,
            p_limit: INBOX_THREAD_PAGE_SIZE + 1, p_thread_id: null
        })
    ]);
    const device = devices?.[0];
    const rows = Array.isArray(page) ? page : [];
    const visibleThreads = rows.slice(0, INBOX_THREAD_PAGE_SIZE);
    const lastThread = visibleThreads.at(-1);
    const response = {
        threads: visibleThreads.map(threadView),
        threadPage: { nextCursor: rows.length > INBOX_THREAD_PAGE_SIZE ? cursorFor('threads', iso(lastThread.last_message_at), lastThread.id) : null },
        selectedThread: null, messages: [], messagePage: { olderCursor: null }, approvals: [],
        status: {
            deviceOnline: !!device && Number.isFinite(Date.parse(device.last_seen_at)) && now - Date.parse(device.last_seen_at) < 90_000,
            connected: false, captureSince: device?.whatsapp_inbox_since ? iso(device.whatsapp_inbox_since) : null
        }
    };
    response.status.connected = response.status.deviceOnline && device.status?.whatsapp === 'connected';
    if (threadId) {
        let selected = visibleThreads.find(row => row.id === threadId);
        if (!selected) {
            const matches = await rpc('workspace_whatsapp_threads_page', {
                p_root_id: root.id, p_search: null, p_before_at: null, p_before_id: null,
                p_limit: 1, p_thread_id: threadId
            });
            selected = matches?.[0];
        }
        if (!selected) throw failure('Чат не найден.', 404);
        const messages = await rpc('workspace_whatsapp_messages_page', {
            p_root_id: root.id, p_thread_id: threadId,
            p_before_at: messagesCursor?.at || null, p_before_id: messagesCursor?.id || null,
            p_limit: INBOX_MESSAGE_PAGE_SIZE + 1
        });
        const messageRows = (messages || []).slice(0, INBOX_MESSAGE_PAGE_SIZE);
        const oldest = messageRows.at(-1);
        response.messages = messageRows.map(messageView).reverse();
        response.messagePage.olderCursor = messages.length > INBOX_MESSAGE_PAGE_SIZE ? cursorFor('messages', iso(oldest.occurred_at), oldest.id) : null;
        const approvalIds = [...new Set(messageRows.map(row => row.approval_id).filter(id => typeof id === 'string' && UUID.test(id)))];
        if (approvalIds.length) {
            const approvals = await rest(`workspace_approvals?select=${APPROVAL_FIELDS}&root_id=eq.${encode(root.id)}&device_id=eq.${encode(selected.device_id)}&recipient=eq.${encode(selected.recipient)}&id=in.(${approvalIds.join(',')})&limit=${INBOX_MESSAGE_PAGE_SIZE}`);
            response.approvals = (approvals || []).map(row => approvalView(row, now));
        }
        response.selectedThread = threadView(selected);
    }
    assertInboxSchema(INBOX_RESPONSE_SCHEMA, response);
    return response;
}
