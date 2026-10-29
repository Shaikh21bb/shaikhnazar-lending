import '../worker/safe-logging.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { approvalReason, assessDraft, explicitOwnerReply, simpleGreeting, personalWhatsAppJid as personalJid, importantFollowup, whatsappHistory } from '../lib/whatsapp-policy.mjs';
import { readPrivateJSON, writePrivateJSON } from './runtime.mjs';
import { LocalWhatsAppModel } from './whatsapp-model.mjs';
import { ignoreWhatsAppTransportJid, whatsappMessageText } from './whatsapp-message.mjs';

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
    const journal = await readPrivateJSON(journalPath, { inbound: {}, approvals: {} });
    journal.approvalOutbox ||= {};
    journal.conversations ||= {};
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
    let waiters = [];
    let chain = Promise.resolve();
    let journalWrites = Promise.resolve();
    let activeWrites = Promise.resolve();
    const counts = [];
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
    const runtime = async () => { await request({ action: 'runtime', status: { state: 'ready', whatsapp: state } }).catch(() => {}); };
    const stillActive = (agent, expectedSocket) => {
        const current = activeAgent();
        return connectionAllowed && !intentional && state === 'connected' && socket === expectedSocket
            && current?.id === agent.id && current.rules === agent.rules && current.examples === agent.examples;
    };

    async function flushApprovalOutbox() {
        for (const [id, payload] of Object.entries(journal.approvalOutbox)) {
            if (!personalJid(payload.recipient)) { delete journal.approvalOutbox[id]; await persist(); continue; }
            if (!agents.some(agent => agent.id === payload.agentId && agent.enabled)) continue;
            try {
                await request(payload);
                delete journal.approvalOutbox[id];
                await persist();
            } catch { break; }
        }
    }

    async function queueApproval(agent, message, draft, reason, externalId) {
        if (!personalJid(message.key?.remoteJid)) return;
        const chat = conversation(agent, message.key.remoteJid);
        chat.pendingImportant = { reason, externalId, expiresAt: now() + 24 * 3_600_000 };
        journal.approvalOutbox[externalId] = { action: 'approval', agentId: agent.id, recipient: message.key.remoteJid,
            original: String(whatsappMessageText(message.message) || '').slice(0, 8000),
            draft: String(draft || '').slice(0, 2500), reason, externalId };
        journal.inbound[externalId] = 'approval';
        await persist();
        await flushApprovalOutbox();
    }

    async function receive(message) {
        const agent = activeAgent();
        if (!agent || !socket || state !== 'connected') { count('ignored.inactive'); return; }
        if (message.key?.fromMe) { count('ignored.own'); return; }
        if (!personalJid(message.key?.remoteJid)) { count('ignored.nonPersonal'); return; }
        const receivingSocket = socket;
        const text = whatsappMessageText(message.message);
        if (typeof text !== 'string' || !text.trim() || text.length > 8000) { count('ignored.unsupportedText'); return; }
        const timestamp = Number(message.messageTimestamp?.toString?.() || message.messageTimestamp) * 1000;
        // Never answer a bulk history synchronization or stale phone backlog.
        if (!Number.isFinite(timestamp) || now() - timestamp > 10 * 60_000 || timestamp > now() + 60_000) { count('ignored.timestamp'); return; }
        const externalId = createHash('sha256').update(`${message.key.remoteJid}:${message.key.id}`).digest('hex');
        if (!message.key.id || journal.inbound[externalId]) { count('ignored.duplicate'); return; }
        count('received.personalText');
        const chat = conversation(agent, message.key.remoteJid);
        const checkedContext = importantFollowup(text);
        if (checkedContext) await refreshImportant(agent, message.key.remoteJid, chat);
        const gate = approvalReason(text) || (chat.pendingImportant?.expiresAt > now() && importantFollowup(text) ? chat.pendingImportant.reason : null);
        const history = whatsappHistory(chat.history);
        let result;
        count('decision.started');
        try {
            const greeting = explicitOwnerReply(text, agent) || simpleGreeting(text);
            result = greeting ? { draft: greeting, requiresApproval: false, reason: 'simple' }
                : await request({ action: 'generate_whatsapp', agentId: agent.id, text, history });
        } catch { result = { draft: '', requiresApproval: true, reason: 'model_unavailable' }; }
        if (!result?.draft?.trim() && (result?.provider === 'none'
            || ['model_unavailable', 'free_limit'].includes(result?.reason))) {
            // Budget remains zero when no cloud key/quota is available. The
            // separate local model sees no Obsidian or imported phone history.
            try { count('model.localStarted'); result = await draftLocally({ agent, text, history }); }
            catch { count('model.localFailed'); /* Keep an editable review item if local AI is offline. */ }
        }
        // A model or a server response cannot override deterministic boundaries.
        const automatic = explicitOwnerReply(text, agent) || simpleGreeting(text);
        const checked = assessDraft(text, result, { agent, trustedAutomatic: Boolean(automatic && result.draft === automatic) });
        if (!checkedContext && importantFollowup('', checked.draft)) await refreshImportant(agent, message.key.remoteJid, chat);
        if (!stillActive(agent, receivingSocket)) return;
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
            return;
        }
        // Persist before the external send. An ambiguous interruption is not
        // retried automatically, preventing a second message after a restart.
        journal.inbound[externalId] = 'sending';
        await persist();
        if (!stillActive(agent, receivingSocket)) {
            journal.inbound[externalId] = 'cancelled';
            await persist();
            return;
        }
        try {
            await receivingSocket.sendMessage(message.key.remoteJid, { text: checked.draft });
            journal.inbound[externalId] = 'sent';
            count('send.sent');
            remember(chat, 'assistant', checked.draft);
            counts.push(now());
        } catch { journal.inbound[externalId] = 'uncertain'; count('send.uncertain'); }
        await persist();
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
            const logger = deps.pino({ level: 'silent' });
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
                        reconnectAttempts = 0;
                        await rememberActive({ agentId });
                        if (socket !== nextSocket || !connectionAllowed || intentional) return;
                        notify({ message: 'WhatsApp подключён. Приложение и переписки на телефоне остаются доступны.' });
                    }
                    if (update.connection === 'close') {
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
                if (!['notify', 'append'].includes(update.type) || update.requestId) { count('ignored.historyBatch'); return; }
                count(update.type === 'notify' ? 'upsert.notify' : 'upsert.append');
                for (const message of update.messages || []) {
                    chain = chain.then(() => receive(message)).catch(() => { count('receive.failed'); });
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
        socket?.end?.(new Error('Owner paused the delegate'));
        socket = undefined;
        if (!remember) await rememberActive({});
        notify({ message: 'Ответы WhatsApp остановлены.' });
    }

    return {
        get status() { return state; },
        idle: () => chain,
        async handleJob(job) {
            if (job.kind === 'whatsapp_disconnect') { await pause({ remember: false }); await runtime(); return { message: 'WhatsApp-агент приостановлен. Приложение на телефоне продолжает работать.' }; }
            if (job.kind !== 'whatsapp_connect') throw new Error('Неизвестная команда WhatsApp.');
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
            await flushApprovalOutbox();
            for (const decision of response.decisions || []) {
                if (!personalJid(decision.recipient) || !decision.draft?.trim() || !activeAgent()
                    || (decision.agent_id && decision.agent_id !== agentId) || state !== 'connected') {
                    await request({ action: 'delivered', approvalId: decision.id, status: 'failed' });
                    continue;
                }
                const previous = journal.approvals[decision.id];
                if (previous) {
                    await request({ action: 'delivered', approvalId: decision.id, status: previous === 'sent' ? 'sent' : 'uncertain' });
                    continue;
                }
                journal.approvals[decision.id] = 'sending';
                await persist();
                const sendingAgent = activeAgent();
                const sendingSocket = socket;
                if (!sendingAgent || !stillActive(sendingAgent, sendingSocket)
                    || (decision.agent_id && decision.agent_id !== sendingAgent.id)) {
                    journal.approvals[decision.id] = 'cancelled';
                    await persist();
                    await request({ action: 'delivered', approvalId: decision.id, status: 'failed' });
                    continue;
                }
                let delivered = 'sent';
                try { await sendingSocket.sendMessage(decision.recipient, { text: decision.draft }); }
                catch { delivered = 'uncertain'; }
                if (delivered === 'sent') {
                    const chat = conversation(sendingAgent, decision.recipient);
                    remember(chat, 'assistant', decision.draft);
                    // Do not turn a later short acknowledgment into consent to
                    // some other still-pending important request in this chat.
                    if (decision.external_id && chat.pendingImportant?.externalId === decision.external_id) delete chat.pendingImportant;
                }
                journal.approvals[decision.id] = delivered;
                await persist();
                await request({ action: 'delivered', approvalId: decision.id, status: delivered });
            }
            // Counts and stages only: no addresses, message IDs, text or keys.
            await writePrivateJSON(diagnosticPath, diagnostics);
        },
        async stop() {
            await pause();
            await chain;
            await Promise.allSettled([credentialSaves, activeWrites, journalWrites]);
            await writePrivateJSON(diagnosticPath, diagnostics);
        }
    };
}
