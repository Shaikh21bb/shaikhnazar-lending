import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.SUPABASE_URL = 'https://workspace-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'workspace-service-key';
process.env.AUTH_SECRET = 'workspace-auth-secret-for-tests-only';

const { createSession } = await import('../server/api/_auth.js');
const { encryptCredential } = await import('../server/api/_credentials.js');
const { generateEnvelopeKeyPair, encryptEnvelope } = await import('../lib/private-envelope.mjs');
const {
    validateWorkspacePublicKey, validateWorkspaceEnvelope, workspaceMutation,
    workspaceDeviceMutation, isWorkspaceQuietTime, deliverWorkspaceReminders
} = await import('../server/api/_agent/workspace.js');
const { default: workspaceHandler } = await import('../server/api/hub/workspace.js');
const { default: deviceHandler } = await import('../server/api/hub/device.js');

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ROOT = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const LEASE = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const device = { id: DEVICE, root_id: ROOT };
const root = { id: ROOT, account_id: ACCOUNT };

function response() {
    return {
        statusCode: 200, headers: {},
        setHeader(name, value) { this.headers[name] = value; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

function json(value, status = 200) { return new Response(JSON.stringify(value), { status }); }
function session() { return { sub: ACCOUNT, login: 'client-one', role: 'client' }; }
function accountFetch(url) {
    if (url.includes('/managers_auth?')) return json([{ id: ACCOUNT, login: 'client-one', role: 'client' }]);
    if (url.includes('/personal_agents?')) return json([root]);
    return null;
}

test('workspace encryption validator rejects cleartext fields and private keys', async () => {
    const keys = await generateEnvelopeKeyPair();
    const box = await encryptEnvelope(keys.publicKey, { text: 'Текст только на Mac' });
    assert.deepEqual(validateWorkspaceEnvelope(box), box);
    assert.equal(validateWorkspacePublicKey(keys.publicKey).n, keys.publicKey.n);
    assert.throws(() => validateWorkspaceEnvelope({ ...box, text: 'случайная утечка' }), /зашифрованное/);
    assert.throws(() => validateWorkspaceEnvelope({ ...box, iv: 'AAAA' }), /зашифрованное/);
    assert.throws(() => validateWorkspacePublicKey(keys.privateKey), /открытый ключ/);
});

test('workspace and device endpoints reject unauthorized calls before accessing storage', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('storage must not be reached'); };
    try {
        const anonymous = response();
        await workspaceHandler({ method: 'GET', headers: {} }, anonymous);
        assert.equal(anonymous.statusCode, 401);
        const noDevice = response();
        await deviceHandler({ method: 'POST', headers: {}, body: { action: 'poll' } }, noDevice);
        assert.equal(noDevice.statusCode, 401);
        const csrf = response();
        await workspaceHandler({ method: 'POST', headers: {
            cookie: `shaikh_session=${createSession({ id: ACCOUNT, role: 'client', login: 'client-one' })}`,
            host: 'shaikh.digital', origin: 'https://attacker.example', 'x-forwarded-proto': 'https'
        }, body: { action: 'create_pairing' } }, csrf);
        assert.equal(csrf.statusCode, 403);
        assert.equal(csrf.headers['Cache-Control'], 'private, no-store');
    } finally { globalThis.fetch = previous; }
});

test('thought enqueue derives ownership from live account and persists only ciphertext', async () => {
    const previous = globalThis.fetch;
    const keys = await generateEnvelopeKeyPair();
    const box = await encryptEnvelope(keys.publicKey, { text: 'Купить подарок', replyPublicKey: keys.publicKey });
    const writes = [];
    globalThis.fetch = async (input, options = {}) => {
        const url = String(input);
        const account = accountFetch(url);
        if (account) return account;
        if (url.includes('/workspace_devices?')) return json([{ ...device, public_key: keys.publicKey }]);
        if (url.includes('/workspace_jobs?') && options.method === 'POST') {
            writes.push(JSON.parse(options.body));
            return json([{ id: JOB, kind: 'thought', status: 'queued' }]);
        }
        throw new Error(`Unexpected storage request ${url}`);
    };
    try {
        const result = await workspaceMutation(session(), {
            action: 'enqueue', request_id: '0123456789abcdef0123456789abcdef', kind: 'thought',
            root_id: OTHER, device_id: OTHER, envelope: box
        });
        assert.equal(result.job.id, JOB);
        assert.equal(writes[0].root_id, ROOT);
        assert.equal(writes[0].device_id, DEVICE);
        assert.deepEqual(writes[0].envelope, box);
        assert.equal(JSON.stringify(writes).includes('Купить подарок'), false);
        assert.equal('text' in writes[0], false);
    } finally { globalThis.fetch = previous; }
});

test('completion is scoped to device, root and lease, and strips all private reminder metadata', async () => {
    const previous = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), body: JSON.parse(options.body) });
        return json(true);
    };
    try {
        await assert.rejects(workspaceDeviceMutation({ device, root }, {
            action: 'complete', jobId: JOB, leaseToken: LEASE,
            reminders: [{ id: OTHER, due_at: '2026-10-28T10:00:00Z', title: 'Секретная задача' }]
        }), /только время/);
        assert.equal(calls.length, 0);
        await workspaceDeviceMutation({ device, root }, {
            action: 'complete', jobId: JOB, leaseToken: LEASE,
            reminders: [{ id: OTHER, due_at: new Date(Date.now() + 3600000).toISOString() }]
        });
        assert.equal(calls[0].body.p_device_id, DEVICE);
        assert.equal(calls[0].body.p_root_id, ROOT);
        assert.equal(calls[0].body.p_lease_token, LEASE);
        assert.deepEqual(Object.keys(calls[0].body.p_reminders[0]).sort(), ['due_at', 'id']);
        assert.match(calls[0].url, /rpc\/workspace_complete_job$/);
    } finally { globalThis.fetch = previous; }
});

