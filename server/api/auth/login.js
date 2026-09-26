import { db, readJsonBody } from '../_lib.js';
import { createSession, sessionCookie } from '../_auth.js';
import { hashPassword, verifyPassword } from '../_password.js';

export function roleForLogin(login) {
    return ['admin', 'shaikh'].includes(String(login || '').trim().toLowerCase()) ? 'owner' : 'manager';
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    res.setHeader('Cache-Control', 'no-store');
    try {
        const { login, password } = await readJsonBody(req);
        if (!login || !password) return res.status(400).json({ error: 'Login and password are required' });
        const { res: dbRes, body } = await db(
            `managers_auth?select=id,login,password&login=eq.${encodeURIComponent(String(login).trim())}&limit=1`
        );
        if (!dbRes.ok) {
            console.error('Login lookup failed:', dbRes.status);
            return res.status(503).json({ error: 'Authentication unavailable' });
        }
        const user = body?.[0];
        const checked = user ? await verifyPassword(password, user.password) : { valid: false };
        if (!checked.valid) {
            return res.status(401).json({ error: 'Invalid login or password' });
        }
        if (checked.legacy) {
            // Upgrade old plaintext accounts without requiring a password reset.
            try {
                const hash = await hashPassword(password);
                const upgraded = await db(`managers_auth?id=eq.${encodeURIComponent(user.id)}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ password: hash })
                });
                if (!upgraded.res.ok) console.error('Password upgrade failed:', upgraded.res.status);
            } catch (error) {
                console.error('Password upgrade failed:', error);
            }
        }
        const role = roleForLogin(user.login);
        const token = createSession({ ...user, role });
        res.setHeader('Set-Cookie', sessionCookie(token));
        return res.status(200).json({ id: user.id, login: user.login, role });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ error: error.message });
    }
}
