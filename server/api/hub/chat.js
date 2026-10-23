import { readJsonBody } from '../_lib.js';
import { requireHubSession, requireSameOrigin } from '../_auth.js';
import { ensurePersonalAgent, handlePersonalMessage } from '../_agent/personal.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const session = requireHubSession(req, res);
    if (!session || !requireSameOrigin(req, res)) return;
    try {
        const body = await readJsonBody(req);
        const requestId = String(body.requestId || '').trim();
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) {
            return res.status(400).json({ error: 'Invalid request id' });
        }
        const agent = await ensurePersonalAgent(session);
        const result = await handlePersonalMessage({
            agent,
            channel: 'web',
            chatId: session.sub,
            message: body.message,
            externalMessageId: requestId
        });
        return res.status(200).json(result);
    } catch (error) {
        console.error('Agent Hub chat error:', error.message);
        return res.status(error.status || 500).json({ error: error.message || 'Agent request failed' });
    }
}
