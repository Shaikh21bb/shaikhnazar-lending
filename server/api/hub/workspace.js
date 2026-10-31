import { requireHubSession, requireSameOrigin } from '../_auth.js';
import { readJsonBody } from '../_lib.js';
import { workspaceMutation, workspaceOverview } from '../_agent/workspace.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    const session = requireHubSession(req, res);
    if (!session) return;
    if (req.method === 'POST' && !requireSameOrigin(req, res)) return;
    try {
        let result;
        if (req.method === 'GET') result = await workspaceOverview(session, { approvalOffset: req.query?.approvalOffset });
        else {
            const body = await readJsonBody(req);
            if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > 760000) return res.status(400).json({ error: 'Некорректный запрос.' });
            result = await workspaceMutation(session, body);
        }
        return res.status(200).json(result);
    } catch (error) {
        // The request may contain sensitive ciphertext. Never log payloads or DB error details.
        console.error('Workspace request failed:', error.status || 500, error.code || 'request_failed');
        return res.status(error.status || 500).json({ error: error.status ? error.message : 'Личный кабинет временно недоступен.' });
    }
}
