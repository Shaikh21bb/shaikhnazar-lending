import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../server/api/_password.js';
import { createSession } from '../server/api/_auth.js';
import accounts from '../server/api/admin/accounts.js';
import { roleForLogin } from '../server/api/auth/login.js';

function response() {
    return {
        statusCode: 200,
        headers: {},
        setHeader(name, value) { this.headers[name] = value; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

test('password hashing verifies correct passwords without storing them in plaintext', async () => {
    const stored = await hashPassword('long-test-password');
    assert.match(stored, /^scrypt\$/);
    assert.equal((await verifyPassword('long-test-password', stored)).valid, true);
    assert.equal((await verifyPassword('wrong-password', stored)).valid, false);
});

test('Shaikh and admin logins receive signed owner role', () => {
    assert.equal(roleForLogin('Shaikh'), 'owner');
    assert.equal(roleForLogin('admin'), 'owner');
    assert.equal(roleForLogin('demo1'), 'manager');
});

test('owner account endpoint rejects guests and manager sessions', async () => {
    const previous = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = 'owner-access-test-secret';
    try {
        const guest = response();
        await accounts({ method: 'GET', headers: {} }, guest);
        assert.equal(guest.statusCode, 401);

        const managerCookie = `shaikh_session=${encodeURIComponent(createSession({ id: 'manager-id', login: 'manager', role: 'manager' }))}`;
        const manager = response();
        await accounts({ method: 'GET', headers: { cookie: managerCookie } }, manager);
        assert.equal(manager.statusCode, 403);
    } finally {
        if (previous === undefined) delete process.env.AUTH_SECRET;
        else process.env.AUTH_SECRET = previous;
    }
});
