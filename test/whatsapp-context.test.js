import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://whatsapp-context-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-context-service-key';
process.env.AUTH_SECRET = 'synthetic-context-auth-secret-at-least-32-characters';

const { workspaceDeviceMutation } = await import('../server/api/_agent/workspace.js');
const { default: deviceHandler } = await import('../server/api/hub/device.js');
const ROOT = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const recipient = '77771234567@s.whatsapp.net';
const context = { device: { id: DEVICE, root_id: ROOT }, root: { id: ROOT } };
const json = value => new Response(JSON.stringify(value));

function fixture(t, { enabled = true, pending = [] } = {}) {
    const previous = globalThis.fetch, calls = [];
    globalThis.fetch = async url => {
        const parsed = new URL(url);
        assert.equal(parsed.origin, process.env.SUPABASE_URL);
        calls.push(parsed);
        if (parsed.pathname === '/rest/v1/workspace_agents') {
            assert.equal(parsed.searchParams.get('id'), `eq.${AGENT}`);
            assert.equal(parsed.searchParams.get('root_id'), `eq.${ROOT}`);
            assert.equal(parsed.searchParams.get('type'), 'eq.whatsapp');
            assert.equal(parsed.searchParams.get('enabled'), 'eq.true');
            return json(enabled ? [{ id: AGENT, root_id: ROOT, type: 'whatsapp', enabled: true }] : []);
        }
        if (parsed.pathname === '/rest/v1/workspace_approvals') {
            assert.equal(parsed.searchParams.get('root_id'), `eq.${ROOT}`);
            assert.equal(parsed.searchParams.get('device_id'), `eq.${DEVICE}`);
            assert.equal(parsed.searchParams.get('agent_id'), `eq.${AGENT}`);
            assert.equal(parsed.searchParams.get('recipient'), `eq.${recipient}`);
            assert.equal(parsed.searchParams.get('status'), 'in.(pending,approved,dispatching)');
            assert.match(parsed.searchParams.get('expires_at'), /^gt\.\d{4}-/u);
            const selection = parsed.searchParams.get('select');
            assert.ok(selection && !/(?:\*|original|draft)/u.test(selection));
            return json(pending);
        }
        throw new Error('Unexpected synthetic storage request');
    };
    t.after(() => { globalThis.fetch = previous; });
    return { calls, invoke: overrides => workspaceDeviceMutation(context, { action: 'whatsapp_context', agentId: AGENT, recipient, ...overrides }) };
}

test('important-chat context is scoped to own root, device, enabled agent and personal recipient', async t => {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const f = fixture(t, { pending: [{ reason: 'meeting', external_id: 'synthetic-meeting', expires_at: expiresAt,
        original: 'PRIVATE_SYNTHETIC_ORIGINAL', draft: 'PRIVATE_SYNTHETIC_DRAFT' }] });
    const result = await f.invoke({ root_id: OTHER, device_id: OTHER });
    assert.deepEqual(result, { pending: true, reason: 'meeting', externalId: 'synthetic-meeting', expiresAt });
    assert.equal(f.calls.length, 2);
    assert.equal(JSON.stringify(result).includes('PRIVATE_SYNTHETIC'), false);
});

test('resolved or absent important-chat context returns only pending false', async t => {
    const f = fixture(t);
    assert.deepEqual(await f.invoke(), { pending: false });
});

test('a disabled or foreign agent cannot read pending-chat context', async t => {
    const f = fixture(t, { enabled: false });
    await assert.rejects(f.invoke(), error => error.status === 409);
    assert.equal(f.calls.filter(call => call.pathname.endsWith('/workspace_approvals')).length, 0);
});

test('group, channel, status and broadcast context requests never read approval content', async t => {
    const f = fixture(t);
    for (const jid of ['120363000000000000@g.us', 'status@broadcast', '123456789@newsletter', '123456789@broadcast']) {
        await assert.rejects(f.invoke({ recipient: jid }), error => error.status === 400);
    }
    assert.equal(f.calls.filter(call => call.pathname.endsWith('/workspace_approvals')).length, 0);
});

test('the context endpoint rejects missing device authentication before storage access', async t => {
    const previous = globalThis.fetch;
    let reached = false;
    globalThis.fetch = async () => { reached = true; throw new Error('Must not access storage'); };
    t.after(() => { globalThis.fetch = previous; });
    const response = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await deviceHandler({ method: 'POST', headers: {}, body: { action: 'whatsapp_context', agentId: AGENT, recipient } }, response);
    assert.equal(response.statusCode, 401);
    assert.equal(reached, false);
});
