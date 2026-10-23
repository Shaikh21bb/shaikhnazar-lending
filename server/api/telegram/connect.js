import { randomUUID } from 'node:crypto';
import { db, telegram, readJsonBody } from '../_lib.js';
import { requireLegacyDashboardSession, requireSameOrigin } from '../_auth.js';
import { telegramWebhookSecretHash } from '../_agent/personal.js';

const encoded = value => encodeURIComponent(String(value));

function publicWebhookUrl(req) {
    const configured = String(process.env.PUBLIC_SITE_URL || '').trim();
    if (configured) return `${new URL(configured).origin}/api/telegram`;
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (!host) throw Object.assign(new Error('Public site address is unavailable.'), { status: 503 });
    return `${proto}://${host}/api/telegram`;
}

async function releaseReservation(agentId, nonce) {
    return db(
        `agents?id=eq.${encoded(agentId)}&connected=eq.false&telegram_connection_nonce=eq.${encoded(nonce)}`,
        {
            method: 'PATCH',
            body: JSON.stringify({
                telegram_bot_id: null,
                webhook_secret_hash: null,
                webhook_secret: null,
                telegram_connection_nonce: null,
                telegram_connection_expires_at: null
            })
        }
    );
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!await requireLegacyDashboardSession(req, res)) return;
    if (!requireSameOrigin(req, res)) return;

    try {
        const { id, action } = await readJsonBody(req);
        if (!id) return res.status(400).json({ error: 'Missing agent id' });

        const lookup = await db(
            `agents?select=id,token,name,platform,connected,telegram_bot_id,telegram_connection_nonce,telegram_connection_expires_at&id=eq.${encoded(id)}&limit=1`
        );
        const agent = lookup.body?.[0];
        if (!lookup.res.ok || !agent) return res.status(404).json({ error: 'Agent not found' });
        if (agent.platform !== 'telegram' || !agent.token) {
            return res.status(409).json({ error: 'Telegram token is not configured for this agent' });
        }

        const webhookUrl = publicWebhookUrl(req);

        if (action === 'disconnect') {
            try {
                await telegram('deleteWebhook', agent.token, { drop_pending_updates: true }, { timeoutMs: 12_000 });
            } catch (error) {
                console.error('Legacy Telegram webhook removal failed:', error.message);
            }
            const disconnected = await db(`agents?id=eq.${encoded(id)}`, {
                method: 'PATCH',
                body: JSON.stringify({
                    webhook_secret: null,
                    webhook_secret_hash: null,
                    telegram_bot_id: null,
                    telegram_connection_nonce: null,
                    telegram_connection_expires_at: null,
                    connected: false
                })
            });
            if (!disconnected.res.ok) {
                return res.status(503).json({ error: 'Failed to save disconnected state' });
            }
            return res.status(200).json({ ok: true, connected: false });
        }

        if (agent.connected) {
            return res.status(409).json({ error: 'Disconnect this Telegram bot before reconnecting it' });
        }

        // Reclaim only an expired reservation. The nonce condition on the
        // subsequent PATCH still serializes two connects for the same agent.
        if (agent.telegram_connection_nonce
            && agent.telegram_connection_expires_at
            && new Date(agent.telegram_connection_expires_at).getTime() <= Date.now()) {
            await releaseReservation(agent.id, agent.telegram_connection_nonce);
        }

        let bot;
        try {
            bot = await telegram('getMe', agent.token, {}, { timeoutMs: 10_000 });
        } catch {
            return res.status(400).json({ error: 'Telegram rejected this bot token' });
        }
        const botId = String(bot?.id || '').trim();
        if (!botId) return res.status(502).json({ error: 'Telegram returned incomplete bot data' });

        const secret = randomUUID();
        const secretHash = telegramWebhookSecretHash(secret);
        const nonce = randomUUID();
        const reservation = await db(
            `agents?id=eq.${encoded(id)}&platform=eq.telegram&connected=eq.false&telegram_connection_nonce=is.null&telegram_bot_id=is.null`,
            {
                method: 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify({
                    webhook_secret: null,
                    webhook_secret_hash: secretHash,
                    telegram_bot_id: botId,
                    telegram_connection_nonce: nonce,
                    telegram_connection_expires_at: new Date(Date.now() + 90_000).toISOString(),
                    connected: false
                })
            }
        );
        if (reservation.res.status === 409) {
            return res.status(409).json({ error: 'This Telegram bot is already connected to another agent' });
        }
        if (!reservation.res.ok) return res.status(503).json({ error: 'Failed to reserve Telegram bot' });
        if (!reservation.body?.[0]) {
            return res.status(409).json({ error: 'Telegram is already connecting in another window' });
        }

        try {
            await telegram('setWebhook', agent.token, {
                url: webhookUrl,
                secret_token: secret,
                allowed_updates: ['message']
            }, { timeoutMs: 12_000 });
        } catch (error) {
            await releaseReservation(id, nonce).catch(() => {});
            throw Object.assign(new Error('Telegram did not accept the webhook'), { status: 502, cause: error });
        }

        let connected = await db(
            `agents?id=eq.${encoded(id)}&telegram_connection_nonce=eq.${encoded(nonce)}&telegram_bot_id=eq.${encoded(botId)}`,
            {
                method: 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify({
                    connected: true,
                    telegram_connection_nonce: null,
                    telegram_connection_expires_at: null
                })
            }
        );
        if (!connected.res.ok || !connected.body?.[0]) {
            const reconciled = await db(
                `agents?select=id&id=eq.${encoded(id)}&connected=eq.true&telegram_bot_id=eq.${encoded(botId)}&webhook_secret_hash=eq.${encoded(secretHash)}&limit=1`
            ).catch(() => ({ res: { ok: false }, body: null }));
            if (reconciled.res.ok && reconciled.body?.[0]) connected = reconciled;
            else {
                // Do not deleteWebhook here: a newer request may already have
                // replaced it. The orphaned secret cannot authenticate and a
                // retry safely overwrites the remote webhook.
                await releaseReservation(id, nonce).catch(() => {});
                return res.status(503).json({ error: 'Webhook set, but connection was not confirmed; retry' });
            }
        }

        return res.status(200).json({ ok: true, connected: true, webhook: webhookUrl });
    } catch (error) {
        console.error('Connect webhook error:', error.message);
        return res.status(error.status || 500).json({ error: error.message || 'Telegram connection failed' });
    }
}
