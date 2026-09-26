import test from 'node:test';
import assert from 'node:assert/strict';

test('legacy manager account can log in without a role database column', async () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
    process.env.AUTH_SECRET = 'unit-test-secret-long-enough-for-this-test';
    const { default: handler } = await import('../api/auth/login.js');

    const previousFetch = globalThis.fetch;
    let requestedUrl = '';
    globalThis.fetch = async url => {
        requestedUrl = String(url);
        return new Response(JSON.stringify([{ id: 'manager-1', login: 'owner', password: 'test-password' }]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    };

    const headers = {};
    const response = {
        statusCode: 200,
        setHeader(name, value) { headers[name] = value; },
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; }
    };
    try {
        await handler({ method: 'POST', body: { login: 'owner', password: 'test-password' } }, response);
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.role, 'manager');
        assert.match(headers['Set-Cookie'], /HttpOnly/);
        assert.match(requestedUrl, /select=id,login,password/);
        assert.doesNotMatch(requestedUrl, /,role/);
    } finally {
        globalThis.fetch = previousFetch;
    }
});