test('expired job lease cannot overwrite an already completed result', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = async () => json(false);
    try {
        await assert.rejects(workspaceDeviceMutation({ device, root }, {
            action: 'complete', jobId: JOB, leaseToken: LEASE
        }), error => error.status === 409);
    } finally { globalThis.fetch = previous; }
});

test('device poll hashes bearer token, rechecks account access and atomically claims own jobs', async () => {
    const previous = globalThis.fetch;
    const token = 'A'.repeat(43);
    const calls = [];
    globalThis.fetch = async (input, options = {}) => {
        const url = String(input);
        calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
        if (url.includes('/workspace_devices?') && !options.method) return json([device]);
        const account = accountFetch(url);
        if (account) return account;
        if (url.includes('/workspace_devices?') && options.method === 'PATCH') return json(null);
        if (url.includes('/rpc/workspace_claim_jobs')) return json([{ id: JOB, kind: 'thought', lease_token: LEASE, envelope: { opaque: true } }]);
        if (url.includes('/rpc/workspace_claim_decisions')) return json([]);
        if (url.includes('/workspace_agents?')) return json([]);
        throw new Error(`Unexpected storage request ${url}`);
    };
    try {
        const res = response();
        await deviceHandler({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body: { action: 'poll', status: { state: 'ready', whatsapp: 'connected', modelReady: true }, model: 'qwen-local' } }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.jobs[0].lease_token, LEASE);
        const lookup = calls.find(call => call.url.includes('token_hash='));
        assert.ok(lookup.url.includes(createHash('sha256').update(token).digest('hex')));
        assert.equal(lookup.url.includes(token), false);
        const claim = calls.find(call => call.url.includes('/rpc/workspace_claim_jobs'));
        assert.deepEqual(claim.body, { p_device_id: DEVICE, p_root_id: ROOT });
        assert.ok(calls.some(call => call.url.includes('/managers_auth?')));
    } finally { globalThis.fetch = previous; }
});

