import { createHmac, timingSafeEqual } from 'crypto';
import { db, readJsonBody } from '../_lib.js';
import { createSession, sessionCookie } from '../_auth.js';

function safePasswordEqual(left, right) {
    const secret = process.env.AUTH_SECRET || 'local-development-only-change-me';
    const digest = value => createHmac('sha256', secret).update(String(value || '')).digest();
    return timingSafeEqual(digest(left), digest(right));
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
        const { login, password } = await readJsonBody(req);
        if (!login || !password) return res.status(400).json({ error: 'Login and password are required' });
        const { res: dbRes, body } = await db(
            `managers_auth?select=id,login,password,role&login=eq.${encodeURIComponent(String(login).trim())}&limit=1`
        );
        const user = body?.[0];
        if (!dbRes.ok || !user || !safePasswordEqual(password, user.password)) {
            return res.status(401).json({ error: 'Invalid login or password' });
        }
        const token = createSession(user);
        res.setHeader('Set-Cookie', sessionCookie(token));
        return res.status(200).json({ id: user.id, login: user.login, role: user.role });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ error: error.message });
    }
}

