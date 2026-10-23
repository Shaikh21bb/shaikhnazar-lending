import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.AUTH_SECRET = 'personal-agent-auth-secret-long-enough';
process.env.CREDENTIALS_ENCRYPTION_KEY = 'personal-agent-credential-secret-long-enough';

const { encryptCredential, decryptCredential } = await import('../server/api/_credentials.js');
const { createSession } = await import('../server/api/_auth.js');
const {
    completePersonalMessageDelivery,
    connectPersonalTelegram,
    createPersonalRecord,
    handlePersonalMessage,
    linkPersonalTelegramOwner,
    monthlyRangeForTimeZone,
    saveOpenRouterConnection
} = await import('../server/api/_agent/personal.js');
const { default: telegramHandler, replyToPersonalAgent } = await import('../server/api/telegram.js');
const { default: recordsHandler } = await import('../server/api/hub/records.js');
const { default: logoutHandler } = await import('../server/api/auth/logout.js');

function response() {
    return {
        statusCode: 200,
        headers: {},
        setHeader(name, value) { this.headers[name] = value; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

function clientCookie(id = '11111111-1111-4111-8111-111111111111') {
    return `shaikh_session=${encodeURIComponent(createSession({ id, login: 'client-one', role: 'client' }))}`;
}

test('personal credentials are encrypted per agent and provider', () => {
    const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const box = encryptCredential(agentId, 'telegram', '123456:telegram-secret-value');
    assert.ok(!box.includes('telegram-secret-value'));
    assert.equal(decryptCredential(agentId, 'telegram', box), '123456:telegram-secret-value');
    assert.throws(() => decryptCredential(otherId, 'telegram', box), /Не удалось прочитать/);
    assert.throws(() => decryptCredential(agentId, 'openrouter', box), /Не удалось прочитать/);
});

test('production credentials require a dedicated encryption key', () => {
    const previousVercelEnv = process.env.VERCEL_ENV;
    const previousCredentialKey = process.env.CREDENTIALS_ENCRYPTION_KEY;
    process.env.VERCEL_ENV = 'preview';
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    try {
        assert.throws(
            () => encryptCredential('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'telegram', 'secret'),
            /безопасному хранению/
        );
    } finally {
        if (previousVercelEnv === undefined) delete process.env.VERCEL_ENV;
        else process.env.VERCEL_ENV = previousVercelEnv;
        process.env.CREDENTIALS_ENCRYPTION_KEY = previousCredentialKey;
    }
});

test('monthly finance range follows the configured business timezone', () => {
    const range = monthlyRangeForTimeZone(new Date('2026-10-31T20:00:00.000Z'), 'Asia/Almaty');
    assert.deepEqual(range, {
        start: '2026-10-31T19:00:00.000Z',
        end: '2026-11-30T19:00:00.000Z'
    });
});

test('logout rejects cross-origin requests before clearing the session', () => {
    const blocked = response();
    logoutHandler({ method: 'POST', headers: { origin: 'https://evil.example', host: 'shaikh.digital' } }, blocked);
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.headers['Set-Cookie'], undefined);

    const allowed = response();
    logoutHandler({ method: 'POST', headers: { origin: 'https://shaikh.digital', host: 'shaikh.digital', 'x-forwarded-proto': 'https' } }, allowed);
    assert.equal(allowed.statusCode, 200);
    assert.match(allowed.headers['Set-Cookie'], /Max-Age=0/);
});

test('record API derives the personal agent from the signed account session', async () => {
    const previousFetch = globalThis.fetch;
    const urls = [];
    const accountId = '11111111-1111-4111-8111-111111111111';
    const agentId = '22222222-2222-4222-8222-222222222222';
    globalThis.fetch = async url => {
        urls.push(String(url));
        if (String(url).includes('/managers_auth?')) {
            return new Response(JSON.stringify([{ id: accountId }]), { status: 200 });
        }
        if (String(url).includes('/personal_agents?')) {
            return new Response(JSON.stringify([{ id: agentId, account_id: accountId }]), { status: 200 });
        }
        if (String(url).includes('/personal_agent_records?')) {
            return new Response(JSON.stringify([]), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
    };
    try {
        const res = response();
        await recordsHandler({
            method: 'GET',
            headers: { cookie: clientCookie(accountId) },
            query: { kind: 'note', agentId: 'attacker-controlled-id' }
        }, res);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.records, []);
        assert.match(urls[0], new RegExp(`id=eq\\.${accountId}`));
        assert.match(urls[1], new RegExp(`account_id=eq\\.${accountId}`));
        assert.match(urls[2], new RegExp(`agent_id=eq\\.${agentId}`));
        assert.equal(urls.some(url => url.includes('attacker-controlled-id')), false);
    } finally { globalThis.fetch = previousFetch; }
});

test('OpenRouter BYOK is validated and only encrypted material reaches Supabase', async () => {
    const previousFetch = globalThis.fetch;
    const agent = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', model: 'openrouter/free' };
    const apiKey = 'sk-or-v1-abcdefghijklmnop';
    let saved;
    globalThis.fetch = async (url, options = {}) => {
        if (String(url) === 'https://openrouter.ai/api/v1/key') {
            assert.equal(options.headers.Authorization, `Bearer ${apiKey}`);
            return new Response(JSON.stringify({ data: { label: 'test' } }), { status: 200 });
        }
        if (String(url).includes('/personal_agent_secrets?on_conflict=')) {
            saved = JSON.parse(options.body);
            return new Response('', { status: 201 });
        }
        if (String(url).includes('/personal_agent_secrets?select=')) {
            return new Response(JSON.stringify([{ secret_box: saved.secret_box, last_four: saved.last_four }]), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
    };
    try {
        const result = await saveOpenRouterConnection(agent, apiKey);
        assert.equal(result.ok, true);
        assert.equal(saved.provider, 'openrouter');
        assert.equal(saved.last_four, 'mnop');
        assert.ok(!saved.secret_box.includes(apiKey));
    } finally { globalThis.fetch = previousFetch; }
});

test('invalid finance writes fail before any database request', async () => {
    const previousFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => { called = true; throw new Error('should not fetch'); };
    try {
        await assert.rejects(createPersonalRecord('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
            kind: 'transaction', title: 'Такси', amount: -10, transactionType: 'expense'
        }), /Сумма должна быть больше нуля/);
        assert.equal(called, false);
    } finally { globalThis.fetch = previousFetch; }
});

test('Telegram personal agent refuses group chats before linking or running tools', async () => {
    const previousFetch = globalThis.fetch;
    const token = '123456:abcdefghijklmnopqrstuvwxyz';
    const box = encryptCredential('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'telegram', token);
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (String(url).includes('/personal_agent_secrets?select=')) {
            return new Response(JSON.stringify([{ secret_box: box, last_four: 'wxyz' }]), { status: 200 });
        }
        if (String(url).includes('api.telegram.org')) {
            return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
    };
    try {
        await replyToPersonalAgent(
            { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Private Agent' },
            { chat: { id: -100123, type: 'supergroup' }, from: { id: 777 }, text: '/start stolen-code' }
        );
        const telegramCall = calls.find(call => call.url.includes('api.telegram.org'));
        assert.ok(telegramCall);
        assert.match(JSON.parse(telegramCall.options.body).text, /только в приватном чате/);
        assert.equal(calls.some(call => call.url.includes('/personal_agents?')), false);
    } finally { globalThis.fetch = previousFetch; }
});

test('Telegram link claim is conditional and one-time', async () => {
    const previousFetch = globalThis.fetch;
    const urls = [];
    let claimed = false;
    globalThis.fetch = async (url, options = {}) => {
        urls.push(String(url));
        assert.equal(options.method, 'PATCH');
        const body = JSON.parse(options.body);
        assert.equal(body.telegram_owner_chat_id, '777');
        assert.equal(body.telegram_owner_user_id, '777');
        if (claimed) return new Response(JSON.stringify([]), { status: 200 });
        claimed = true;
        return new Response(JSON.stringify([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ...body }]), { status: 200 });
    };
    const agent = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    try {
        assert.equal(await linkPersonalTelegramOwner(agent, 'one-time-code', '777', '777'), true);
        assert.match(urls[0], /telegram_owner_chat_id=is\.null/);
        assert.match(urls[0], /telegram_owner_user_id=is\.null/);
        assert.match(urls[0], /telegram_link_hash=eq\./);
        assert.match(urls[0], /telegram_link_expires_at=gt\./);
        await assert.rejects(
            linkPersonalTelegramOwner(agent, 'one-time-code', '777', '777'),
            /уже использован/
        );
    } finally { globalThis.fetch = previousFetch; }
});

test('a conflicting Telegram message claim stops before AI or tools run', async () => {
    const previousFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async url => {
        requestCount += 1;
        if (String(url).endsWith('/rpc/claim_personal_agent_message')) {
            return new Response(JSON.stringify([{
                message_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                claim_status: 'busy',
                cached_reply: null,
                cached_actions: []
            }]), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
    };
    try {
        const result = await handlePersonalMessage({
            agent: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
            channel: 'telegram',
            chatId: '777',
            message: 'Запиши расход 1000 KZT на такси',
            externalMessageId: '42'
        });
        assert.equal(result.busy, true);
        assert.equal(result.duplicate, true);
        assert.equal(result.reply, null);
        assert.equal(requestCount, 1);
    } finally { globalThis.fetch = previousFetch; }
});

test('Telegram webhook lookup never puts the incoming bearer secret in a PostgREST URL', async () => {
    const previousFetch = globalThis.fetch;
    const secret = 'incoming-personal-webhook-secret_123';
    const urls = [];
    let legacyLookups = 0;
    globalThis.fetch = async url => {
        urls.push(String(url));
        if (String(url).includes('/personal_agents?')) {
            return new Response(JSON.stringify([]), { status: 200 });
        }
        if (String(url).includes('/agents?')) {
            legacyLookups += 1;
            if (legacyLookups === 1) {
                return new Response(JSON.stringify({ message: 'column not found' }), { status: 400 });
            }
            return new Response(JSON.stringify([]), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
    };
    try {
        const res = response();
        await telegramHandler({
            method: 'POST',
            headers: { 'x-telegram-bot-api-secret-token': secret },
            body: { update_id: 1 }
        }, res);
        assert.equal(res.statusCode, 401);
        assert.equal(urls.length, 3);
        assert.match(urls[0], /\/personal_agents\?/);
        assert.match(urls[1], /\/agents\?/);
        assert.equal(urls.some(url => url.includes(secret) || url.includes(encodeURIComponent(secret))), false);
        assert.match(urls[0], /[a-f0-9]{64}/);
        assert.match(urls[1], /[a-f0-9]{64}/);
    } finally { globalThis.fetch = previousFetch; }
});

test('a ready Telegram claim replays its cached reply and can be acknowledged', async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
        if (String(url).endsWith('/rpc/claim_personal_agent_message')) {
            return new Response(JSON.stringify([{
                message_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                claim_status: 'ready',
                cached_reply: 'Расход сохранён.',
                cached_actions: [{ tool: 'record_transaction' }]
            }]), { status: 200 });
        }
        if (String(url).endsWith('/rpc/complete_personal_agent_message')) {
            return new Response(JSON.stringify(true), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
    };
    try {
        const result = await handlePersonalMessage({
            agent: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
            channel: 'telegram',
            chatId: '777',
            message: 'Запиши расход',
            externalMessageId: '42'
        });
        assert.equal(result.replay, true);
        assert.equal(result.reply, 'Расход сохранён.');
        assert.ok(result.delivery?.leaseToken);
        assert.equal(await completePersonalMessageDelivery(result.delivery), true);
        assert.equal(calls[1].body.p_lease_token, result.delivery.leaseToken);
    } finally { globalThis.fetch = previousFetch; }
});

test('a claimed Telegram update is persisted as ready before delivery', async () => {
    const previousFetch = globalThis.fetch;
    const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const apiKey = 'sk-or-v1-abcdefghijklmnop';
    const box = encryptCredential(agentId, 'openrouter', apiKey);
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        const call = { url: String(url), body: options.body ? JSON.parse(options.body) : null };
        calls.push(call);
        if (call.url.endsWith('/rpc/claim_personal_agent_message')) {
            return new Response(JSON.stringify([{
                message_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                claim_status: 'claimed',
                cached_reply: null,
                cached_actions: []
            }]), { status: 200 });
        }
        if (call.url.includes('/personal_agent_messages?select=role')) {
            return new Response(JSON.stringify([]), { status: 200 });
        }
        if (call.url.includes('/personal_agent_secrets?select=')) {
            return new Response(JSON.stringify([{ secret_box: box, last_four: 'mnop' }]), { status: 200 });
        }
        if (call.url === 'https://openrouter.ai/api/v1/chat/completions') {
            assert.equal(options.headers.Authorization, `Bearer ${apiKey}`);
            return new Response(JSON.stringify({
                choices: [{ message: { role: 'assistant', content: 'Готово.', tool_calls: [] } }]
            }), { status: 200 });
        }
        if (call.url.endsWith('/rpc/personal_agent_message_ready')) {
            return new Response(JSON.stringify(true), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
    };
    try {
        const result = await handlePersonalMessage({
            agent: { id: agentId, name: 'Agent', language: 'ru', model: 'openrouter/free', instructions: '' },
            channel: 'telegram',
            chatId: '777',
            message: 'Привет',
            externalMessageId: '43',
            deadlineAt: Date.now() + 20_000
        });
        assert.equal(result.reply, 'Готово.');
        assert.ok(result.delivery?.leaseToken);
        const ready = calls.find(call => call.url.endsWith('/rpc/personal_agent_message_ready'));
        assert.equal(ready.body.p_message_id, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
        assert.equal(ready.body.p_reply, 'Готово.');
    } finally { globalThis.fetch = previousFetch; }
});

test('personal Telegram connect reserves before setWebhook and stores only the webhook hash', async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    const agent = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', telegram_connected: false };
    const token = '123456:abcdefghijklmnopqrstuvwxyz';
    let webhookSecret = '';
    globalThis.fetch = async (url, options = {}) => {
        const call = { url: String(url), options, body: options.body ? JSON.parse(options.body) : null };
        calls.push(call);
        if (call.url.includes('api.telegram.org') && call.url.endsWith('/getMe')) {
            return new Response(JSON.stringify({ ok: true, result: { id: 123456, username: 'safe_test_bot' } }), { status: 200 });
        }
        if (call.url.endsWith('/rpc/clear_stale_personal_telegram_connect')) {
            return new Response(JSON.stringify(false), { status: 200 });
        }
        if (call.url.includes('/personal_agents?') && call.options.method === 'PATCH') {
            if (call.body.telegram_connected === false) {
                return new Response(JSON.stringify([{ id: agent.id, ...call.body }]), { status: 200 });
            }
            return new Response(JSON.stringify([{ id: agent.id, telegram_connected: true, ...call.body }]), { status: 200 });
        }
        if (call.url.includes('/personal_agent_secrets?on_conflict=')) {
            return new Response('', { status: 201 });
        }
        if (call.url.includes('api.telegram.org') && call.url.endsWith('/setWebhook')) {
            webhookSecret = call.body.secret_token;
            return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
    };
    try {
        const result = await connectPersonalTelegram(agent, token, 'https://shaikh.digital');
        assert.equal(result.telegram.connected, true);
        const reservationIndex = calls.findIndex(call => call.url.includes('/personal_agents?') && call.body?.telegram_connected === false);
        const webhookIndex = calls.findIndex(call => call.url.endsWith('/setWebhook'));
        assert.ok(reservationIndex >= 0 && reservationIndex < webhookIndex);
        assert.ok(webhookSecret);
        const supabaseCalls = calls.filter(call => call.url.includes('test.supabase.co'));
        assert.equal(supabaseCalls.some(call => call.url.includes(webhookSecret)), false);
        assert.equal(supabaseCalls.some(call => JSON.stringify(call.body).includes(webhookSecret)), false);
        assert.equal(calls.some(call => call.url.endsWith('/deleteWebhook')), false);
    } finally { globalThis.fetch = previousFetch; }
});

