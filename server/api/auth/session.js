import { readSession } from '../_auth.js';

export default function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    res.setHeader('Cache-Control', 'no-store');
    const session = readSession(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    return res.status(200).json({ ok: true, user: session });
}
