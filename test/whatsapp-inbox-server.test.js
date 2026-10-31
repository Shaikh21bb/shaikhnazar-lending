import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

process.env.SUPABASE_URL = 'https://inbox-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-inbox-service-key';
process.env.AUTH_SECRET = 'synthetic-inbox-auth-secret-for-tests';

const { ingestWhatsAppInbox, whatsappInboxOverview } = await import('../server/api/_agent/whatsapp-inbox.js');
const { workspaceDeviceMutation } = await import('../server/api/_agent/workspace.js');
const { default: handler } = await import('../server/api/hub/whatsapp-inbox.js');
const { createSession } = await import('../server/api/_auth.js');
const { INBOX_RESPONSE_SCHEMA, assertInboxSchema } = await import('../lib/whatsapp-inbox-contract.mjs');

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ROOT = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const THREAD = '55555555-5555-4555-8555-555555555555';
const APPROVAL = '66666666-6666-4666-8666-666666666666';
const OTHER = '77777777-7777-4777-8777-777777777777';
const NOW = Date.parse('2026-10-31T07:00:00.000Z');
const AT = new Date(NOW - 60_000).toISOString();
const CAPTURE = new Date(NOW - 120_000).toISOString();
const RECIPIENT = '70000000000@s.whatsapp.net';
const SESSION = { sub: ACCOUNT, role: 'client', login: 'synthetic-client' };
const context = { root: { id: ROOT }, device: { id: DEVICE } };
const id = number => number.toString(16).padStart(64, '0');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function accountLookup(url) {
    if (url.includes('/managers_auth?')) return json([{ id: ACCOUNT, login: 'synthetic-client', role: 'client' }]);
    if (url.includes('/personal_agents?')) return json([{ id: ROOT, account_id: ACCOUNT }]);
}

function thread(overrides = {}) {
    return { id: THREAD, root_id: ROOT, device_id: DEVICE, recipient: RECIPIENT, contact_name: 'Синтетический собеседник',
        last_message_at: AT, last_message_id: id(1), last_direction: 'incoming', last_status: 'received',
        last_origin: 'live', last_preview: 'Тестовое сообщение', needs_approval: false, ...overrides };
}

function message(number = 1, overrides = {}) {
    return { id: id(number), root_id: ROOT, device_id: DEVICE, thread_id: THREAD, agent_id: AGENT,
        direction: 'incoming', actor: 'contact', kind: 'text', text: 'Синтетическое сообщение', status: 'received',
        occurred_at: new Date(NOW - number * 1000).toISOString(), updated_at: AT, revision: 1,
        approval_id: null, reply_to_id: null, origin: 'live', reason: null, ...overrides };
}

function approval(overrides = {}) {
    return { id: APPROVAL, agent_id: AGENT, original: 'Синтетический вопрос о встрече', draft: 'Уточню у владельца',
        reason: 'Встреча требует согласования', status: 'pending', expires_at: new Date(NOW + 60_000).toISOString(),
        created_at: AT, decided_at: null, delivered_at: null, activity_at: AT, ...overrides };
}

async function withFetch(mock, run) {
    const original = globalThis.fetch;
    globalThis.fetch = mock;
    try { return await run(); } finally { globalThis.fetch = original; }
}

function response() {
    return { headers: {}, statusCode: null, body: null,
        setHeader(name, value) { this.headers[name] = value; },
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; } };
}

function currentEvent(overrides = {}) {
    return { id: id(1), recipient: RECIPIENT, direction: 'incoming', actor: 'contact', kind: 'text',
        text: 'Синтетический входящий тест', status: 'received', occurredAt: new Date().toISOString(),
        revision: 1, origin: 'live', ...overrides };
}

test('GET inbox requires a signed Hub session and never accesses storage anonymously', async () => {
    await withFetch(() => { assert.fail('Anonymous request reached storage'); }, async () => {
        const res = response();
        await handler({ method: 'GET', headers: {}, url: '/api/hub/whatsapp-inbox' }, res);
        assert.equal(res.statusCode, 401);
        assert.equal(res.headers['Cache-Control'], 'private, no-store');
        assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    });
});

test('inbox is read-only and a disabled live account cannot use an older signed session', async () => {
    const cookie = `shaikh_session=${createSession({ ...SESSION, id: ACCOUNT })}`;
    const post = response();
    await handler({ method: 'POST', headers: { cookie }, url: '/api/hub/whatsapp-inbox' }, post);
    assert.equal(post.statusCode, 405);
    const calls = [];
    await withFetch(url => { calls.push(url); return json([]); }, async () => {
        const res = response();
        await handler({ method: 'GET', headers: { cookie }, url: '/api/hub/whatsapp-inbox' }, res);
        assert.equal(res.statusCode, 403);
        assert.equal(calls.length, 1);
        assert.match(calls[0], /managers_auth\?.*disabled_at=is.null/);
    });
});

