import { readJsonBody } from '../_lib.js';
import { requireHubSession, requireSameOrigin } from '../_auth.js';
import {
    connectPersonalTelegram,
    connectionModels,
    deleteOpenRouterConnection,
    disconnectPersonalTelegram,
    ensurePersonalAgent,
    regenerateTelegramLink,
    saveOpenRouterConnection,
    updatePersonalProfile
} from '../_agent/personal.js';

function requestOrigin(req) {
    const configured = String(process.env.PUBLIC_SITE_URL || '').trim();
    if (configured) {
        try {
            const url = new URL(configured);
            if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw new Error('HTTPS required');
            return url.origin;
        } catch {
            throw Object.assign(new Error('PUBLIC_SITE_URL is invalid.'), { status: 503 });
        }
    }
    const proto = req.headers?.['x-forwarded-proto'] || (process.env.NODE_ENV === 'production' ? 'https' : 'http');
    const host = req.headers?.['x-forwarded-host'] || req.headers?.host;
    if (!host) throw Object.assign(new Error('Public site address is unavailable.'), { status: 503 });
    return `${proto}://${host}`;
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    const session = requireHubSession(req, res);
    if (!session) return;
    try {
        const agent = await ensurePersonalAgent(session);
        if (req.method === 'GET') {
            return res.status(200).json(req.query?.models ? { models: await connectionModels() } : { ok: true });
        }
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        if (!requireSameOrigin(req, res)) return;
        const body = await readJsonBody(req);
        if (body.action === 'profile_update') {
            return res.status(200).json({ ok: true, agent: await updatePersonalProfile(agent, body.profile || body) });
        }
        if (body.action === 'openrouter_set') {
            return res.status(200).json(await saveOpenRouterConnection(agent, body.apiKey, body.model));
        }
        if (body.action === 'openrouter_delete') {
            return res.status(200).json(await deleteOpenRouterConnection(agent));
        }
        if (body.action === 'telegram_connect') {
            return res.status(200).json(await connectPersonalTelegram(agent, body.botToken, requestOrigin(req)));
        }
        if (body.action === 'telegram_disconnect') {
            return res.status(200).json(await disconnectPersonalTelegram(agent));
        }
        if (body.action === 'telegram_regenerate_link') {
            return res.status(200).json(await regenerateTelegramLink(agent));
        }
        return res.status(400).json({ error: 'Unknown action' });
    } catch (error) {
        console.error('Agent Hub connection error:', error.message);
        return res.status(error.status || 500).json({ error: error.message || 'Connection operation failed' });
    }
}
