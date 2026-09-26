import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import makeWASocket, { Browsers, DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

const baseUrl = String(process.env.BRIDGE_BASE_URL || '').replace(/\/+$/, '');
const secret = process.env.WHATSAPP_BRIDGE_SECRET || '';
const sessionDir = resolve(process.env.WHATSAPP_SESSION_DIR || '.wa-session');

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

const bootstrap = await bridge({ action: 'bootstrap' });
const agentId = process.env.BRIDGE_AGENT_ID || bootstrap.agentId;
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

async function reportStatus() {
    try {
        await bridge({ action: 'status', agentId, state, qrImage, error: lastError });
    } catch (error) {
        console.error('Could not publish WhatsApp status:', error.message);
    }
}

async function pollOutbox() {
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
    const next = makeWASocket({
        auth,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('SHAIKH Sales Agent'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        printQRInTerminal: false
    });
    socket = next;
    next.ev.on('creds.update', saveCreds);
    next.ev.on('connection.update', async update => {
        if (next !== socket) return;
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
            console.log('WhatsApp connected. AI replies follow the dashboard AI ON/OFF setting.');
        }
        if (update.connection === 'close') {
            connected = false;
            qrImage = null;
            const reason = update.lastDisconnect?.error?.output?.statusCode;
            state = reason === DisconnectReason.loggedOut ? 'logged_out' : 'offline';
            lastError = state === 'logged_out' ? 'WhatsApp logged out; a new QR pairing is required.' : null;
            await reportStatus();
            if (state === 'logged_out') {
                console.error(lastError, 'Back up and remove the old session directory manually before restarting.');
                return;
            }
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => connect().catch(error => console.error('Reconnect failed:', error.message)), 5000);
        }
    });
    next.ev.on('messages.upsert', async event => {
        if (next !== socket || event.type !== 'notify') return;
        for (const message of event.messages || []) {
            const from = message.key?.remoteJid || '';
            const text = inboundText(message).trim();
            if (message.key?.fromMe || !/^\d{6,20}@(s\.whatsapp\.net|lid)$/.test(from) || !text || !message.key?.id) continue;
            try {
                await bridge({
                    action: 'inbound', agentId, from,
                    text: text.slice(0, 4000),
                    messageId: message.key.id,
                    name: message.pushName || ''
                });
                await pollOutbox();
            } catch (error) {
                console.error('Inbound message could not reach Sales Agent:', error.message);
            }
        }
    });
}

setInterval(reportStatus, 15000);
setInterval(pollOutbox, 3000);
connect().catch(error => {
    console.error('WhatsApp bridge failed to start:', error.message);
    process.exitCode = 1;
});
