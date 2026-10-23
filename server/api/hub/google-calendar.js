import { readJsonBody } from '../_lib.js';
import { requireHubSession, requireSameOrigin } from '../_auth.js';
import { ensurePersonalAgent } from '../_agent/personal.js';
import {
    beginGoogleCalendarAuth,
    disconnectGoogleCalendar,
    finishGoogleCalendarAuth,
    googleCalendarStatus,
    importGoogleCalendar,
    syncGoogleCalendar
} from '../_agent/google-calendar.js';

export async function start(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    if (req.headers?.['sec-fetch-site'] === 'cross-site') {
        return res.status(403).json({ error: 'Origin check failed' });
    }
    const session = requireHubSession(req, res);
    if (!session) return;
    try {
        const agent = await ensurePersonalAgent(session);
        return await beginGoogleCalendarAuth(req, res, session, agent);
    } catch (error) {
        console.error('Google Calendar OAuth start failed:', error.message);
        return res.status(error.status || 500).json({ error: error.message || 'Google Calendar unavailable' });
    }
}

export async function callback(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const session = requireHubSession(req, res);
    if (!session) return;
    try {
        const agent = await ensurePersonalAgent(session);
        return await finishGoogleCalendarAuth(req, res, session, agent);
    } catch (error) {
        console.error('Google Calendar OAuth callback failed:', error.message);
        res.statusCode = 302;
        res.setHeader('Location', '/hub.html?google=error#connections');
        if (typeof res.send === 'function') return res.send('');
        return res.end?.('');
    }
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    const session = requireHubSession(req, res);
    if (!session) return;
    try {
        const agent = await ensurePersonalAgent(session);
        if (req.method === 'GET') {
            return res.status(200).json(await googleCalendarStatus(agent.id));
        }
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        if (!requireSameOrigin(req, res)) return;
        const body = await readJsonBody(req);
        if (body.action === 'disconnect') return res.status(200).json(await disconnectGoogleCalendar(agent.id));
        if (body.action === 'sync') {
            // Push local edits first. Running both directions concurrently can
            // let a stale pull overwrite a local edit just after it reached
            // Google. Each phase is bounded inside the adapter for the 60s
            // function limit.
            const push = await syncGoogleCalendar(agent.id);
            const pull = await importGoogleCalendar(agent.id);
            return res.status(200).json({ ok: push.ok && pull.ok, push, pull });
        }
        return res.status(400).json({ error: 'Unknown action' });
    } catch (error) {
        console.error('Google Calendar operation failed:', error.message);
        return res.status(error.status || 500).json({ error: error.message || 'Google Calendar operation failed' });
    }
}
