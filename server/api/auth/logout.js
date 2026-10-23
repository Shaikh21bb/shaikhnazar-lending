import { clearSessionCookie, requireSameOrigin } from '../_auth.js';

export default function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!requireSameOrigin(req, res)) return;
    res.setHeader('Set-Cookie', clearSessionCookie());
    return res.status(200).json({ ok: true });
}