test('device action uses trusted identity, canonical normalized events and allows an empty capture announcement', async () => {
    const requests = [];
    await withFetch((url, options) => {
        requests.push({ url, payload: JSON.parse(options.body) });
        return json(requests.at(-1).payload.p_events.length);
    }, async () => {
        const captureSince = new Date(Date.now() - 1000).toISOString();
        const event = currentEvent();
        assert.deepEqual(await workspaceDeviceMutation(context, { action: 'whatsapp_inbox', captureSince, events: [event] }), { ok: true, accepted: 1 });
        assert.deepEqual(await ingestWhatsAppInbox(context, { action: 'whatsapp_inbox', captureSince, events: [] }), { ok: true, accepted: 0 });
        assert.match(requests[0].url, /rpc\/workspace_ingest_whatsapp_inbox$/);
        assert.equal(requests[0].payload.p_root_id, ROOT);
        assert.equal(requests[0].payload.p_device_id, DEVICE);
        assert.equal(requests[0].payload.p_events[0].agentId, null);
        assert.equal(requests[0].payload.p_events[0].approvalId, null);
        assert.equal(requests[1].payload.p_events.length, 0);
    });
});

test('ingest rejects nonpersonal chats, raw/private fields, invalid state, oversized batches and old history before writing', async () => {
    const captureSince = new Date(Date.now() - 1000).toISOString();
    const invalid = [
        { events: [currentEvent({ recipient: '123456@g.us' })] },
        { events: [currentEvent({ recipient: 'status@broadcast' })] },
        { events: [currentEvent({ recipient: '123456@newsletter' })] },
        { events: [currentEvent({ raw: { token: 'not-allowed' } })] },
        { events: [currentEvent({ direction: 'incoming', actor: 'agent' })] },
        { events: [currentEvent({ direction: 'outgoing', actor: 'agent', status: 'delivered' })] },
        { events: [currentEvent({ occurredAt: new Date(Date.now() - 5000).toISOString() })] },
        { events: [currentEvent({ text: 'x'.repeat(8001) })] },
        { events: Array.from({ length: 26 }, () => currentEvent()) },
        { root_id: OTHER, events: [currentEvent()] }
    ];
    await withFetch(() => { assert.fail('Invalid batch reached storage'); }, async () => {
        for (const patch of invalid) {
            await assert.rejects(ingestWhatsAppInbox(context, { action: 'whatsapp_inbox', captureSince, ...patch }), error => error.status === 400);
        }
    });
});

test('revoked devices and immutable identity conflicts do not receive success acknowledgements', async () => {
    const body = { action: 'whatsapp_inbox', captureSince: new Date(Date.now() - 1000).toISOString(), events: [currentEvent()] };
    await withFetch(() => json(null), async () => {
        await assert.rejects(ingestWhatsAppInbox(context, body), error => error.status === 401);
    });
    await withFetch(() => json({ code: '22023', message: 'private database detail' }, 400), async () => {
        await assert.rejects(ingestWhatsAppInbox(context, body), error => error.status === 400 && !error.message.includes('private database detail'));
    });
});

test('empty overview validates the public contract and derives live capture status without exposing device/root data', async () => {
    await withFetch((url, options) => {
        const auth = accountLookup(url); if (auth) return auth;
        if (url.includes('/workspace_devices?')) return json([{ id: DEVICE, last_seen_at: new Date(NOW - 1000).toISOString(), status: { whatsapp: 'connected' }, whatsapp_inbox_since: CAPTURE }]);
        assert.match(url, /rpc\/workspace_whatsapp_threads_page$/);
        assert.equal(JSON.parse(options.body).p_root_id, ROOT);
        return json([]);
    }, async () => {
        const result = await whatsappInboxOverview(SESSION, {}, { now: NOW });
        assertInboxSchema(INBOX_RESPONSE_SCHEMA, JSON.parse(JSON.stringify(result)));
        assert.deepEqual(result.status, { deviceOnline: true, connected: true, captureSince: CAPTURE });
        assert.equal(result.selectedThread, null);
        assert.equal(JSON.stringify(result).includes(ROOT), false);
        assert.equal(JSON.stringify(result).includes(DEVICE), false);
    });
});

