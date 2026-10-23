import { createHmac, timingSafeEqual } from 'crypto';
import { db } from './_lib.js';

const COOKIE_NAME = 'shaikh_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function authSecret() {
    if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
    if (process.env.VERCEL_ENV || process.env.NODE_ENV === 'production') return '';
    return 'local-development-only-change-me';
}

function sign(payload) {
    return createHmac('sha256', authSecret()).update(payload).digest('base64url');
}

function parseCookies(header = '') {
    return Object.fromEntries(header.split(';').map(part => {
        const index = part.indexOf('=');
        if (index < 0) return ['', ''];
        return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
    }).filter(([key]) => key));
}

export function createSession(user) {
    if (!authSecret()) throw new Error('AUTH_SECRET missing');
    const payload = Buffer.from(JSON.stringify({
        sub: user.id,
        login: user.login,
        role: user.role || 'manager',
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
    })).toString('base64url');
    return `${payload}.${sign(payload)}`;
}

export function readSession(req) {
    if (!authSecret()) return null;
    const token = parseCookies(req.headers?.cookie || '')[COOKIE_NAME];
    if (!token) return null;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = Buffer.from(sign(payload));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!data.sub || !data.exp || data.exp <= Math.floor(Date.now() / 1000)) return null;
        return data;
    } catch (_) {
        return null;
    }
}

export function sessionCookie(token) {
    return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}

export function clearSessionCookie() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}

export function requireDashboardSession(req, res) {
    if (!authSecret()) {
        res.status(503).json({ error: 'AUTH_SECRET missing' });
        return null;
    }
    const session = readSession(req);
    if (!session) {
        res.status(401).json({ error: 'Unauthorized' });
        return null;
    }
    return session;
}

export async function requireLegacyDashboardSession(req, res, allowedRoles = ['owner', 'manager']) {
    const session = requireDashboardSession(req, res);
    if (!session) return null;
    if (!allowedRoles.includes(session.role)) {
        res.status(403).json({ error: 'Dashboard access required' });
        return null;
    }

    let result;
    try {
        result = await db(
            `managers_auth?select=id,login,role,disabled_at&id=eq.${encodeURIComponent(session.sub)}&limit=1`
        );
    } catch (error) {
        console.error('Dashboard account lookup failed:', error.message);
        res.status(503).json({ error: 'Authentication unavailable' });
        return null;
    }
    if (!result.res.ok) {
        console.error('Dashboard account lookup failed:', result.res.status);
        res.status(503).json({ error: 'Authentication unavailable' });
        return null;
    }

    const account = result.body?.[0];
    if (!account || account.disabled_at) {
        res.status(403).json({ error: 'Account access is suspended' });
        return null;
    }
    const login = String(account.login || session.login || '').trim();
    const role = ['admin', 'shaikh'].includes(login.toLowerCase()) ? 'owner' : account.role;
    if (!allowedRoles.includes(role)) {
        res.status(403).json({ error: 'Dashboard access required' });
        return null;
    }
    return { ...session, login, role };
}

export function requireHubSession(req, res) {
    const session = requireDashboardSession(req, res);
    if (!session) return null;
    if (!['owner', 'client'].includes(session.role)) {
        res.status(403).json({ error: 'Agent Hub access required' });
        return null;
    }
    return session;
}

export function requireSameOrigin(req, res) {
    const origin = req.headers?.origin;
    if (!origin) {
        if (process.env.VERCEL_ENV || process.env.NODE_ENV === 'production') {
            res.status(403).json({ error: 'Origin check failed' });
            return false;
        }
        return true;
    }
    const forwardedHost = req.headers?.['x-forwarded-host'] || req.headers?.host;
    const forwardedProto = req.headers?.['x-forwarded-proto'] || (process.env.NODE_ENV === 'production' ? 'https' : 'http');
    if (!forwardedHost) {
        res.status(403).json({ error: 'Origin check failed' });
        return false;
    }
    try {
        if (new URL(origin).origin === `${forwardedProto}://${forwardedHost}`) return true;
    } catch { /* invalid origin */ }
    res.status(403).json({ error: 'Origin check failed' });
    return false;
}