test('an old device token loses access when its account is suspended', async () => {
    const previous = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async input => {
        const url = String(input); calls.push(url);
        if (url.includes('/workspace_devices?')) return json([device]);
        if (url.includes('/personal_agents?')) return json([root]);
        if (url.includes('/managers_auth?')) return json([{ id: ACCOUNT, role: 'client', disabled_at: new Date().toISOString() }]);
        throw new Error('must not claim jobs');
    };
    try {
        const res = response();
        await deviceHandler({ method: 'POST', headers: { authorization: `Bearer ${'B'.repeat(43)}` }, body: { action: 'poll' } }, res);
        assert.equal(res.statusCode, 401);
        assert.equal(calls.some(url => url.includes('/rpc/')), false);
    } finally { globalThis.fetch = previous; }
});

test('WhatsApp generation cannot use another account agent', async () => {
    const previous = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async input => { calls.push(String(input)); return json([]); };
    try {
        await assert.rejects(workspaceDeviceMutation({ device, root }, {
            action: 'generate_whatsapp', agentId: OTHER, text: 'Привет'
        }), error => error.status === 409);
        assert.equal(calls.length, 1);
        assert.match(calls[0], new RegExp(`root_id=eq\\.${ROOT}`));
        assert.ok(!calls[0].includes('openrouter.ai'));
    } finally { globalThis.fetch = previous; }
});

test('free-model failures may queue an empty draft, but owner approval needs a written answer', async () => {
    const previous = globalThis.fetch;
    const writes = [];
    globalThis.fetch = async (input, options = {}) => {
        const url = String(input);
        if (url.includes('/workspace_agents?')) return json([{ id: OTHER }]);
        const account = accountFetch(url);
        if (account) return account;
        if (url.includes('/workspace_approvals?') && options.method === 'POST') {
            writes.push(JSON.parse(options.body));
            return json([{ id: JOB, status: 'pending' }]);
        }
        if (url.includes('/workspace_approvals?')) return json([{ draft: '' }]);
        throw new Error(`Unexpected request ${url}`);
    };
    try {
        const result = await workspaceDeviceMutation({ device, root }, {
            action: 'approval', agentId: OTHER, recipient: '77001234567@s.whatsapp.net',
            original: 'Сколько стоит проект?', draft: '', reason: 'free_limit', externalId: 'message-123'
        });
        assert.equal(result.approval.status, 'pending');
        assert.equal(writes[0].draft, '');
        await assert.rejects(workspaceMutation(session(), { action: 'approve', id: JOB }), /напишите ответ/);
    } finally { globalThis.fetch = previous; }
});

test('a disconnected WhatsApp companion leaves approved decisions waiting', async () => {
    const previous = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, options = {}) => {
        const url = String(input); calls.push(url);
        if (options.method === 'PATCH') return json(null);
        if (url.includes('/workspace_claim_jobs')) return json([]);
        if (url.includes('/workspace_agents?')) return json([]);
        throw new Error('must not claim decisions while disconnected');
    };
    try {
        const result = await workspaceDeviceMutation({ device, root }, { action: 'poll', status: { state: 'ready', whatsapp: 'disconnected' } });
        assert.deepEqual(result.decisions, []);
        assert.equal(calls.some(url => url.includes('/workspace_claim_decisions')), false);
    } finally { globalThis.fetch = previous; }
});