test('thread pages use bounded keysets and bound literal search, including PostgREST metacharacters', async () => {
    const calls = [];
    const threads = Array.from({ length: 26 }, (_, index) => thread({ id: `${(index + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`, last_message_at: new Date(NOW - index * 1000).toISOString() }));
    await withFetch((url, options) => {
        const auth = accountLookup(url); if (auth) return auth;
        if (url.includes('/workspace_devices?')) return json([]);
        calls.push(JSON.parse(options.body));
        return json(threads);
    }, async () => {
        const search = 'x),root_id.eq.other%_\\';
        const result = await whatsappInboxOverview(SESSION, { search }, { now: NOW });
        assert.equal(result.threads.length, 25);
        assert.ok(result.threadPage.nextCursor);
        await whatsappInboxOverview(SESSION, { search, threadsCursor: result.threadPage.nextCursor }, { now: NOW });
        assert.equal(calls[0].p_search, search);
        assert.equal(calls[0].p_limit, 26);
        assert.equal(calls[1].p_before_at, threads[24].last_message_at);
        assert.equal(calls[1].p_before_id, threads[24].id);
    });
});

test('message pages return latest 50 chronologically, an older keyset and only linked public approvals', async () => {
    const calls = [];
    const messages = Array.from({ length: 51 }, (_, index) => message(index + 1, index === 0 ? { approval_id: APPROVAL, origin: 'self_check', status: 'awaiting_approval' } : {}));
    await withFetch((url, options) => {
        const auth = accountLookup(url); if (auth) return auth;
        if (url.includes('/workspace_devices?')) return json([{ last_seen_at: new Date(NOW - 100_000).toISOString(), status: { whatsapp: 'connected' }, whatsapp_inbox_since: CAPTURE }]);
        if (url.endsWith('/rpc/workspace_whatsapp_threads_page')) return json([thread({ needs_approval: true })]);
        if (url.endsWith('/rpc/workspace_whatsapp_messages_page')) { calls.push(JSON.parse(options.body)); return json(messages); }
        assert.match(url, /workspace_approvals\?/);
        const parsed = new URL(url);
        assert.equal(parsed.searchParams.get('root_id'), `eq.${ROOT}`);
        assert.equal(parsed.searchParams.get('device_id'), `eq.${DEVICE}`);
        assert.equal(parsed.searchParams.get('recipient'), `eq.${RECIPIENT}`);
        assert.equal(parsed.searchParams.get('id'), `in.(${APPROVAL})`);
        assert.equal(parsed.searchParams.get('select').includes('recipient'), false);
        return json([approval({ status: 'approved', expires_at: AT, root_id: ROOT, device_id: DEVICE, recipient: RECIPIENT, secret: 'hidden' })]);
    }, async () => {
        const result = await whatsappInboxOverview(SESSION, { threadId: THREAD }, { now: NOW });
        assertInboxSchema(INBOX_RESPONSE_SCHEMA, result);
        assert.equal(result.messages.length, 50);
        assert.equal(result.messages[0].id, id(50));
        assert.equal(result.messages.at(-1).id, id(1));
        assert.equal(result.messages.at(-1).origin, 'self_check');
        assert.ok(result.messagePage.olderCursor);
        assert.equal(result.approvals[0].status, 'expired');
        assert.equal(result.approvals[0].secret, undefined);
        assert.equal(result.approvals[0].recipient, undefined);
        assert.equal(result.status.connected, false);
        await whatsappInboxOverview(SESSION, { threadId: THREAD, messagesCursor: result.messagePage.olderCursor }, { now: NOW });
        assert.equal(calls[0].p_limit, 51);
        assert.equal(calls[1].p_before_id, id(50));
        assert.equal(calls[1].p_before_at, messages[49].occurred_at);
    });
});

test('selected thread lookup remains root-scoped even outside the current search/page and foreign threads return 404', async () => {
    const calls = [];
    await withFetch((url, options) => {
        const auth = accountLookup(url); if (auth) return auth;
        if (url.includes('/workspace_devices?')) return json([]);
        assert.match(url, /rpc\/workspace_whatsapp_threads_page$/);
        calls.push(JSON.parse(options.body));
        return json([]);
    }, async () => {
        await assert.rejects(whatsappInboxOverview(SESSION, { threadId: OTHER, search: 'abc', rootId: OTHER }, { now: NOW }), error => error.status === 404);
        assert.equal(calls.length, 2);
        assert.equal(calls[1].p_thread_id, OTHER);
        assert.equal(calls[1].p_root_id, ROOT);
        assert.equal(calls[1].p_search, null);
    });
});

