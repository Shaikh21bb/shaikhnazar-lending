import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, readSession, sessionCookie } from '../server/api/_auth.js';

test('dashboard session is signed, readable, and rejects tampering', () => {
    const previousSecret = process.env.AUTH_SECRET;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.AUTH_SECRET = 'a-test-secret-that-is-long-enough';
    process.env.NODE_ENV = 'test';
    try {
        const token = createSession({ id: 'user-1', login: 'admin', role: 'admin' });
        const cookie = sessionCookie(token).split(';')[0];
        const session = readSession({ headers: { cookie } });
        assert.equal(session.sub, 'user-1');
        assert.equal(session.role, 'admin');

        const tampered = cookie.replace('shaikh_session=', 'shaikh_session=x');
        assert.equal(readSession({ headers: { cookie: tampered } }), null);
    } finally {
        if (previousSecret === undefined) delete process.env.AUTH_SECRET;
        else process.env.AUTH_SECRET = previousSecret;
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
    }
});