test('late local analysis can replace only its own encrypted result and neutral reminder schedule', async () => {
    const previous = globalThis.fetch;
    const keys = await generateEnvelopeKeyPair();
    const box = await encryptEnvelope(keys.publicKey, { message: 'Заметка оформлена локально' });
    const calls = [];
    globalThis.fetch = async (input, options = {}) => {
        const url = String(input);
        calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
        if (!options.method) return json([{ id: JOB }]);
        return json(null);
    };
    try {
        await workspaceDeviceMutation({ device, root }, {
            action: 'sync_reminders', jobId: JOB, resultEnvelope: box,
            reminders: [{ id: OTHER, due_at: new Date(Date.now() + 3600000).toISOString() }]
        });
        const updated = calls.find(call => call.method === 'PATCH');
        assert.deepEqual(updated.body.result_envelope, box);
        assert.match(updated.url, new RegExp(`device_id=eq\\.${DEVICE}`));
        assert.match(updated.url, new RegExp(`root_id=eq\\.${ROOT}`));
        const reminders = calls.find(call => call.method === 'POST');
        assert.deepEqual(Object.keys(reminders.body[0]).sort(), ['due_at', 'id', 'job_id', 'root_id']);
        assert.equal(JSON.stringify(calls).includes('Заметка оформлена локально'), false);
    } finally { globalThis.fetch = previous; }
});

test('Almaty quiet hours defer reminders and daily digest without reading messages', async () => {
    assert.equal(isWorkspaceQuietTime(new Date('2026-10-27T16:59:00Z')), false); // 21:59
    assert.equal(isWorkspaceQuietTime(new Date('2026-10-27T17:00:00Z')), true); // 22:00
    assert.equal(isWorkspaceQuietTime(new Date('2026-10-28T03:59:00Z')), true); // 08:59
    assert.equal(isWorkspaceQuietTime(new Date('2026-10-28T04:00:00Z')), false); // 09:00
    const previous = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('quiet hours must not access storage'); };
    try {
        assert.deepEqual(await deliverWorkspaceReminders({ now: new Date('2026-10-27T18:00:00Z') }), { sent: 0, deferred: true });
    } finally { globalThis.fetch = previous; }
});

test('due reminders send a neutral Telegram message only after winning the atomic claim', async () => {
    const previous = globalThis.fetch;
    const secretBox = encryptCredential(ROOT, 'telegram', '12345:test-bot-token');
    const calls = [];
    let claimed = false;
    globalThis.fetch = async (input, options = {}) => {
        const url = String(input);
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, body });
        if (url.includes('/workspace_reminders?') && !options.method) return json([{ id: JOB, root_id: ROOT, title: 'СЕКРЕТНОЕ СОДЕРЖАНИЕ ЗАМЕТКИ' }]);
        if (url.includes('/personal_agents?')) return json([{ ...root, telegram_owner_chat_id: '777' }]);
        if (url.includes('/managers_auth?')) return json([{ id: ACCOUNT, role: 'client' }]);
        if (url.includes('/personal_agent_secrets?')) return json([{ secret_box: secretBox }]);
        if (url.includes('/workspace_reminders?') && body?.status === 'dispatching') {
            if (claimed) return json([]);
            claimed = true;
            return json([{ id: JOB }]);
        }
        if (url.includes('/workspace_reminders?') && body?.status === 'sent') return json(null);
        if (url.startsWith('https://api.telegram.org/')) return json({ ok: true, result: { message_id: 1 } });
        if (url.includes('/workspace_devices?')) return json([]);
        throw new Error(`Unexpected request ${url}`);
    };
    try {
        const now = new Date('2026-10-27T04:30:00Z');
        assert.equal((await deliverWorkspaceReminders({ now })).sent, 1);
        assert.equal((await deliverWorkspaceReminders({ now })).sent, 0);
        const messages = calls.filter(call => call.url.startsWith('https://api.telegram.org/'));
        assert.equal(messages.length, 1);
        assert.equal(messages[0].body.chat_id, '777');
        assert.equal(messages[0].body.text.includes('СЕКРЕТНОЕ'), false);
        assert.ok(messages[0].body.text.includes('Напоминание'));
        assert.equal(calls.some(call => call.url.includes('/personal_agent_records?')), false);
    } finally { globalThis.fetch = previous; }
});
