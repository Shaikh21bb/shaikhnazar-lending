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
    const requestUrls = [];
    globalThis.fetch = async url => {
        const requestUrl = String(url);
        requestUrls.push(requestUrl);
        if (requestUrl.includes('select=id,login,role,disabled_at&id=eq.owner-id')) {
            return new Response(JSON.stringify([{ id: 'owner-id', login: 'Shaikh', role: 'owner', disabled_at: null }]), { status: 200 });
        }
        return new Response(JSON.stringify([{ id: 'account-id', login: 'manager1' }]), { status: 200 });
    };
    try {
        const res = response();
        await accounts(ownerRequest('GET'), res);
        assert.equal(res.statusCode, 200);
        const requestUrl = requestUrls.at(-1);
        assert.match(requestUrl, /select=id,login,role,disabled_at,created_at/);
        assert.doesNotMatch(requestUrl, /password/);
        assert.equal(res.headers['Cache-Control'], 'no-store');
    } finally { globalThis.fetch = previousFetch; }
});

test('new client credentials are hashed and receive the Agent Hub role', async () => {
    const previousFetch = globalThis.fetch;
    let inserted;
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).includes('select=id,login,role,disabled_at&id=eq.owner-id')) {
            return new Response(JSON.stringify([{ id: 'owner-id', login: 'Shaikh', role: 'owner', disabled_at: null }]), { status: 200 });
        }
        inserted = JSON.parse(options.body);
        return new Response('', { status: 201 });
    };
    try {
        const res = response();
        await accounts(ownerRequest('POST', { login: 'manager2', password: 'secure-test-password' }), res);
        assert.equal(res.statusCode, 201);
        assert.match(inserted.password, /^scrypt\$/);
        assert.notEqual(inserted.password, 'secure-test-password');
        assert.equal(inserted.role, 'client');
    } finally { globalThis.fetch = previousFetch; }
});
