import test from 'node:test';
import assert from 'node:assert/strict';

test('legacy manager account can log in without a role database column', async () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
    process.env.AUTH_SECRET = 'unit-test-secret-long-enough-for-this-test';
    const { default: handler } = await import('../server/api/auth/login.js');

    const previousFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options) => {
        requests.push({ url: String(url), options });
        return new Response(JSON.stringify(options?.method === 'PATCH' ? [] : [{ id: 'manager-1', login: 'owner', password: 'test-password' }]), {
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
        assert.match(requests[0].url, /select=id,login,password/);
        assert.doesNotMatch(requests[0].url, /,role/);
        assert.equal(requests[1].options.method, 'PATCH');
        assert.match(JSON.parse(requests[1].options.body).password, /^scrypt\$/);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('database outage is reported separately from an invalid password', async () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
    const { default: handler } = await import('../server/api/auth/login.js');
    const previousFetch = globalThis.fetch;
    const previousError = console.error;
    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Database unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
    });
    console.error = () => {};
    const response = {
        statusCode: 200,
        setHeader() {},
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; }
    };
    try {
        await handler({ method: 'POST', body: { login: 'missing', password: 'wrong' } }, response);
        assert.equal(response.statusCode, 503);
        assert.equal(response.body.error, 'Authentication unavailable');
    } finally {
        globalThis.fetch = previousFetch;
        console.error = previousError;
    }
});
