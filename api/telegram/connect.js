import { randomUUID } from 'crypto';
import { db, telegram, escapeHtml } from '../_lib.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { id, action } = await new Promise(resolve => {
            let raw = '';
            req.on('data', c => raw += c);
            req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
        });

        if (!id) return res.status(400).json({ error: 'Missing agent id' });

        const { res: aRes, body: agents } = await db(`agents?select=id,token,name&id=eq.${encodeURIComponent(id)}`);
        if (!aRes.ok || !agents || agents.length === 0) {
            return res.status(404).json({ error: 'Agent not found' });
        }
        const agent = agents[0];

        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const webhookUrl = `${proto}://${host}/api/telegram`;

        if (action === 'disconnect') {
            await telegram('deleteWebhook', agent.token);
            await db(`agents?id=eq.${encodeURIComponent(id)}`, {
                method: 'PATCH',
                body: JSON.stringify({ webhook_secret: null, connected: false })
            });
            return res.status(200).json({ ok: true, connected: false });
        }

        const secret = randomUUID();
        await telegram('setWebhook', agent.token, {
            url: webhookUrl,
            secret_token: secret,
            allowed_updates: ['message']
        });

        await db(`agents?id=eq.${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ webhook_secret: secret, connected: true })
        });

        return res.status(200).json({ ok: true, connected: true, webhook: webhookUrl });
    } catch (error) {
        console.error('Connect webhook error:', error);
        return res.status(500).json({ error: error.message });
    }
}