test('malformed query/cursors fail before database access', async () => {
    const invalid = [
        { threadId: 'not-a-uuid' }, { search: ['array'] }, { search: 'x'.repeat(121) },
        { threadsCursor: '../bad' }, { threadsCursor: Buffer.from(JSON.stringify({ kind: 'threads', at: AT, id: THREAD, root: OTHER })).toString('base64url') },
        { threadsCursor: Buffer.from(JSON.stringify({ kind: 'messages', at: AT, id: id(1) })).toString('base64url') },
        { messagesCursor: Buffer.from(JSON.stringify({ kind: 'messages', at: AT, id: id(1) })).toString('base64url') }
    ];
    await withFetch(() => { assert.fail('Invalid query reached storage'); }, async () => {
        for (const query of invalid) await assert.rejects(whatsappInboxOverview(SESSION, query), error => error.status === 400);
    });
});

test('terminal approval outcomes remain truthful after expiry; no delivery/read status is invented', async () => {
    for (const status of ['sent', 'uncertain', 'failed', 'rejected', 'dispatching']) {
        await withFetch(url => {
            const auth = accountLookup(url); if (auth) return auth;
            if (url.includes('/workspace_devices?')) return json([]);
            if (url.endsWith('/rpc/workspace_whatsapp_threads_page')) return json([thread()]);
            if (url.endsWith('/rpc/workspace_whatsapp_messages_page')) return json([message(1, { approval_id: APPROVAL })]);
            return json([approval({ status, expires_at: AT })]);
        }, async () => {
            const result = await whatsappInboxOverview(SESSION, { threadId: THREAD }, { now: NOW });
            assert.equal(result.approvals[0].status, status);
        });
    }
});

test('migration keeps tables and paging/ingest RPCs service-only with ownership, atomic revision and immutable identity checks', async () => {
    const directory = new URL('../supabase/migrations/', import.meta.url);
    const name = (await readdir(directory)).find(value => value.endsWith('_workspace_whatsapp_inbox.sql'));
    assert.ok(name);
    const sql = await readFile(new URL(name, directory), 'utf8');
    for (const table of ['workspace_whatsapp_threads', 'workspace_whatsapp_messages']) {
        assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
    }
    assert.match(sql, /revoke all on public\.workspace_whatsapp_threads, public\.workspace_whatsapp_messages from public, anon, authenticated/);
    assert.equal((sql.match(/security invoker set search_path = ''/g) || []).length, 3);
    assert.equal((sql.match(/revoke all on function .* from public, anon, authenticated/g) || []).length, 3);
    assert.equal((sql.match(/grant execute on function .* to service_role/g) || []).length, 3);
    assert.match(sql, /where id = p_device_id and root_id = p_root_id and revoked_at is null for update/);
    assert.match(sql, /a\.id = v_agent and a\.root_id = p_root_id and a\.type = 'whatsapp'/);
    assert.match(sql, /a\.id = v_approval and a\.root_id = p_root_id and a\.device_id = p_device_id/);
    assert.match(sql, /a\.recipient = v_recipient/);
    assert.match(sql, /v_existing\.revision >= v_revision then continue/);
    assert.match(sql, /workspace_whatsapp_messages\.root_id = excluded\.root_id/);
    assert.match(sql, /workspace_whatsapp_messages\.device_id = excluded\.device_id/);
    assert.match(sql, /workspace_whatsapp_messages\.thread_id = excluded\.thread_id/);
    assert.match(sql, /workspace_whatsapp_messages\.direction = excluded\.direction/);
    assert.match(sql, /workspace_whatsapp_messages\.origin = excluded\.origin/);
    assert.match(sql, /workspace_whatsapp_messages\.revision < excluded\.revision/);
    assert.match(sql, /get diagnostics v_affected = row_count/);
    assert.match(sql, /whatsapp_inbox_since = coalesce\(whatsapp_inbox_since, p_capture_since\)/);
    assert.match(sql, /strpos\(lower\(t\.recipient\), lower\(p_search\)\)/);
    assert.match(sql, /\(t\.last_message_at, t\.id\) < \(p_before_at, p_before_id\)/);
    assert.match(sql, /\(m\.occurred_at, m\.id\) < \(p_before_at, p_before_id\)/);
    assert.equal(sql.includes('security definer'), false);
    assert.equal(sql.includes('execute format'), false);
});
