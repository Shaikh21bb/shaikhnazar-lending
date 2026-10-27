import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.SUPABASE_URL = 'https://reminder-auth-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
const { default: handler } = await import('../server/api/hub/remind.js');

function response() { return { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }

test('scheduled neutral reminders reject missing and mismatched credentials', async () => {
    const original = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async url => {
        requests += 1;
        assert.match(String(url), /workspace_scheduler\?select=token_hash&singleton=eq.true/);
        return new Response(JSON.stringify([{ token_hash: createHash('sha256').update('b'.repeat(64)).digest('hex') }]));
    };
    try {
        const missing = response();
        await handler({ method: 'POST', headers: {} }, missing);
        assert.equal(missing.statusCode, 401);
        assert.equal(requests, 0);
        const mismatch = response();
        await handler({ method: 'POST', headers: { authorization: `Bearer ${'a'.repeat(64)}` } }, mismatch);
        assert.equal(mismatch.statusCode, 401);
        assert.equal(requests, 1);
    } finally { globalThis.fetch = original; }
});
