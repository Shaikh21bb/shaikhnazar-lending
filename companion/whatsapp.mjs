import '../worker/safe-logging.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { approvalReason, assessDraft, explicitOwnerReply, simpleGreeting, personalWhatsAppJid as personalJid, importantFollowup, whatsappHistory, approvalNotice } from '../lib/whatsapp-policy.mjs';
import { readPrivateJSON, writePrivateJSON } from './runtime.mjs';
import { LocalWhatsAppModel } from './whatsapp-model.mjs';
import { ignoreWhatsAppTransportJid, whatsappMessageText, whatsappDiagnosticLogger } from './whatsapp-message.mjs';
import { createWhatsAppInbox, inboxId, inboxUuid } from './whatsapp-inbox.mjs';

const requireWorker = createRequire(new URL('../worker/package.json', import.meta.url));

async function dependencies() {
    try {
        const baileys = await import(pathToFileURL(requireWorker.resolve('@whiskeysockets/baileys')).href);
        return { ...baileys, QRCode: requireWorker('qrcode'), pino: requireWorker('pino') };
    } catch {
        throw new Error('Установи локальный WhatsApp-модуль: npm ci --prefix worker');
    }
}

// The adapter never imports a vault or a local memory index. The only style
// inputs are the owner's explicit workspace agent rules and examples.
export async function createWhatsAppAdapter({ config = {}, request, stateDirectory, loadDependencies = dependencies, localGenerate, now = () => Date.now(), reconnectBaseMs = 1000 }) {
    const directory = path.join(stateDirectory, 'whatsapp');
    const journalPath = path.join(directory, 'delivery.json');
    const diagnosticPath = path.join(directory, 'diagnostics.json');
    const diagnostics = { version: 1, startedAt: new Date(now()).toISOString(), counts: {} };
    const count = name => { diagnostics.counts[name] = (diagnostics.counts[name] || 0) + 1; diagnostics.lastEventAt = new Date(now()).toISOString(); };
    const activePath = path.join(directory, 'active.json');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    // A re-pair creates a different device scope. Never migrate a previous
    // account's pending messages into the newly authenticated device token.
    const inboxDeviceId = inboxUuid(config.deviceId)?.toLowerCase();
    const inbox = inboxDeviceId ? await createWhatsAppInbox({
        filename: path.join(directory, `inbox-${inboxDeviceId}.json`), deviceId: inboxDeviceId, request, now, count
    }) : { has: () => false, event: () => undefined, incoming: () => null,
        record: async () => {}, patch: async () => {}, flush: async () => {}, stop: async () => {} };
    const journal = await readPrivateJSON(journalPath, { inbound: {}, approvals: {} });
    journal.approvalOutbox ||= {};
    const recoverLegacyDeliveryAcks = !journal.deliveryOutbox;
    journal.deliveryOutbox ||= {};
    journal.conversations ||= {};
    journal.handoffs ||= {};
    journal.handoffNotices ||= {};
    journal.selfChecks ||= {};
    let recoveredJournal = false;
    for (const check of Object.values(journal.selfChecks)) {
        if (check.ordinaryStatus === 'sending') { check.ordinaryStatus = 'uncertain'; recoveredJournal = true; }
    }
    for (const [id, status] of Object.entries(journal.approvals)) {
        if (status === 'sending') { journal.approvals[id] = 'uncertain'; recoveredJournal = true; }
        if ((recoverLegacyDeliveryAcks || status === 'sending') && ['sent', 'uncertain', 'cancelled', 'failed', 'sending'].includes(status)) {
            journal.deliveryOutbox[id] = { action: 'delivered', approvalId: id,
                status: status === 'sent' ? 'sent' : ['failed', 'cancelled'].includes(status) ? 'failed' : 'uncertain' };
            recoveredJournal = true;
        }
    }
    for (const notice of Object.values(journal.handoffs)) if (notice.status === 'sending') { notice.status = 'uncertain'; recoveredJournal = true; }
    if (recoveredJournal) await writePrivateJSON(journalPath, journal);
    const saved = await readPrivateJSON(activePath, {});
    let agents = [];
    let socket;
    let state = 'disconnected';
    let qr = null;
    let agentId = saved.agentId || null;
    let intentional = false;
    let connectionAllowed = false;
    let reconnectTimer;
    let reconnectAttempts = 0;
    let credentialSaves = Promise.resolve();
    let connecting;
    let startupChecked = false;
    let lastConnectionOpenAt = null;
    let waiters = [];
    let chain = Promise.resolve();
    let journalWrites = Promise.resolve();
    let activeWrites = Promise.resolve();
    const handoffFlights = new Map();
    const selfCheckFlights = new Map();
    const counts = [];
    let normalizeOwnJid;
    let localDraftModel;
    const draftLocally = localGenerate || (payload => {
        localDraftModel ||= new LocalWhatsAppModel({ url: config.modelURL, model: config.model });
        return localDraftModel.generate(payload);
    });
    const persist = () => {
        journalWrites = journalWrites.catch(() => {}).then(() => writePrivateJSON(journalPath, journal));
        return journalWrites;
    };
    const rememberActive = value => {
        activeWrites = activeWrites.catch(() => {}).then(() => writePrivateJSON(activePath, value));
        return activeWrites;
    };
    const activeAgent = () => {
        const enabled = agents.filter(agent => agent.type === 'whatsapp' && agent.enabled);
        return enabled.length === 1 && enabled[0].id === agentId ? enabled[0] : undefined;
    };
    const conversation = (agent, recipient) => {
        const key = `${agent.id}:${recipient}`;
        const previous = journal.conversations[key];
        if (!previous || now() - previous.updatedAt > 24 * 3_600_000) {
            journal.conversations[key] = { history: [], updatedAt: now() };
        }
        for (const [id, chat] of Object.entries(journal.conversations)) {
            if (now() - chat.updatedAt > 24 * 3_600_000) delete journal.conversations[id];
        }
        return journal.conversations[key];
    };
    const remember = (chat, role, content) => {
        chat.history = whatsappHistory([...chat.history, { role, content }]);
        chat.updatedAt = now();
    };
    const refreshImportant = async (agent, recipient, chat) => {
        try {
            const context = await request({ action: 'whatsapp_context', agentId: agent.id, recipient });
            if (context.pending === false && !Object.values(journal.approvalOutbox).some(item => item.agentId === agent.id && item.recipient === recipient)) delete chat.pendingImportant;
            if (context.pending === true) chat.pendingImportant = { reason: String(context.reason || 'uncertain'),
                externalId: context.externalId, expiresAt: Date.parse(context.expiresAt) || now() + 3_600_000 };
        } catch { /* Keep the local important context while the server is unavailable. */ }
    };
    const notify = result => { for (const done of waiters.splice(0)) done(result); };
    const runtime = async () => { await request({ action: 'runtime', status: { whatsapp: state } }).catch(() => {}); };
    const stillActive = (agent, expectedSocket) => {
        const current = activeAgent();
        return connectionAllowed && !intentional && state === 'connected' && socket === expectedSocket
            && current?.id === agent.id && current.rules === agent.rules && current.examples === agent.examples;
    };
    // Observation uses its own durable queue. Cloud synchronization is never on
    // the critical path for deciding or sending a WhatsApp reply.
    const observe = async operation => {
        try { await operation(); } catch { count('inbox.captureFailed'); }
        void inbox.flush();
    };
    const patchIncoming = (id, changes) => observe(() => inbox.patch(id, changes));
    const selfCheckOrigin = (externalId, approvalId) => Object.values(journal.selfChecks)
        .some(check => externalId && check.externalId === externalId || approvalId && check.approvalId === approvalId) ? 'self_check' : 'live';
    async function sendObserved(sendingSocket, recipient, text, { id, agentId, externalId, approvalId = null, actor = 'agent', origin = 'live' }) {
        const expectedAgent = activeAgent();
        await observe(() => inbox.record({ id, recipient, contactName: null, agentId, direction: 'outgoing', actor,
            kind: 'text', text, status: 'sending', occurredAt: new Date(now()).toISOString(), approvalId,
            replyToId: inbox.has(externalId) ? externalId : null, origin, reason: null }));
        // Persisting history adds an async boundary after callers' policy gate.
        // Re-check that same agent/socket immediately before the external send.
        if (!expectedAgent || expectedAgent.id !== agentId || !stillActive(expectedAgent, sendingSocket)) {
            await observe(() => inbox.patch(id, { status: 'failed', reason: 'inactive' }));
            const error = new Error('Отправка остановлена вместе с агентом.');
            error.whatsappNotAttempted = true;
            throw error;
        }
        try {
            const result = await sendingSocket.sendMessage(recipient, { text });
            await observe(() => inbox.patch(id, { status: 'sent' }));
            return result;
        } catch (error) {
            await observe(() => inbox.patch(id, { status: 'uncertain', reason: 'delivery_unknown' }));
            throw error;
        }
    }

    async function flushApprovalOutbox() {
        for (const [id, payload] of Object.entries(journal.approvalOutbox)) {
            if (!personalJid(payload.recipient)) { delete journal.approvalOutbox[id]; await persist(); continue; }
            if (!agents.some(agent => agent.id === payload.agentId && agent.enabled)) continue;
            try {
                const response = await request(payload);
                const notice = journal.handoffs[id];
                const selfChecks = Object.values(journal.selfChecks).filter(check => check.externalId === id);
                const confirmed = typeof response?.approval?.id === 'string' && response.approval.id.trim() && response.approval.id.length <= 128
                    && ['pending', 'approved', 'dispatching', 'sent', 'failed', 'uncertain', 'rejected', 'expired'].includes(response.approval.status)
                    && (!selfChecks.length || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(response.approval.id));
                if (confirmed) {
                    for (const check of selfChecks) { check.approvalId = response.approval.id; check.approvalSaved = true; }
                    await patchIncoming(id, { status: 'awaiting_approval', approvalId: response.approval.id });
                    await patchIncoming(inboxId(`self-check-question:${id}`), { approvalId: response.approval.id });
                }
                if (notice?.status === 'waiting') {
                    if (confirmed && response.approval.status === 'pending') {
                        notice.approvalId = response.approval.id;
                        notice.status = 'pending';
                    } else notice.status = 'cancelled';
                }
                delete journal.approvalOutbox[id];
                await persist();
            } catch { break; }
        }
    }

    async function flushDeliveryOutbox() {
        for (const [id, payload] of Object.entries(journal.deliveryOutbox)) {
            try {
                // A resolved { ok: false } also finishes this receipt: the
                // server only changes dispatching rows, so it may already have
                // recorded a previous attempt whose response was lost.
                await request(payload);
                delete journal.deliveryOutbox[id];
                await persist();
            } catch { break; }
        }
    }

    async function acknowledgeDelivery(approvalId, status) {
        journal.deliveryOutbox[approvalId] = { action: 'delivered', approvalId, status };
        await persist();
        await flushDeliveryOutbox();
    }

    async function flushHandoffs() {
        for (const [externalId, notice] of Object.entries(journal.handoffs)) {
            if (notice.status !== 'pending') continue;
            if (!personalJid(notice.recipient) || notice.expiresAt <= now()) {
                notice.status = 'cancelled'; await persist(); continue;
            }
            const agent = activeAgent(), sendingSocket = socket;
            if (!agent || agent.id !== notice.agentId || !stillActive(agent, sendingSocket)) continue;
            const key = `${agent.id}:${notice.recipient}`;
            if (journal.handoffNotices[key] !== undefined && now() - journal.handoffNotices[key] < 5 * 60_000) {
                notice.status = 'suppressed'; await persist(); continue;
            }
            while (counts.length && now() - counts[0] > 3_600_000) counts.shift();
            if (counts.length >= 120) continue;
            const sending = (async () => {
                notice.status = 'sending';
                // Reserve the cooldown even if a lost response leaves the
                // outcome unknown; another question must not repeat the notice.
                journal.handoffNotices[key] = now();
                await persist();
                if (notice.status !== 'sending' || !stillActive(agent, sendingSocket)) {
                    if (notice.status === 'sending') notice.status = 'cancelled';
                    await persist(); return;
                }
                try {
                    await sendObserved(sendingSocket, notice.recipient, notice.text, { id: inboxId(`handoff:${externalId}`),
                        agentId: agent.id, externalId, approvalId: notice.approvalId, actor: 'system',
                        origin: selfCheckOrigin(externalId, notice.approvalId) });
                    notice.status = 'sent'; notice.sentAt = now(); counts.push(now());
                    remember(conversation(agent, notice.recipient), 'assistant', notice.text);
                    count('handoff.sent');
                } catch (error) { notice.status = error.whatsappNotAttempted ? 'cancelled' : 'uncertain'; count(`handoff.${notice.status}`); }
                await persist();
            })();
            handoffFlights.set(notice, sending);
            try { await sending; } finally { handoffFlights.delete(notice); }
        }
    }

    async function queueApproval(agent, message, draft, reason, externalId, { synthetic = false } = {}) {
        if (!personalJid(message.key?.remoteJid)) return;
        const chat = conversation(agent, message.key.remoteJid);
        chat.pendingImportant = { reason, externalId, expiresAt: now() + 24 * 3_600_000 };
        journal.approvalOutbox[externalId] = { action: 'approval', agentId: agent.id, recipient: message.key.remoteJid,
            original: String(whatsappMessageText(message.message) || '').slice(0, 8000),
            draft: String(draft || '').slice(0, 2500), reason, externalId };
        journal.handoffs[externalId] ||= { agentId: agent.id, recipient: message.key.remoteJid,
            text: approvalNotice(whatsappMessageText(message.message)), createdAt: now(), expiresAt: now() + 10 * 60_000, status: 'waiting' };
        if (!synthetic) journal.inbound[externalId] = 'approval';
        await persist();
        if (synthetic) {
            await observe(() => inbox.record({ id: inboxId(`self-check-question:${externalId}`), recipient: message.key.remoteJid,
                contactName: null, agentId: agent.id, direction: 'system', actor: 'system', kind: 'text',
                text: whatsappMessageText(message.message), status: 'awaiting_approval', occurredAt: new Date(now()).toISOString(),
                approvalId: null, replyToId: null, origin: 'self_check', reason }));
        } else await patchIncoming(externalId, { status: 'awaiting_approval', reason });
        await flushApprovalOutbox();
        await flushHandoffs();
    }

    async function generateDraft(agent, text, history) {
        let result;
        try {
            const greeting = explicitOwnerReply(text, agent) || simpleGreeting(text);
            result = greeting ? { draft: greeting, requiresApproval: false, reason: 'simple' }
                : await request({ action: 'generate_whatsapp', agentId: agent.id, text, history });
        } catch { result = { draft: '', requiresApproval: true, reason: 'model_unavailable' }; }
        if (!result?.draft?.trim() && (result?.provider === 'none'
            || ['model_unavailable', 'free_limit'].includes(result?.reason))) {
            // The zero-budget fallback sees only this chat and explicit owner
            // instructions. Self-checks call it with an empty history.
            try { count('model.localStarted'); result = await draftLocally({ agent, text, history }); }
            catch { count('model.localFailed'); }
        }
        const automatic = explicitOwnerReply(text, agent) || simpleGreeting(text);
        return { result, checked: assessDraft(text, result, { agent, trustedAutomatic: Boolean(automatic && result.draft === automatic) }) };
    }

    function ownPersonalRecipient(checkSocket) {
        const raw = String(checkSocket?.user?.id || '');
        if (!/^[0-9]{5,30}(?::[0-9]{1,10})?@(s\.whatsapp\.net|lid)$/u.test(raw)) throw new Error('Не удалось определить собственный чат WhatsApp.');
        const strict = raw.replace(/:[0-9]+@/u, '@');
        const normalized = normalizeOwnJid ? normalizeOwnJid(raw) : strict;
        if (normalized !== strict || !personalJid(normalized)) throw new Error('Не удалось проверить собственный чат WhatsApp.');
        return normalized;
    }

    function selfCheckResult(check, reused) {
        let message = check.ordinaryStatus === 'sent'
            ? 'Обычный ответ отправлен в ваш собственный чат WhatsApp.'
            : check.ordinaryStatus === 'uncertain'
                ? 'Исход обычной отправки неизвестен; сообщение не отправлялось повторно.'
                : 'Обычный ответ остановлен правилами агента и не был отправлен.';
        message += ' Тестовый вопрос сохранён на согласование. Входящее сообщение с другого номера и доставка на телефон этой проверкой не подтверждены.';
        if (reused) message = 'Использован результат недавней самопроверки. ' + message;
        return { selfCheck: { agentId: check.agentId, ordinaryStatus: check.ordinaryStatus,
            ...(['sent', 'uncertain'].includes(check.ordinaryStatus) && check.ordinaryAnswer ? { ordinaryAnswer: check.ordinaryAnswer } : {}),
            approvalId: check.approvalId, approvalSaved: check.approvalSaved === true,
            inboundVerified: false, phoneDeliveryVerified: false, ...(reused ? { reused: true } : {}) }, message };
    }

    async function performSelfCheck(check, agent, checkSocket) {
        if (!stillActive(agent, checkSocket)) throw new Error('Для самопроверки нужен включённый и подключённый WhatsApp-агент.');
        if (check.ordinaryStatus === 'pending') {
            const { result, checked } = await generateDraft(agent, 'Как работает Wi-Fi?', []);
            if (!result?.draft?.trim() && (result?.provider === 'none'
                || ['model_unavailable', 'free_limit'].includes(result?.reason))) throw new Error('AI-модель недоступна. Самопроверка будет повторена после восстановления связи.');
            if (!stillActive(agent, checkSocket)) throw new Error('Самопроверка приостановлена вместе с агентом.');
            if (checked.requiresApproval || !checked.draft) {
                check.ordinaryStatus = 'blocked';
                await persist();
            } else {
                while (counts.length && now() - counts[0] > 3_600_000) counts.shift();
                if (counts.length >= 120) throw new Error('Достигнут лимит автоматических сообщений. Самопроверка ожидает.');
                check.ordinaryAnswer = checked.draft;
                check.ordinaryStatus = 'sending';
                await persist();
                if (!stillActive(agent, checkSocket)) {
                    check.ordinaryStatus = 'pending'; await persist();
                    throw new Error('Самопроверка приостановлена вместе с агентом.');
                }
                try {
                    await sendObserved(checkSocket, check.recipient, `[Самопроверка SHAIKH]\n${checked.draft}`, {
                        id: inboxId(`self-check-answer:${check.externalId}`), agentId: agent.id, origin: 'self_check' });
                    check.ordinaryStatus = 'sent'; counts.push(now()); count('selfCheck.sent');
                } catch (error) { check.ordinaryStatus = error.whatsappNotAttempted ? 'pending' : 'uncertain'; count(`selfCheck.${check.ordinaryStatus}`); }
                await persist();
            }
        }
        if (!stillActive(agent, checkSocket)) throw new Error('Для сохранения тестового согласования восстановите подключение агента.');
        if (!check.approvalSaved || !check.approvalId) {
            const notice = journal.handoffs[check.externalId];
            if (notice?.status === 'cancelled' && !notice.approvalId) delete journal.handoffs[check.externalId];
            const importantText = '[Самопроверка SHAIKH] Давай созвонимся завтра в 15:00?';
            const reason = approvalReason(importantText);
            if (!reason) throw new Error('Правила агента не подтвердили необходимость согласования тестового вопроса.');
            await queueApproval(agent, { key: { remoteJid: check.recipient },
                message: { conversation: importantText } },
            'Это тест согласования. Встреча не назначена.', reason, check.externalId, { synthetic: true });
        } else await flushHandoffs();
        if (!check.approvalSaved || !check.approvalId) throw new Error('Тестовое согласование ожидает сохранения на платформе.');
        check.completedAt ||= now();
        await persist();
    }

    async function selfCheck(job, payload) {
        const allowed = new Set(['intent', 'agentId', 'replyPublicKey', 'requestId']);
        if (!payload || Object.keys(payload).some(key => !allowed.has(key))
            || typeof job.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(job.id)) throw new Error('Самопроверка использует только фиксированные сообщения и собственный чат.');
        const agent = activeAgent(), checkSocket = socket;
        if (!agent || payload.agentId !== agent.id || !stillActive(agent, checkSocket)) throw new Error('Для самопроверки нужен текущий включённый и подключённый WhatsApp-агент.');
        const recipient = ownPersonalRecipient(checkSocket);
        let checkId = job.id, reused = Object.hasOwn(journal.selfChecks, checkId);
        if (reused && journal.selfChecks[checkId].reusedFrom) checkId = journal.selfChecks[checkId].reusedFrom;
        if (!reused) {
            const recent = Object.entries(journal.selfChecks).filter(([, check]) => !check.reusedFrom
                && check.agentId === agent.id && check.recipient === recipient && Number.isFinite(check.createdAt)
                && now() - check.createdAt < 5 * 60_000).sort((a, b) => b[1].createdAt - a[1].createdAt)[0];
            if (recent) {
                checkId = recent[0]; reused = true;
                journal.selfChecks[job.id] = { reusedFrom: checkId, createdAt: now() };
            } else journal.selfChecks[checkId] = { agentId: agent.id, recipient, createdAt: now(), ordinaryStatus: 'pending',
                externalId: createHash('sha256').update(`shaikh-owner-self-check:${job.id}`).digest('hex'), approvalSaved: false };
        }
        const check = journal.selfChecks[checkId];
        if (!check || check.agentId !== agent.id || check.recipient !== recipient) throw new Error('Самопроверка принадлежит другому подключению.');
        const saved = persist();
        let flight = selfCheckFlights.get(checkId);
        if (!flight) {
            flight = (async () => { await saved; await performSelfCheck(check, agent, checkSocket); })();
            selfCheckFlights.set(checkId, flight);
        }
        try { await flight; return selfCheckResult(check, reused); }
        finally { if (selfCheckFlights.get(checkId) === flight) selfCheckFlights.delete(checkId); }
    }

    async function receive(message, admission) {
        // The admission snapshot is persisted before the slower model queue.
        // Its record survives even when the owner pauses while this work waits.
        if (admission.capture) await admission.capture.saved;
        const capturedId = admission.capture?.id;
        if (admission.capture?.duplicate) { count('ignored.duplicate'); return; }
        // Scoped capture admits only new human arrivals. Do not answer an old
        // phone import or control event that has no corresponding inbox source.
        // Legacy adapters without a pairing scope retain their existing gates.
        if (inboxDeviceId && !capturedId) { count('ignored.inboxSource'); return; }
        const agent = activeAgent();
        if (!agent || agent.id !== admission.agentId || socket !== admission.socket
            || !stillActive(agent, admission.socket)) { count('ignored.inactive'); await patchIncoming(capturedId, { status: 'skipped', reason: 'inactive' }); return; }
        if (message.key?.fromMe) { count('ignored.own'); return; }
        if (!personalJid(message.key?.remoteJid)) { count('ignored.nonPersonal'); return; }
        const receivingSocket = admission.socket;
        const text = whatsappMessageText(message.message);
        if (typeof text !== 'string' || !text.trim() || text.length > 8000) {
            count('ignored.unsupportedText'); await patchIncoming(capturedId, { status: 'skipped',
                reason: text?.length > 8000 || inbox.event(capturedId)?.reason === 'too_long' ? 'too_long' : 'unsupported_media' }); return;
        }
        if (!admission.fresh) { count('ignored.timestamp'); await patchIncoming(capturedId, { status: 'skipped', reason: 'stale' }); return; }
        const externalId = createHash('sha256').update(`${message.key.remoteJid}:${message.key.id}`).digest('hex');
        if (!message.key.id || journal.inbound[externalId]) { count('ignored.duplicate'); return; }
        await patchIncoming(capturedId, { status: 'processing' });
        count('received.personalText');
        const chat = conversation(agent, message.key.remoteJid);
        const last = chat.history.findLast(turn => turn.role === 'assistant');
        if (last?.role === 'assistant' && Object.values(journal.handoffs).some(item => item.agentId === agent.id
            && item.recipient === message.key.remoteJid && item.status === 'sent' && item.text === last.content)
            && /^(?:ок(?:ей)?|понял(?:а)?|спасибо|хорошо|ладно|рахмет|түсіндім|ok(?:ay)?|thanks|got it)[!.,\s]*$/iu.test(text.trim())) {
            remember(chat, 'user', text);
            journal.inbound[externalId] = 'acknowledged';
            await persist();
            await patchIncoming(capturedId, { status: 'skipped', reason: 'acknowledgement' });
            return;
        }
        const checkedContext = importantFollowup(text);
        if (checkedContext) await refreshImportant(agent, message.key.remoteJid, chat);
        const gate = approvalReason(text) || (chat.pendingImportant?.expiresAt > now() && importantFollowup(text) ? chat.pendingImportant.reason : null);
        const history = whatsappHistory(chat.history);
        count('decision.started');
        const { checked } = await generateDraft(agent, text, history);
        if (!checkedContext && importantFollowup('', checked.draft)) await refreshImportant(agent, message.key.remoteJid, chat);
        if (!stillActive(agent, receivingSocket)) { await patchIncoming(capturedId, { status: 'skipped', reason: 'inactive' }); return; }
        remember(chat, 'user', text);
        const importantContext = chat.pendingImportant?.expiresAt > now() && importantFollowup(text, checked.draft) ? chat.pendingImportant.reason : null;
        const reason = gate || importantContext || checked.reason;
        while (counts.length && now() - counts[0] > 3_600_000) counts.shift();
        if (gate || importantContext || checked.requiresApproval) {
            count('decision.approval');
            await queueApproval(agent, message, checked.draft, reason, externalId);
            return;
        }
        // A traffic limit must not turn ordinary conversation into requests
        // for permission. Bound automatic traffic without uploading a review.
        if (counts.length >= 120) {
            journal.inbound[externalId] = 'rate_limited';
            count('decision.rateLimited');
            await persist();
            await patchIncoming(capturedId, { status: 'skipped', reason: 'rate_limited' });
            return;
        }
        // Persist before the external send. An ambiguous interruption is not
        // retried automatically, preventing a second message after a restart.
        journal.inbound[externalId] = 'sending';
        await persist();
        if (!stillActive(agent, receivingSocket)) {
            journal.inbound[externalId] = 'cancelled';
            await persist();
            await patchIncoming(capturedId, { status: 'skipped', reason: 'inactive' });
            return;
        }
        try {
            await sendObserved(receivingSocket, message.key.remoteJid, checked.draft, { id: inboxId(`automatic:${externalId}`),
                agentId: agent.id, externalId });
            journal.inbound[externalId] = 'sent';
            count('send.sent');
            remember(chat, 'assistant', checked.draft);
            counts.push(now());
        } catch (error) { journal.inbound[externalId] = error.whatsappNotAttempted ? 'cancelled' : 'uncertain'; count(`send.${journal.inbound[externalId]}`); }
        await persist();
        await patchIncoming(capturedId, { status: journal.inbound[externalId] === 'cancelled' ? 'skipped' : 'answered',
            reason: journal.inbound[externalId] === 'cancelled' ? 'inactive' : journal.inbound[externalId] === 'uncertain' ? 'delivery_unknown' : null });
    }

    function scheduleReconnect(reason) {
        if (!connectionAllowed || intentional || !activeAgent() || reconnectTimer) return;
        const delay = reason === 515 ? Math.min(250, reconnectBaseMs)
            : Math.min(30000, reconnectBaseMs * 2 ** Math.min(reconnectAttempts++, 5));
        reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            if (!connectionAllowed || intentional || !activeAgent() || socket) return;
            void credentialSaves.catch(() => {}).then(() => connect()).catch(() => scheduleReconnect());
        }, delay);
        reconnectTimer.unref?.();
    }

    async function connect() {
        if (connecting) return connecting;
        if (!connectionAllowed || intentional) throw new Error('Подключение WhatsApp остановлено владельцем.');
        if (state === 'connected') return { message: 'WhatsApp подключён. Простые ответы активны, важные ждут согласования.' };
        if (!activeAgent()) throw new Error('Сначала включи одного WhatsApp-агента в кабинете.');
        if (socket && ['connecting', 'qr'].includes(state)) return qr ? { qr, message: 'Отсканируй QR через «Связанные устройства» в WhatsApp на телефоне.' } : { message: 'Соединение ещё устанавливается. Обнови QR через несколько секунд.' };
        connecting = (async () => {
            const deps = await loadDependencies();
            if (!connectionAllowed || intentional) throw new Error('Подключение WhatsApp остановлено владельцем.');
            // The bundled web version can expire independently of this pinned
            // package. Obtain the current public protocol version before pairing.
            let webVersion;
            try {
                const latest = await deps.fetchLatestWaWebVersion({ timeout: 10000 });
                if (!latest.isLatest || !Array.isArray(latest.version) || latest.version.length !== 3
                    || latest.version.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Unverified web version');
                webVersion = latest.version;
            } catch {
                if (!connectionAllowed || intentional) return { message: 'Ответы WhatsApp остановлены.' };
                state = 'disconnected';
                await runtime();
                return { message: 'Не удалось получить текущую версию WhatsApp Web. Повторю подключение автоматически, когда появится связь.' };
            }
            if (!connectionAllowed || intentional) throw new Error('Подключение WhatsApp остановлено владельцем.');
            const sessionDirectory = path.join(directory, 'session');
            await fs.mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
            await fs.chmod(sessionDirectory, 0o700);
            const auth = await deps.useMultiFileAuthState(sessionDirectory);
            if (!connectionAllowed || intentional) throw new Error('Подключение WhatsApp остановлено владельцем.');
            state = 'connecting';
            qr = null;
            const logger = whatsappDiagnosticLogger(deps.pino({ level: 'silent' }), kind => count(`library.error.${kind}`));
            const nextSocket = deps.default({ version: webVersion, auth: { creds: auth.state.creds, keys: deps.makeCacheableSignalKeyStore(auth.state.keys, logger) },
                logger, browser: deps.Browsers.macOS('SHAIKH'), markOnlineOnConnect: false,
                syncFullHistory: false, shouldSyncHistoryMessage: () => false,
                shouldIgnoreJid: jid => {
                    const ignored = ignoreWhatsAppTransportJid(jid);
                    count(ignored ? 'transport.nonPersonalBlocked' : 'transport.allowed');
                    return ignored;
                },
                getMessage: async () => undefined });
            socket = nextSocket;
            normalizeOwnJid = typeof deps.jidNormalizedUser === 'function' ? deps.jidNormalizedUser : undefined;
            nextSocket.ws?.on?.('CB:message', node => {
                if (socket !== nextSocket) return;
                const from = String(node?.attrs?.from || '');
                count(ignoreWhatsAppTransportJid(from) ? 'transport.nonPersonalFrame'
                    : /^[0-9].*@(?:s\.whatsapp\.net|lid)$/u.test(from) ? 'transport.personalFrame' : 'transport.controlFrame');
            });
            nextSocket.ev.on('creds.update', () => {
                credentialSaves = credentialSaves.catch(() => {}).then(async () => {
                    await auth.saveCreds();
                    // Baileys writes files itself; restrict all linked-device files.
                    for (const entry of await fs.readdir(sessionDirectory)) await fs.chmod(path.join(sessionDirectory, entry), 0o600).catch(() => {});
                });
                void credentialSaves.catch(() => {});
            });
            nextSocket.ev.on('connection.update', async update => {
                try {
                    if (socket !== nextSocket) return;
                    if ((!connectionAllowed || intentional) && update.connection !== 'close') return;
                    if (update.qr) {
                        state = 'qr';
                        qr = await deps.QRCode.toDataURL(update.qr, { width: 360, margin: 2 });
                        notify({ qr, message: 'Открой WhatsApp на телефоне → Связанные устройства и отсканируй QR. Код действует недолго; при необходимости обнови его.' });
                    }
                    if (update.connection === 'open') {
                        state = 'connected'; qr = null;
                        lastConnectionOpenAt = now();
                        reconnectAttempts = 0;
                        await rememberActive({ agentId });
                        if (socket !== nextSocket || !connectionAllowed || intentional) return;
                        notify({ message: 'WhatsApp подключён. Приложение и переписки на телефоне остаются доступны.' });
                    }
                    if (update.connection === 'close') {
                        lastConnectionOpenAt = null;
                        const reason = Number(update.lastDisconnect?.error?.output?.statusCode);
                        console.info(`[WhatsApp] Connection closed (code ${Number.isFinite(reason) ? reason : 0}).`);
                        socket = undefined;
                        state = intentional ? 'paused' : 'disconnected'; qr = null;
                        if (reason === 401 || reason === deps.DisconnectReason?.loggedOut) {
                            connectionAllowed = false;
                            await rememberActive({});
                            notify({ message: 'WhatsApp вышел из связанного устройства. Подключи его заново через QR в кабинете.' });
                        } else {
                            notify({ message: intentional ? 'Соединение WhatsApp остановлено.' : 'WhatsApp переподключается. При необходимости обнови QR в кабинете.' });
                            scheduleReconnect(reason);
                        }
                    }
                    await runtime();
                } catch { /* Never log session keys or contact content. */ }
            });
            nextSocket.ev.on('messages.upsert', update => {
                if (socket !== nextSocket) return;
                if (!['notify', 'append'].includes(update.type) || update.requestId !== undefined) { count('ignored.historyBatch'); return; }
                count(update.type === 'notify' ? 'upsert.notify' : 'upsert.append');
                for (const message of update.messages || []) {
                    const receivedAt = now();
                    const timestamp = Number(message?.messageTimestamp?.toString?.() || message?.messageTimestamp) * 1000;
                    // Freshness belongs to transport arrival, not the moment a
                    // slow earlier generation releases the processing queue.
                    // Bind queued work to this agent and socket as well: a
                    // reconnect or agent switch must not inherit old events.
                    const admission = { socket: nextSocket,
                        agentId: state === 'connected' && connectionAllowed && !intentional ? activeAgent()?.id : undefined,
                        fresh: Number.isFinite(timestamp) && receivedAt - timestamp <= 10 * 60_000 && timestamp <= receivedAt + 60_000 };
                    admission.capture = inbox.incoming(message, { timestamp, receivedAt, agentId: admission.agentId });
                    if (admission.capture) {
                        admission.capture.saved = admission.capture.saved.catch(() => { count('inbox.captureFailed'); });
                        void admission.capture.saved.then(() => inbox.flush());
                    }
                    chain = chain.then(() => receive(message, admission)).catch(() => { count('receive.failed'); });
                }
            });
            return new Promise(resolve => {
                const timer = setTimeout(() => {
                    waiters = waiters.filter(item => item !== done);
                    resolve({ message: 'WhatsApp подключается. Обнови QR через несколько секунд.' });
                }, 20_000);
                const done = value => { clearTimeout(timer); resolve(value); };
                waiters.push(done);
            });
        })();
        try { return await connecting; }
        finally {
            connecting = null;
            // A failed protocol check returns a helpful result rather than
            // throwing. It must still re-arm retries after a network outage.
            if (state === 'disconnected' && !socket) scheduleReconnect();
        }
    }

    async function pause({ remember = true } = {}) {
        intentional = true;
        connectionAllowed = false;
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
        state = 'paused'; qr = null;
        lastConnectionOpenAt = null;
        socket?.end?.(new Error('Owner paused the delegate'));
        socket = undefined;
        if (!remember) await rememberActive({});
        notify({ message: 'Ответы WhatsApp остановлены.' });
    }

    return {
        get status() { return state; },
        idle: () => chain,
        async handleJob(job, payload = {}) {
            if (job.kind === 'whatsapp_disconnect') { await pause({ remember: false }); await runtime(); return { message: 'WhatsApp-агент приостановлен. Приложение на телефоне продолжает работать.' }; }
            if (job.kind !== 'whatsapp_connect') throw new Error('Неизвестная команда WhatsApp.');
            if (payload.intent === 'whatsapp_self_check') return selfCheck(job, payload);
            const enabled = agents.filter(agent => agent.type === 'whatsapp' && agent.enabled);
            if (enabled.length !== 1) return { message: 'Для одного личного номера включи ровно одного WhatsApp-агента.' };
            agentId = enabled[0].id;
            connectionAllowed = true;
            intentional = false;
            if (qr) return { qr, message: 'Отсканируй QR через «Связанные устройства» в WhatsApp на телефоне.' };
            return connect();
        },
        async onPoll(response) {
            agents = response.agents || [];
            if (connectionAllowed && !activeAgent()) { await pause(); await runtime(); }
            if (!startupChecked) {
                startupChecked = true;
                if (saved.agentId && activeAgent()) {
                    connectionAllowed = true;
                    void connect().catch(() => scheduleReconnect());
                }
            }
            if (state === 'disconnected' && !socket && !connecting) scheduleReconnect();
            // History sync is disabled, but late offline deliveries can re-open
            // Baileys' event buffer after its initial flush. Release it only on
            // the active, open connection after startup; receive() still checks
            // personal recipients, freshness, own messages and duplicates.
            if (state === 'connected' && socket?.ws?.isOpen === true && lastConnectionOpenAt !== null
                && now() - lastConnectionOpenAt >= 5000 && socket.ev.isBuffering?.() === true) {
                try { socket.ev.flush(); count('buffer.recovered'); }
                catch { count('buffer.flushFailed'); }
            }
            await flushDeliveryOutbox();
            await flushApprovalOutbox();
            for (const decision of response.decisions || []) {
                let handoffChanged = false;
                for (const notice of Object.values(journal.handoffs)) {
                    if (notice.approvalId === decision.id || (decision.external_id && notice.agentId === decision.agent_id
                        && notice.recipient === decision.recipient && journal.handoffs[decision.external_id] === notice)) {
                        if (['waiting', 'pending', 'sending'].includes(notice.status)) { notice.status = 'cancelled'; handoffChanged = true; }
                        // Finish an already-started notice before sending the
                        // owner's approved reply; never put a notice after it.
                        if (handoffFlights.has(notice)) await handoffFlights.get(notice);
                    }
                }
                if (handoffChanged) await persist();
                if (!personalJid(decision.recipient) || !decision.draft?.trim() || !activeAgent()
                    || (decision.agent_id && decision.agent_id !== agentId) || state !== 'connected') {
                    journal.approvals[decision.id] ||= 'cancelled';
                    await acknowledgeDelivery(decision.id, journal.approvals[decision.id] === 'sent' ? 'sent'
                        : ['uncertain', 'sending'].includes(journal.approvals[decision.id]) ? 'uncertain' : 'failed');
                    continue;
                }
                const previous = journal.approvals[decision.id];
                if (previous) {
                    await acknowledgeDelivery(decision.id, previous === 'sent' ? 'sent'
                        : ['failed', 'cancelled'].includes(previous) ? 'failed' : 'uncertain');
                    continue;
                }
                journal.approvals[decision.id] = 'sending';
                await persist();
                const sendingAgent = activeAgent();
                const sendingSocket = socket;
                if (!sendingAgent || !stillActive(sendingAgent, sendingSocket)
                    || (decision.agent_id && decision.agent_id !== sendingAgent.id)) {
                    journal.approvals[decision.id] = 'cancelled';
                    await acknowledgeDelivery(decision.id, 'failed');
                    continue;
                }
                let delivered = 'sent';
                try { await sendObserved(sendingSocket, decision.recipient, decision.draft, { id: inboxId(`approved:${decision.id}`),
                    agentId: sendingAgent.id, externalId: decision.external_id, approvalId: decision.id,
                    origin: selfCheckOrigin(decision.external_id, decision.id) }); }
                catch (error) { delivered = error.whatsappNotAttempted ? 'failed' : 'uncertain'; }
                if (delivered === 'sent') {
                    const chat = conversation(sendingAgent, decision.recipient);
                    remember(chat, 'assistant', decision.draft);
                    // Do not turn a later short acknowledgment into consent to
                    // some other still-pending important request in this chat.
                    if (decision.external_id && chat.pendingImportant?.externalId === decision.external_id) delete chat.pendingImportant;
                }
                journal.approvals[decision.id] = delivered;
                if (decision.external_id) await patchIncoming(decision.external_id, { status: delivered === 'failed' ? 'skipped' : 'answered', approvalId: decision.id,
                    reason: delivered === 'failed' ? 'inactive' : delivered === 'uncertain' ? 'delivery_unknown' : null });
                if (selfCheckOrigin(decision.external_id, decision.id) === 'self_check') {
                    const check = Object.values(journal.selfChecks).find(item => item.approvalId === decision.id);
                    if (check) await patchIncoming(inboxId(`self-check-question:${check.externalId}`), { status: delivered === 'failed' ? 'failed' : 'answered' });
                }
                await acknowledgeDelivery(decision.id, delivered);
            }
            await flushHandoffs();
            void inbox.flush();
            // Counts and stages only: no addresses, message IDs, text or keys.
            diagnostics.transportOpen = typeof socket?.ws?.isOpen === 'boolean' ? socket.ws.isOpen : null;
            diagnostics.eventsBuffered = typeof socket?.ev?.isBuffering === 'function' ? socket.ev.isBuffering() === true : null;
            await writePrivateJSON(diagnosticPath, diagnostics);
        },
        async stop() {
            await pause();
            await chain;
            await Promise.allSettled([...selfCheckFlights.values()]);
            await Promise.allSettled([...handoffFlights.values()]);
            await Promise.allSettled([credentialSaves, activeWrites, journalWrites]);
            await inbox.stop();
            await writePrivateJSON(diagnosticPath, diagnostics);
        }
    };
}
