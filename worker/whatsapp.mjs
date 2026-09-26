import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import makeWASocket, { Browsers, DisconnectReason, fetchLatestWaWebVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { LocalSalesAgent } from './local-sales.mjs';

const baseUrl = String(process.env.BRIDGE_BASE_URL || '').replace(/\/+$/, '');
const secret = process.env.WHATSAPP_BRIDGE_SECRET || '';
const sessionDir = resolve(process.env.WHATSAPP_SESSION_DIR || '.wa-session');
const localAgent = process.env.LOCAL_AGENT_WEBHOOK_URL
    ? new LocalSalesAgent({
        sessionDir,
        webhookUrl: process.env.LOCAL_AGENT_WEBHOOK_URL,
        model: process.env.LOCAL_AGENT_MODEL || 'qwen3.5:9b-mlx'
    })
    : null;

if (!baseUrl.startsWith('https://') || secret.length < 32) {
    throw new Error('BRIDGE_BASE_URL (HTTPS) and WHATSAPP_BRIDGE_SECRET (32+ chars) are required');
}

async function bridge(payload) {
    const response = await fetch(`${baseUrl}/api/whatsapp/bridge`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-whatsapp-bridge-secret': secret
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Bridge HTTP ${response.status}: ${data.error || 'request failed'}`);
    return data;
}

const bootstrap = await bridge({ action: 'bootstrap', agentId: process.env.BRIDGE_AGENT_ID || undefined });
const agentId = bootstrap.agentId;
await mkdir(sessionDir, { recursive: true, mode: 0o700 });
console.log(`WhatsApp Sales Agent: ${bootstrap.name || agentId}`);
console.log(`Session stored locally in ${sessionDir}; keep this directory private and backed up.`);

let socket;
let connected = false;
let state = 'connecting';
let qrImage = null;
let lastError = null;
let polling = false;
let reconnectTimer;
let stopping = false;

function scheduleReconnect(error) {
    if (stopping) return;
    if (error) console.error('WhatsApp connection failed:', error.message);
    if (state === 'logged_out') return;
    connected = false;
    qrImage = null;
    state = 'offline';
    lastError = error?.message || lastError;
    reportStatus();
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connect().catch(scheduleReconnect), 5000);
}

async function reportStatus() {
    try {
        await bridge({ action: 'status', agentId, state, qrImage, error: lastError });
    } catch (error) {
        console.error('Could not publish WhatsApp status:', error.message);
    }
}

async function pollOutbox() {
    if (localAgent) return;
    if (!connected || polling) return;
    polling = true;
    try {
        const { jobs = [] } = await bridge({ action: 'poll', agentId });
        for (const job of jobs) {
            let sent;
            try {
                sent = await socket.sendMessage(job.recipientId, { text: job.text });
            } catch (error) {
                console.error(`WhatsApp send failed for job ${job.id}:`, error.message);
                try {
                    await bridge({ action: 'ack', agentId, id: job.id, sent: false, error: error.message });
                } catch (ackError) {
                    console.error('Could not record failed send:', ackError.message);
                }
                continue;
            }
            try {
                await bridge({
                    action: 'ack', agentId, id: job.id, sent: true,
                    messageId: sent?.key?.id || null
                });
            } catch (error) {
                // The message may already have reached WhatsApp. Never auto-retry it.
                console.error(`WhatsApp sent job ${job.id}, but acknowledgement failed. Review manually:`, error.message);
            }
        }
    } catch (error) {
        console.error('Could not load WhatsApp outbox:', error.message);
    } finally {
        polling = false;
    }
}

function inboundText(message) {
    const content = message.message?.ephemeralMessage?.message || message.message;
    return content?.conversation || content?.extendedTextMessage?.text || '';
}

async function connect() {
    state = 'connecting';
    connected = false;
    qrImage = null;
    await reportStatus();
    const { state: auth, saveCreds } = await useMultiFileAuthState(sessionDir);
    const latest = await fetchLatestWaWebVersion({ timeout: 10000 });
    if (!latest.isLatest) throw new Error(`Could not get current WhatsApp Web version: ${latest.error?.message || 'unknown error'}`);
    const next = makeWASocket({
        version: latest.version,
        auth,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('SHAIKH Sales Agent'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        printQRInTerminal: false
    });
    socket = next;
    console.log('WhatsApp socket initialised; waiting for QR or connection.');
    next.ev.on('creds.update', saveCreds);
    next.ev.on('connection.update', async update => {
        if (next !== socket) return;
        if (update.connection || update.qr) {
            console.log(`WhatsApp connection update: ${update.connection || 'pending'}${update.qr ? ' (QR received)' : ''}`);
        }
        if (update.qr) {
            qrImage = await QRCode.toDataURL(update.qr, { margin: 2, width: 320 });
            state = 'qr';
            lastError = null;
            await reportStatus();
            console.log('Scan the QR on the protected Sales Agent dashboard with WhatsApp Business → Linked devices.');
        }
        if (update.connection === 'open') {
            connected = true;
            state = 'connected';
            qrImage = null;
            lastError = null;
            await reportStatus();
            console.log(localAgent
                ? 'WhatsApp connected. Local n8n replies require training, AI ON, and the local enable switch.'
                : 'WhatsApp connected. Customer replies also require the separate server-side delivery switch.');
        }
        if (update.connection === 'close') {
            connected = false;
            qrImage = null;
            const disconnectError = update.lastDisconnect?.error;
            const reason = disconnectError?.output?.statusCode;
            state = reason === DisconnectReason.loggedOut ? 'logged_out' : 'offline';
            lastError = state === 'logged_out'
                ? 'WhatsApp logged out; a new QR pairing is required.'
                : String(disconnectError?.message || 'WhatsApp connection closed').slice(0, 500);
            console.error(`WhatsApp connection closed (${reason || 'unknown'}): ${lastError}`);
            await reportStatus();
            if (state === 'logged_out') {
                console.error(lastError, 'Back up and remove the old session directory manually before restarting.');
                return;
            }
            scheduleReconnect();
        }
    });
    next.ev.on('messages.upsert', async event => {
        if (next !== socket || event.type !== 'notify') return;
        for (const message of event.messages || []) {
            const from = message.key?.remoteJid || '';
            const text = inboundText(message).trim();
            if (message.key?.fromMe || !/^\d{6,20}@(s\.whatsapp\.net|lid)$/.test(from) || !text || !message.key?.id) continue;
            try {
                if (localAgent) {
                    if (!await localAgent.isEnabled()) continue;
                    const context = await bridge({ action: 'local_context', agentId });
                    await localAgent.reply({
                        externalId: from,
                        messageId: message.key.id,
                        text,
                        context,
                        sendMessage: (recipient, content) => next.sendMessage(recipient, content)
                    });
                    continue;
                }
                await bridge({
                    action: 'inbound', agentId, from,
                    text: text.slice(0, 4000),
                    messageId: message.key.id,
                    name: message.pushName || ''
                });
                await pollOutbox();
            } catch (error) {
                console.error('Sales Agent could not process inbound message:', error.message);
            }
        }
    });
}

setInterval(reportStatus, 15000);
setInterval(pollOutbox, 3000);
process.once('SIGTERM', async () => {
    stopping = true;
    clearTimeout(reconnectTimer);
    connected = false;
    qrImage = null;
    state = 'offline';
    await reportStatus();
    process.exit(0);
});
connect().catch(scheduleReconnect);
