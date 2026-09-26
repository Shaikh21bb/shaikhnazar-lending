import { createHmac, timingSafeEqual } from 'crypto';

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
