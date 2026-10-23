import { requireHubSession } from '../_auth.js';
import { overviewFor } from '../_agent/personal.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const session = requireHubSession(req, res);
    if (!session) return;
    try {
        return res.status(200).json(await overviewFor(session));
    } catch (error) {
        console.error('Agent Hub overview error:', error.message);
        return res.status(error.status || 500).json({ error: error.message || 'Agent Hub unavailable' });
    }
}
