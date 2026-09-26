import { db, readJsonBody } from '../_lib.js';
import { requireDashboardSession } from '../_auth.js';
import { hashPassword } from '../_password.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const session = requireDashboardSession(req, res);
    if (!session) return;
    if (session.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });

    try {
        if (req.method === 'GET') {
            const result = await db('managers_auth?select=id,login,created_at&order=created_at.desc');
            if (!result.res.ok) throw new Error(`Account list failed (${result.res.status})`);
            return res.status(200).json({ accounts: result.body || [] });
        }
        if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) {
            return res.status(405).json({ error: 'Method not allowed' });
        }
        const body = await readJsonBody(req);
        if (req.method === 'POST') {
            const login = String(body.login || '').trim();
            const password = String(body.password || '');
            if (!/^[\p{L}\p{N}_.@-]{3,80}$/u.test(login) || ['admin', 'shaikh'].includes(login.toLowerCase())) {
                return res.status(400).json({ error: 'Invalid or reserved login' });
            }
            if (password.length < 12 || password.length > 128) {
                return res.status(400).json({ error: 'Password must be 12-128 characters' });
            }
            const result = await db('managers_auth', {
                method: 'POST',
                body: JSON.stringify({ login, password: await hashPassword(password) })
            });
            if (!result.res.ok) return res.status(result.res.status === 409 ? 409 : 500).json({ error: 'Could not create account' });
            return res.status(201).json({ ok: true });
        }
        const id = String(body.id || '');
        if (!UUID.test(id)) return res.status(400).json({ error: 'Invalid account id' });
        if (req.method === 'PATCH') {
            const password = String(body.password || '');
            if (password.length < 12 || password.length > 128) {
                return res.status(400).json({ error: 'Password must be 12-128 characters' });
            }
            const result = await db(`managers_auth?id=eq.${encodeURIComponent(id)}`, {
                method: 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify({ password: await hashPassword(password) })
            });
            if (!result.res.ok) throw new Error(`Password update failed (${result.res.status})`);
            return res.status(result.body?.length ? 200 : 404).json(result.body?.length ? { ok: true } : { error: 'Account not found' });
        }
        if (id === session.sub) return res.status(400).json({ error: 'Cannot remove your own account' });
        const lookup = await db(`managers_auth?select=login&id=eq.${encodeURIComponent(id)}&limit=1`);
        if (!lookup.res.ok) throw new Error(`Account lookup failed (${lookup.res.status})`);
        if (!lookup.body?.[0]) return res.status(404).json({ error: 'Account not found' });
        if (['admin', 'shaikh'].includes(String(lookup.body[0].login).toLowerCase())) {
            return res.status(400).json({ error: 'Owner accounts cannot be removed here' });
        }
        const result = await db(`managers_auth?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!result.res.ok) throw new Error(`Account removal failed (${result.res.status})`);
        return res.status(200).json({ ok: true });
    } catch (error) {
        console.error('Admin accounts error:', error);
        return res.status(500).json({ error: 'Account operation unavailable' });
    }
}
