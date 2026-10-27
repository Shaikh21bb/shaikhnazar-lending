import '../worker/safe-logging.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { approvalReason, assessDraft, explicitOwnerReply, simpleGreeting } from '../lib/whatsapp-policy.mjs';
import { readPrivateJSON, writePrivateJSON } from './runtime.mjs';

const requireWorker = createRequire(new URL('../worker/package.json', import.meta.url));
const personalJid = value => /^(?:[0-9]{5,20}@s\.whatsapp\.net|[0-9]{5,30}@lid)$/.test(String(value));

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
export async function createWhatsAppAdapter({ request, stateDirectory, loadDependencies = dependencies, now = () => Date.now(), reconnectBaseMs = 1000 }) {
    const directory = path.join(stateDirectory, 'whatsapp');
    const journalPath = path.join(directory, 'delivery.json');
    const activePath = path.join(directory, 'active.json');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const journal = await readPrivateJSON(journalPath, { inbound: {}, approvals: {} });
    journal.approvalOutbox ||= {};
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
    const counts = [];
    const persist = () => {
        journalWrites = journalWrites.catch(() => {}).then(() => writePrivateJSON(journalPath, journal));
        return journalWrites;
    };
    const activeAgent = () => {
        const enabled = agents.filter(agent => agent.type === 'whatsapp' && agent.enabled);
        return enabled.length === 1 && enabled[0].id === agentId ? enabled[0] : undefined;
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
            if (!agents.some(agent => agent.id === payload.agentId && agent.enabled)) continue;
            try {
                await request(payload);
                delete journal.approvalOutbox[id];
                await persist();
            } catch { break; }
        }
    }

    async function queueApproval(agent, message, draft, reason, externalId) {
        journal.approvalOutbox[externalId] = { action: 'approval', agentId: agent.id, recipient: message.key.remoteJid,
            original: String(message.message.conversation || message.message.extendedTextMessage?.text || '').slice(0, 8000),
            draft: String(draft || '').slice(0, 2500), reason, externalId };
        journal.inbound[externalId] = 'approval';
        await persist();
        await flushApprovalOutbox();
    }

    async function receive(message) {
        const agent = activeAgent();
        if (!agent || !socket || state !== 'connected' || message.key?.fromMe || !personalJid(message.key?.remoteJid)) return;
        const receivingSocket = socket;
        const text = message.message?.conversation || message.message?.extendedTextMessage?.text;
        if (typeof text !== 'string' || !text.trim() || text.length > 8000) return;
        const timestamp = Number(message.messageTimestamp?.toString?.() || message.messageTimestamp) * 1000;
        // Never answer a bulk history synchronization or stale phone backlog.
        if (!Number.isFinite(timestamp) || now() - timestamp > 10 * 60_000 || timestamp > now() + 60_000) return;
        const externalId = createHash('sha256').update(`${message.key.remoteJid}:${message.key.id}`).digest('hex');
        if (!message.key.id || journal.inbound[externalId]) return;
        const gate = approvalReason(text);
        let result;
        try {
            const greeting = explicitOwnerReply(text, agent) || simpleGreeting(text);
            result = greeting ? { draft: greeting, requiresApproval: false, reason: 'simple' }
                : await request({ action: 'generate_whatsapp', agentId: agent.id, text });
        } catch { result = { draft: '', requiresApproval: true, reason: 'model_unavailable' }; }
        // A model or a server response cannot override deterministic boundaries.
        const automatic = explicitOwnerReply(text, agent) || simpleGreeting(text);
        const checked = assessDraft(text, result, { trustedAutomatic: Boolean(automatic && result.draft === automatic) });
        if (!stillActive(agent, receivingSocket)) return;
        const reason = gate || checked.reason;
        while (counts.length && now() - counts[0] > 3_600_000) counts.shift();
        if (gate || checked.requiresApproval || counts.length >= 30) {
            await queueApproval(agent, message, checked.draft, counts.length >= 30 ? 'rate_limit' : reason, externalId);
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
            counts.push(now());
        } catch { journal.inbound[externalId] = 'uncertain'; }
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
            const sessionDirectory = path.join(directory, 'session');
            await fs.mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
            await fs.chmod(sessionDirectory, 0o700);
            const auth = await deps.useMultiFileAuthState(sessionDirectory);
            if (!connectionAllowed || intentional) throw new Error('Подключение WhatsApp остановлено владельцем.');
            state = 'connecting';
            qr = null;
            const logger = deps.pino({ level: 'silent' });
            const nextSocket = deps.default({ auth: { creds: auth.state.creds, keys: deps.makeCacheableSignalKeyStore(auth.state.keys, logger) },
                logger, browser: deps.Browsers.macOS('SHAIKH'), markOnlineOnConnect: false,
                syncFullHistory: false, shouldSyncHistoryMessage: () => false,
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
                        await writePrivateJSON(activePath, { agentId });
                        notify({ message: 'WhatsApp подключён. Приложение и переписки на телефоне остаются доступны.' });
                    }
                    if (update.connection === 'close') {
                        const reason = Number(update.lastDisconnect?.error?.output?.statusCode);
                        socket = undefined;
                        state = intentional ? 'paused' : 'disconnected'; qr = null;
                        if (reason === 401 || reason === deps.DisconnectReason?.loggedOut) {
                            connectionAllowed = false;
                            await writePrivateJSON(activePath, {});
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
                if (update.type !== 'notify') return;
                for (const message of update.messages || []) {
                    chain = chain.then(() => receive(message)).catch(() => {});
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
        finally { connecting = null; }
    }

    async function pause({ remember = true } = {}) {
        intentional = true;
        connectionAllowed = false;
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
        state = 'paused'; qr = null;
        socket?.end?.(new Error('Owner paused the delegate'));
        socket = undefined;
        if (!remember) await writePrivateJSON(activePath, {});
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
            if (state === 'connected' && !activeAgent()) { await pause(); await runtime(); }
            if (!startupChecked) {
                startupChecked = true;
                if (saved.agentId && activeAgent()) {
                    connectionAllowed = true;
                    void connect().catch(() => scheduleReconnect());
                }
            }
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
                journal.approvals[decision.id] = delivered;
                await persist();
                await request({ action: 'delivered', approvalId: decision.id, status: delivered });
            }
        },
        async stop() { await pause(); await chain; }
    };
}
