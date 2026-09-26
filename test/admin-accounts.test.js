import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.AUTH_SECRET = 'admin-account-test-secret';

const { default: accounts } = await import('../server/api/admin/accounts.js');
const { createSession } = await import('../server/api/_auth.js');

function ownerRequest(method, body) {
    const cookie = `shaikh_session=${encodeURIComponent(createSession({
        id: 'owner-id', login: 'Shaikh', role: 'owner'
    }))}`;
    return { method, headers: { cookie }, body };
}

function response() {
    return {
        statusCode: 200,
        headers: {},
        setHeader(name, value) { this.headers[name] = value; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

test('owner account list requests only non-secret fields', async () => {
    const previousFetch = globalThis.fetch;
    let requestUrl = '';
    globalThis.fetch = async url => {
        requestUrl = String(url);
        return new Response(JSON.stringify([{ id: 'account-id', login: 'manager1' }]), { status: 200 });
    };
    try {
        const res = response();
        await accounts(ownerRequest('GET'), res);
        assert.equal(res.statusCode, 200);
        assert.match(requestUrl, /select=id,login,created_at/);
        assert.doesNotMatch(requestUrl, /password/);
        assert.equal(res.headers['Cache-Control'], 'no-store');
    } finally { globalThis.fetch = previousFetch; }
});

test('new manager credentials are hashed before database insertion', async () => {
    const previousFetch = globalThis.fetch;
    let inserted;
    globalThis.fetch = async (_url, options) => {
        inserted = JSON.parse(options.body);
        return new Response('', { status: 201 });
    };
    try {
        const res = response();
        await accounts(ownerRequest('POST', { login: 'manager2', password: 'secure-test-password' }), res);
        assert.equal(res.statusCode, 201);
        assert.match(inserted.password, /^scrypt\$/);
        assert.notEqual(inserted.password, 'secure-test-password');
    } finally { globalThis.fetch = previousFetch; }
});
