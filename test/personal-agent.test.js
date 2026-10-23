import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

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
    findPersonalAgentByWebhookSecret,
    handlePersonalMessage,
    linkPersonalTelegramOwner,
    listPersonalRecords,
    monthlyRangeForTimeZone,
    personalWriteSourceKey,
    overviewFor,
    saveOpenRouterConnection
} = await import('../server/api/_agent/personal.js');
const { default: telegramHandler, replyToPersonalAgent } = await import('../server/api/telegram.js');
const { default: connectionsHandler } = await import('../server/api/hub/connections.js');
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

test('agent write idempotency keys are order-independent and separate duplicate occurrences', () => {
    const base = {
        agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        channel: 'telegram',
        chatId: '777',
        externalMessageId: '42',
        tool: 'record_transaction'
    };
    const first = personalWriteSourceKey({
        ...base,
        args: { title: 'Такси', amount: 4500, details: { note: 'Встреча', city: 'Алматы' } },
        occurrence: 1
    });
    const reordered = personalWriteSourceKey({
        ...base,
        args: { details: { city: 'Алматы', note: 'Встреча' }, amount: 4500, title: 'Такси' },
        occurrence: 1
    });
    const repeated = personalWriteSourceKey({
        ...base,
        args: { title: 'Такси', amount: 4500, details: { note: 'Встреча', city: 'Алматы' } },
        occurrence: 2
    });
    assert.equal(first, reordered);
    assert.notEqual(first, repeated);
    assert.match(first, /^[a-f0-9]{64}$/);
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
            return new Response(JSON.stringify([{
                id: accountId, login: 'client-one', role: 'client'
            }]), { status: 200 });
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
            query: {
                kind: 'event',
                limit: '40',
                offset: '80',
                past: 'true',
                upcoming: 'false',
                agentId: 'attacker-controlled-id'
            }
        }, res);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.records, []);
        assert.match(urls[0], new RegExp(`id=eq\\.${accountId}`));
        assert.match(urls[1], new RegExp(`account_id=eq\\.${accountId}`));
        assert.match(urls[2], new RegExp(`agent_id=eq\\.${agentId}`));
        assert.match(decodeURIComponent(urls[2]), /kind=eq\.event/);
        assert.match(decodeURIComponent(urls[2]), /event_at=lt\.[^&]+&order=event_at\.desc&limit=40&offset=80/);
        assert.equal(urls.some(url => url.includes('attacker-controlled-id')), false);

        const unsafe = response();
        await recordsHandler({
            method: 'GET',
            headers: { cookie: clientCookie(accountId) },
            query: {
                kind: 'note',
                limit: '20&status=eq.deleted',
                offset: '10&agent_id=eq.attacker'
            }
        }, unsafe);
        const unsafeRecordUrl = decodeURIComponent(urls.filter(url => url.includes('/personal_agent_records?')).at(-1));
        assert.equal(unsafe.statusCode, 200);
        assert.match(unsafeRecordUrl, /order=created_at\.desc&limit=160$/);
        assert.equal(unsafeRecordUrl.includes('agent_id=eq.attacker'), false);
    } finally { globalThis.fetch = previousFetch; }
});

test('Hub authorization rechecks the live account role instead of trusting a stale cookie', async () => {
    const previousFetch = globalThis.fetch;
    const accountId = '11111111-1111-4111-8111-111111111111';
    let calls = 0;
    globalThis.fetch = async url => {
        calls += 1;
        assert.match(String(url), /\/managers_auth\?/);
        return new Response(JSON.stringify([{
            id: accountId,
            login: 'manager-now',
            role: 'manager'
        }]), { status: 200 });
    };
    try {
        const res = response();
        await recordsHandler({
            method: 'GET',
            headers: { cookie: clientCookie(accountId) },
            query: { kind: 'note' }
        }, res);
        assert.equal(res.statusCode, 403);
        assert.match(res.body.error, /недоступен для этой роли/);
        assert.equal(calls, 1, 'no personal agent or records may be loaded after role revocation');
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('Telegram connection never derives a production webhook from forwarded host headers', async () => {
    const previousFetch = globalThis.fetch;
    const previousVercelEnv = process.env.VERCEL_ENV;
    const previousPublicSiteUrl = process.env.PUBLIC_SITE_URL;
    const accountId = '11111111-1111-4111-8111-111111111111';
    const agentId = '22222222-2222-4222-8222-222222222222';
    process.env.VERCEL_ENV = 'preview';
    delete process.env.PUBLIC_SITE_URL;
    let calls = 0;
    globalThis.fetch = async url => {
        calls += 1;
        if (String(url).includes('/managers_auth?')) {
            return new Response(JSON.stringify([{
                id: accountId, login: 'client-one', role: 'client'
            }]), { status: 200 });
        }
        if (String(url).includes('/personal_agents?')) {
            return new Response(JSON.stringify([{
                id: agentId, account_id: accountId, telegram_connected: false
            }]), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
    };
    try {
        const res = response();
        await connectionsHandler({
            method: 'POST',
            headers: {
                cookie: clientCookie(accountId),
                origin: 'https://attacker-controlled.example',
                host: 'attacker-controlled.example',
                'x-forwarded-host': 'attacker-controlled.example',
                'x-forwarded-proto': 'https'
            },
            body: { action: 'telegram_connect', botToken: '123456789:abcdefghijklmnopqrstuvwxyz' }
        }, res);
        assert.equal(res.statusCode, 503);
        assert.match(res.body.error, /PUBLIC_SITE_URL is required/);
        assert.equal(calls, 2, 'no Telegram provider request may run with an untrusted webhook origin');
    } finally {
        globalThis.fetch = previousFetch;
        if (previousVercelEnv === undefined) delete process.env.VERCEL_ENV;
        else process.env.VERCEL_ENV = previousVercelEnv;
        if (previousPublicSiteUrl === undefined) delete process.env.PUBLIC_SITE_URL;
        else process.env.PUBLIC_SITE_URL = previousPublicSiteUrl;
    }
});

test('record search is applied in PostgREST before the result limit', async () => {
    const previousFetch = globalThis.fetch;
    const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    let requestedUrl = '';
    globalThis.fetch = async url => {
        requestedUrl = decodeURIComponent(String(url));
        return new Response(JSON.stringify([{
            id: '11111111-1111-4111-8111-111111111111',
            kind: 'note',
            title: 'Roadmap, Q4',
            body: 'Found beyond the newest records',
            status: 'active',
            created_at: '2025-01-01T00:00:00.000Z',
            updated_at: '2025-01-01T00:00:00.000Z'
        }]), { status: 200 });
    };
    try {
        const records = await listPersonalRecords(agentId, {
            kind: 'note',
            search: 'Roadmap, Q4',
            limit: 20
        });
        assert.equal(records[0].title, 'Roadmap, Q4');
        assert.match(requestedUrl, new RegExp(`agent_id=eq\\.${agentId}`));
        assert.match(requestedUrl, /kind=eq\.note/);
        assert.match(requestedUrl, /or=\(title\.ilike\."\*Roadmap, Q4\*",body\.ilike\."\*Roadmap, Q4\*",category\.ilike\."\*Roadmap, Q4\*"\)/);
        assert.match(requestedUrl, /order=created_at\.desc/);
        assert.match(requestedUrl, /limit=20/);
    } finally { globalThis.fetch = previousFetch; }
});

test('record pagination supports past events and rejects conflicting event modes', async () => {
    const previousFetch = globalThis.fetch;
    const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    let requestedUrl = '';
    let fetchCount = 0;
    globalThis.fetch = async url => {
        fetchCount += 1;
        requestedUrl = decodeURIComponent(String(url));
        return new Response(JSON.stringify([]), { status: 200 });
    };
    try {
        await listPersonalRecords(agentId, { kind: 'event', past: true, limit: 25, offset: 50 });
        assert.match(requestedUrl, new RegExp(`agent_id=eq\\.${agentId}`));
        assert.match(requestedUrl, /kind=eq\.event/);
        assert.match(requestedUrl, /event_at=lt\.[^&]+&order=event_at\.desc&limit=25&offset=50/);
        await assert.rejects(
            listPersonalRecords(agentId, { kind: 'event', upcoming: true, past: true }),
            /Нельзя одновременно/
        );
        assert.equal(fetchCount, 1);
    } finally { globalThis.fetch = previousFetch; }
});

test('record queries keep transaction and event filters tenant-scoped', async () => {
    const previousFetch = globalThis.fetch;
    const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const urls = [];
    globalThis.fetch = async url => {
        urls.push(decodeURIComponent(String(url)));
        return new Response(JSON.stringify([]), { status: 200 });
    };
    try {
        await listPersonalRecords(agentId, {
            kind: 'transaction',
            search: 'такси',
            transactionType: 'expense',
            category: 'Транспорт',
            from: '2026-10-01T00:00:00+05:00',
            to: '2026-11-01T00:00:00+05:00',
            limit: 30,
            dateOrder: true
        });
        await listPersonalRecords(agentId, {
            kind: 'event',
            search: 'клиент',
            from: '2026-10-20T00:00:00+05:00',
            to: '2026-10-30T00:00:00+05:00',
            past: true,
            limit: 25,
            dateOrder: true
        });

        const transactions = urls[0];
        assert.match(transactions, new RegExp(`agent_id=eq\\.${agentId}`));
        assert.match(transactions, /kind=eq\.transaction/);
        assert.match(transactions, /transaction_type=eq\.expense/);
        assert.match(transactions, /category=ilike\."\*Транспорт\*"/);
        assert.match(transactions, /occurred_at=gte\.2026-09-30T19:00:00\.000Z/);
        assert.match(transactions, /occurred_at=lt\.2026-10-31T19:00:00\.000Z/);
        assert.match(transactions, /order=occurred_at\.desc&limit=30/);

        const events = urls[1];
        assert.match(events, new RegExp(`agent_id=eq\\.${agentId}`));
        assert.match(events, /kind=eq\.event/);
        assert.match(events, /or=\(title\.ilike\."\*клиент\*"/);
        assert.match(events, /event_at=gte\.2026-10-19T19:00:00\.000Z/);
        assert.match(events, /event_at=lt\.2026-10-29T19:00:00\.000Z/);
        assert.match(events, /event_at=lt\.[^&]+&order=event_at\.desc&limit=25/);
        assert.equal(urls.every(url => url.includes(`agent_id=eq.${agentId}`)), true);
    } finally { globalThis.fetch = previousFetch; }
});

test('list_events tool queries only upcoming events in chronological order', async () => {
    const previousFetch = globalThis.fetch;
    const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const box = encryptCredential(agentId, 'openrouter', 'sk-or-v1-abcdefghijklmnop');
    const soon = new Date(Date.now() + 60_000).toISOString();
    const later = new Date(Date.now() + 120_000).toISOString();
    let completionCalls = 0;
    let recordUrl = '';
    let toolPayload;
    globalThis.fetch = async (url, options = {}) => {
        const href = String(url);
        if (href.includes('/personal_agent_messages?select=role')) {
            return new Response(JSON.stringify([]), { status: 200 });
        }
        if (href.endsWith('/personal_agent_messages')) {
            return new Response(JSON.stringify([{ id: 'saved-message' }]), { status: 201 });
        }
        if (href.includes('/personal_agent_secrets?select=')) {
            return new Response(JSON.stringify([{ secret_box: box, last_four: 'mnop' }]), { status: 200 });
        }
        if (href.includes('/personal_agent_records?')) {
            recordUrl = decodeURIComponent(href);
            return new Response(JSON.stringify([
                {
                    id: '22222222-2222-4222-8222-222222222222', kind: 'event', title: 'Later', body: '',
                    event_at: later, status: 'active', created_at: soon, updated_at: soon
                },
                {
                    id: '11111111-1111-4111-8111-111111111111', kind: 'event', title: 'Soon', body: '',
                    event_at: soon, status: 'active', created_at: soon, updated_at: soon
                }
            ]), { status: 200 });
        }
        if (href === 'https://openrouter.ai/api/v1/chat/completions') {
            completionCalls += 1;
            if (completionCalls === 1) {
                return new Response(JSON.stringify({ choices: [{ message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{ id: 'events-1', type: 'function', function: { name: 'list_events', arguments: '{}' } }]
                } }] }), { status: 200 });
            }
            const body = JSON.parse(options.body);
            toolPayload = JSON.parse(body.messages.find(message => message.role === 'tool').content);
            return new Response(JSON.stringify({
                choices: [{ message: { role: 'assistant', content: 'Ближайшее событие найдено.', tool_calls: [] } }]
            }), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
    };
    try {
        const result = await handlePersonalMessage({
            agent: { id: agentId, name: 'Agent', language: 'ru', model: 'openrouter/free', instructions: '' },
            channel: 'web',
            chatId: 'web',
            message: 'Какие у меня ближайшие события?'
        });
        assert.equal(result.reply, 'Ближайшее событие найдено.');
        assert.match(recordUrl, new RegExp(`agent_id=eq\\.${agentId}`));
        assert.match(recordUrl, /kind=eq\.event/);
        assert.match(recordUrl, /event_at=gte\.[^&]+/);
        assert.match(recordUrl, /order=event_at\.asc/);
        assert.match(recordUrl, /limit=40/);
        assert.deepEqual(toolPayload.records.map(record => record.title), ['Soon', 'Later']);
    } finally { globalThis.fetch = previousFetch; }
});

test('list_transactions tool applies type, category, query, and date range', async () => {
    const previousFetch = globalThis.fetch;
    const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const box = encryptCredential(agentId, 'openrouter', 'sk-or-v1-abcdefghijklmnop');
    let completionCalls = 0;
    let recordUrl = '';
    let toolPayload;
    globalThis.fetch = async (url, options = {}) => {
        const href = String(url);
        if (href.includes('/personal_agent_messages?select=role')) {
            return new Response(JSON.stringify([]), { status: 200 });
        }
        if (href.endsWith('/personal_agent_messages')) {
            return new Response(JSON.stringify([{ id: 'saved-message' }]), { status: 201 });
        }
        if (href.includes('/personal_agent_secrets?select=')) {
            return new Response(JSON.stringify([{ secret_box: box, last_four: 'mnop' }]), { status: 200 });
        }
        if (href.includes('/personal_agent_records?')) {
            recordUrl = decodeURIComponent(href);
            return new Response(JSON.stringify([{
                id: '11111111-1111-4111-8111-111111111111',
                kind: 'transaction',
                title: 'Такси до клиента',
                body: 'Встреча',
                amount: 4500,
                currency: 'KZT',
                category: 'Транспорт',
                transaction_type: 'expense',
                occurred_at: '2026-10-22T05:00:00.000Z',
                status: 'active',
                created_at: '2026-10-22T05:00:00.000Z',
                updated_at: '2026-10-22T05:00:00.000Z'
            }]), { status: 200 });
        }
        if (href === 'https://openrouter.ai/api/v1/chat/completions') {
            completionCalls += 1;
            const body = JSON.parse(options.body);
            if (completionCalls === 1) {
                assert.ok(body.tools.some(tool => tool.function.name === 'list_transactions'));
                return new Response(JSON.stringify({ choices: [{ message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'transactions-1',
                        type: 'function',
                        function: {
                            name: 'list_transactions',
                            arguments: JSON.stringify({
                                query: 'клиент',
                                transaction_type: 'expense',
                                category: 'Транспорт',
                                from: '2026-10-01T00:00:00+05:00',
                                to: '2026-11-01T00:00:00+05:00'
                            })
                        }
                    }]
                } }] }), { status: 200 });
            }
            toolPayload = JSON.parse(body.messages.find(message => message.role === 'tool').content);
            return new Response(JSON.stringify({
                choices: [{ message: { role: 'assistant', content: 'Нашёл один расход.', tool_calls: [] } }]
            }), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
    };
    try {
        const result = await handlePersonalMessage({
            agent: { id: agentId, name: 'Agent', language: 'ru', model: 'openrouter/free', instructions: '' },
            channel: 'web',
            chatId: 'web',
            message: 'Найди расходы на транспорт для встреч с клиентом за октябрь'
        });
        assert.equal(result.reply, 'Нашёл один расход.');
        assert.match(recordUrl, new RegExp(`agent_id=eq\\.${agentId}`));
        assert.match(recordUrl, /kind=eq\.transaction/);
        assert.match(recordUrl, /transaction_type=eq\.expense/);
        assert.match(recordUrl, /category=ilike\."\*Транспорт\*"/);
        assert.match(recordUrl, /occurred_at=gte\.2026-09-30T19:00:00\.000Z/);
        assert.match(recordUrl, /occurred_at=lt\.2026-10-31T19:00:00\.000Z/);
        assert.equal(toolPayload.records[0].transactionType, 'expense');
    } finally { globalThis.fetch = previousFetch; }
});

test('overview loads each record kind independently without starving mature accounts', async () => {
    const previousFetch = globalThis.fetch;
    const accountId = '11111111-1111-4111-8111-111111111111';
    const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const recordUrls = [];
    globalThis.fetch = async (url, options = {}) => {
        const href = String(url);
        const decodedHref = decodeURIComponent(href);
        if (href.includes('/managers_auth?')) {
            return new Response(JSON.stringify([{
                id: accountId, login: 'client-one', role: 'client'
            }]), { status: 200 });
        }
        if (href.includes('/personal_agents?')) {
            return new Response(JSON.stringify([{
                id: agentId,
                account_id: accountId,
                name: 'Agent',
                language: 'ru',
                model: 'openrouter/free',
                instructions: ''
            }]), { status: 200 });
        }
        if (href.includes('/personal_agent_secrets?select=')) {
            return new Response(JSON.stringify([]), { status: 200 });
        }
        if (href.includes('/personal_agent_messages?')) {
            return new Response(JSON.stringify([]), { status: 200 });
        }
        if (href.includes('/personal_agent_records?')) {
            recordUrls.push(decodedHref);
            const shared = { status: 'active', created_at: future, updated_at: future };
            if (decodedHref.includes('kind=eq.note')) {
                return new Response(JSON.stringify([{
                    ...shared, id: '22222222-2222-4222-8222-222222222222', kind: 'note', title: 'Note', body: 'Remember'
                }]), { status: 200 });
            }
            if (decodedHref.includes('kind=eq.event')) {
                return new Response(JSON.stringify([{
                    ...shared, id: '33333333-3333-4333-8333-333333333333', kind: 'event', title: 'Event', body: '', event_at: future
                }]), { status: 200 });
            }
            if (decodedHref.includes('kind=eq.transaction')) {
                return new Response(JSON.stringify([{
                    ...shared,
                    id: '44444444-4444-4444-8444-444444444444',
                    kind: 'transaction',
                    title: 'Expense',
                    body: '',
                    amount: 100,
                    currency: 'KZT',
                    transaction_type: 'expense',
                    occurred_at: future
                }]), { status: 200 });
            }
        }
        if (href.endsWith('/rpc/personal_agent_finance_summary')) {
            const body = JSON.parse(options.body);
            const totals = body.p_from
                ? [{ currency: 'KZT', expense: 30, income: 200, entry_count: 2 }]
                : [{ currency: 'KZT', expense: 100, income: 1000, entry_count: 4 }];
            return new Response(JSON.stringify(totals), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
    };
    try {
        const overview = await overviewFor({ id: accountId, sub: accountId, login: 'client-one', role: 'client' });
        assert.deepEqual(overview.records.map(record => record.title), ['Note', 'Event', 'Expense']);
        assert.deepEqual(overview.summary, {
            notes: 1,
            upcomingEvents: 1,
            balance: 900,
            monthIncome: 200,
            monthExpense: 30,
            month: { KZT: { expense: 30, income: 200 } }
        });
        assert.equal(recordUrls.length, 3);
        assert.equal(recordUrls.every(url => url.includes(`agent_id=eq.${agentId}`)), true);
        assert.match(recordUrls.find(url => url.includes('kind=eq.note')), /order=created_at\.desc&limit=80/);
        assert.match(recordUrls.find(url => url.includes('kind=eq.event')), /event_at=gte\.[^&]+&order=event_at\.asc&limit=80/);
        assert.match(recordUrls.find(url => url.includes('kind=eq.transaction')), /order=created_at\.desc&limit=120/);
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

test('update_record tool updates only the owned record and returns an action receipt', async () => {
    const previousFetch = globalThis.fetch;
    const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const recordId = '11111111-1111-4111-8111-111111111111';
    const box = encryptCredential(agentId, 'openrouter', 'sk-or-v1-abcdefghijklmnop');
    const recordUrls = [];
    let completionCalls = 0;
    let patchBody;
    globalThis.fetch = async (url, options = {}) => {
        const href = String(url);
        const body = options.body ? JSON.parse(options.body) : null;
        if (href.endsWith('/rpc/claim_personal_agent_message')) {
            return new Response(JSON.stringify([{
                message_id: '22222222-2222-4222-8222-222222222222',
                claim_status: 'claimed',
                cached_reply: null,
                cached_actions: []
            }]), { status: 200 });
        }
        if (href.includes('/personal_agent_messages?select=role')) {
            return new Response(JSON.stringify([]), { status: 200 });
        }
        if (href.includes('/personal_agent_secrets?select=')) {
            return new Response(JSON.stringify([{ secret_box: box, last_four: 'mnop' }]), { status: 200 });
        }
        if (href.includes('/personal_agent_records?')) {
            recordUrls.push(decodeURIComponent(href));
            const base = {
                id: recordId,
                kind: 'event',
                title: 'Встреча',
                body: 'Старое описание',
                event_at: '2026-10-24T05:00:00.000Z',
                status: 'active',
                created_at: '2026-10-20T05:00:00.000Z',
                updated_at: '2026-10-20T05:00:00.000Z'
            };
            if (options.method === 'PATCH') {
                patchBody = body;
                return new Response(JSON.stringify([{ ...base, ...body }]), { status: 200 });
            }
            return new Response(JSON.stringify([base]), { status: 200 });
        }
        if (href === 'https://openrouter.ai/api/v1/chat/completions') {
            completionCalls += 1;
            if (completionCalls === 1) {
                return new Response(JSON.stringify({ choices: [{ message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'update-1',
                        type: 'function',
                        function: {
                            name: 'update_record',
                            arguments: JSON.stringify({
                                record_id: recordId,
                                title: 'Встреча с клиентом',
                                details: 'Обсудить договор',
                                starts_at: '2026-10-25T10:00:00+05:00'
                            })
                        }
                    }]
                } }] }), { status: 200 });
            }
            return new Response(JSON.stringify({
                choices: [{ message: { role: 'assistant', content: 'Встреча обновлена.', tool_calls: [] } }]
            }), { status: 200 });
        }
        if (href.endsWith('/rpc/personal_agent_message_ready')) {
            return new Response(JSON.stringify(true), { status: 200 });
        }
        if (href.endsWith('/rpc/complete_personal_agent_message')) {
            return new Response(JSON.stringify(true), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
    };
    try {
        const result = await handlePersonalMessage({
            agent: { id: agentId, name: 'Agent', language: 'ru', model: 'openrouter/free', instructions: '' },
            channel: 'web',
            chatId: 'account-one',
            message: 'Перенеси встречу с клиентом и обнови описание',
            externalMessageId: 'update-request-001'
        });
        assert.equal(result.reply, 'Встреча обновлена.');
        assert.equal(result.actions[0].tool, 'update_record');
        assert.equal(result.actions[0].updated, true);
        assert.equal(result.actions[0].record.title, 'Встреча с клиентом');
        assert.equal(patchBody.body, 'Обсудить договор');
        assert.equal(patchBody.event_at, '2026-10-25T05:00:00.000Z');
        assert.equal(recordUrls.length, 2);
        assert.equal(recordUrls.every(url => url.includes(`agent_id=eq.${agentId}`)), true);
        assert.equal(recordUrls.every(url => url.includes(`id=eq.${recordId}`)), true);
    } finally { globalThis.fetch = previousFetch; }
});

test('record deletion requires a later explicit confirmation and stays tenant-bound', async () => {
    const previousFetch = globalThis.fetch;
    const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const recordId = '11111111-1111-4111-8111-111111111111';
    const box = encryptCredential(agentId, 'openrouter', 'sk-or-v1-abcdefghijklmnop');
    const record = {
        id: recordId,
        kind: 'note',
        title: 'Старый черновик',
        body: 'Удалить после подтверждения',
        status: 'active',
        created_at: '2026-10-20T05:00:00.000Z',
        updated_at: '2026-10-20T05:00:00.000Z'
    };
    let phase = 'request';
    let completionCalls = 0;
    let pendingRow = null;
    let deleted = false;
    const transitionUrls = [];
    const recordUrls = [];

    globalThis.fetch = async (url, options = {}) => {
        const href = String(url);
        const body = options.body ? JSON.parse(options.body) : null;
        if (href.endsWith('/rpc/claim_personal_agent_message')) {
            const suffix = body.p_external_message_id === 'delete-request-001' ? '1' : '2';
            return new Response(JSON.stringify([{
                message_id: `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`,
                claim_status: 'claimed',
                cached_reply: null,
                cached_actions: []
            }]), { status: 200 });
        }
        if (href.includes('/personal_agent_messages?select=role')) {
            return new Response(JSON.stringify([]), { status: 200 });
        }
        if (href.includes('/personal_agent_secrets?select=')) {
            return new Response(JSON.stringify([{ secret_box: box, last_four: 'mnop' }]), { status: 200 });
        }
        if (href.includes('/personal_agent_records?')) {
            recordUrls.push(decodeURIComponent(href));
            if (options.method === 'PATCH' && body?.status === 'deleted') {
                deleted = true;
                return new Response(JSON.stringify([{ ...record, status: 'deleted', ...body }]), { status: 200 });
            }
            return new Response(JSON.stringify(deleted ? [] : [record]), { status: 200 });
        }
        if (href.endsWith('/personal_agent_messages') && options.method === 'POST') {
            pendingRow = {
                id: '33333333-3333-4333-8333-333333333333',
                metadata: body.metadata,
                created_at: new Date().toISOString()
            };
            return new Response(JSON.stringify([pendingRow]), { status: 201 });
        }
        if (href.includes('/personal_agent_messages?select=id,metadata,created_at') && options.method !== 'PATCH') {
            return new Response(JSON.stringify(pendingRow ? [pendingRow] : []), { status: 200 });
        }
        if (href.includes('/personal_agent_messages?') && options.method === 'PATCH') {
            transitionUrls.push(decodeURIComponent(href));
            pendingRow = { ...pendingRow, metadata: body.metadata };
            return new Response(JSON.stringify([pendingRow]), { status: 200 });
        }
        if (href === 'https://openrouter.ai/api/v1/chat/completions') {
            completionCalls += 1;
            if (completionCalls === 1) {
                const tool = phase === 'request'
                    ? {
                        id: 'delete-request-tool',
                        type: 'function',
                        function: { name: 'request_delete_record', arguments: JSON.stringify({ record_id: recordId }) }
                    }
                    : {
                        id: 'delete-confirm-tool',
                        type: 'function',
                        function: { name: 'confirm_delete_record', arguments: '{}' }
                    };
                return new Response(JSON.stringify({ choices: [{ message: {
                    role: 'assistant', content: null, tool_calls: [tool]
                } }] }), { status: 200 });
            }
            const reply = phase === 'request'
                ? 'Отправьте отдельным сообщением: «Подтверждаю удаление».'
                : 'Запись удалена.';
            return new Response(JSON.stringify({
                choices: [{ message: { role: 'assistant', content: reply, tool_calls: [] } }]
            }), { status: 200 });
        }
        if (href.endsWith('/rpc/personal_agent_message_ready')) {
            return new Response(JSON.stringify(true), { status: 200 });
        }
        if (href.endsWith('/rpc/complete_personal_agent_message')) {
            return new Response(JSON.stringify(true), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
    };

    try {
        const agent = { id: agentId, name: 'Agent', language: 'ru', model: 'openrouter/free', instructions: '' };
        const requested = await handlePersonalMessage({
            agent,
            channel: 'web',
            chatId: 'account-one',
            message: 'Удали старый черновик',
            externalMessageId: 'delete-request-001'
        });
        assert.equal(deleted, false);
        assert.equal(requested.actions[0].tool, 'request_delete_record');
        assert.equal(requested.actions[0].confirmationRequired, true);
        assert.equal(requested.actions[0].record.title, record.title);
        assert.doesNotMatch(JSON.stringify(requested.actions), /request_hash|challenge_hash/);
        assert.equal(pendingRow.metadata.delete_confirmation.state, 'pending');

        phase = 'confirm';
        completionCalls = 0;
        const confirmed = await handlePersonalMessage({
            agent,
            channel: 'web',
            chatId: 'account-one',
            message: 'Подтверждаю удаление',
            externalMessageId: 'delete-confirm-002'
        });
        assert.equal(deleted, true);
        assert.equal(confirmed.actions[0].tool, 'confirm_delete_record');
        assert.equal(confirmed.actions[0].deleted, true);
        assert.equal(confirmed.actions[0].record.title, record.title);
        assert.doesNotMatch(JSON.stringify(confirmed.actions), /request_hash|challenge_hash/);
        assert.equal(pendingRow.metadata.delete_confirmation.state, 'completed');
        assert.deepEqual(
            transitionUrls.map(url => url.match(/state=eq\.([a-z]+)/)?.[1]),
            ['pending', 'confirming']
        );
        assert.equal(transitionUrls.every(url => url.includes(`agent_id=eq.${agentId}`)), true);
        assert.equal(transitionUrls.every(url => url.includes('channel=eq.web&chat_id=eq.account-one')), true);
        assert.equal(recordUrls.every(url => url.includes(`agent_id=eq.${agentId}`)), true);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('delete confirmation rejects unsafe, expired, corrupt, and ambiguous requests', async t => {
    const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const chatId = 'account-one';
    const externalMessageId = 'guard-request-001';
    const currentHash = createHash('sha256')
        .update(`${agentId}\nweb\n${chatId}\n${externalMessageId}`)
        .digest('hex');
    const cases = [
        {
            name: 'same request id',
            message: 'Подтверждаю удаление',
            requestHash: currentHash,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            expectedTransitions: []
        },
        {
            name: 'expired confirmation',
            message: 'Подтверждаю удаление',
            requestHash: 'different-request-hash',
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
            expectedTransitions: ['expired']
        },
        {
            name: 'corrupt expiry',
            message: 'Подтверждаю удаление',
            requestHash: 'different-request-hash',
            expiresAt: 'not-a-date',
            expectedTransitions: []
        },
        {
            name: 'vague consent',
            message: 'да, удали',
            requestHash: 'different-request-hash',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            expectedTransitions: [],
            noLookup: true
        },
        {
            name: 'multiple pending requests',
            message: 'Подтверждаю удаление',
            requestHash: 'different-request-hash',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            expectedTransitions: ['superseded'],
            pendingCount: 2
        }
    ];

    for (const scenario of cases) {
        await t.test(scenario.name, async () => {
            const previousFetch = globalThis.fetch;
            const box = encryptCredential(agentId, 'openrouter', 'sk-or-v1-abcdefghijklmnop');
            let completionCalls = 0;
            let recordCalls = 0;
            let pendingLookups = 0;
            const transitions = [];
            let toolResult = null;
            const pendingRow = {
                id: '33333333-3333-4333-8333-333333333333',
                created_at: new Date().toISOString(),
                metadata: {
                    internal_type: 'delete_confirmation',
                    delete_confirmation: {
                        state: 'pending',
                        record_id: '11111111-1111-4111-8111-111111111111',
                        record_kind: 'note',
                        record_title: 'Черновик',
                        request_hash: scenario.requestHash,
                        challenge_hash: 'server-only-challenge-hash',
                        expires_at: scenario.expiresAt
                    }
                }
            };
            const pendingRows = [pendingRow];
            if (scenario.pendingCount === 2) {
                pendingRows.push({
                    ...pendingRow,
                    id: '44444444-4444-4444-8444-444444444444',
                    metadata: {
                        ...pendingRow.metadata,
                        delete_confirmation: {
                            ...pendingRow.metadata.delete_confirmation,
                            record_id: '55555555-5555-4555-8555-555555555555',
                            challenge_hash: 'second-server-only-challenge-hash'
                        }
                    }
                });
            }
            globalThis.fetch = async (url, options = {}) => {
                const href = String(url);
                const body = options.body ? JSON.parse(options.body) : null;
                if (href.endsWith('/rpc/claim_personal_agent_message')) {
                    return new Response(JSON.stringify([{
                        message_id: '22222222-2222-4222-8222-222222222222',
                        claim_status: 'claimed',
                        cached_reply: null,
                        cached_actions: []
                    }]), { status: 200 });
                }
                if (href.includes('/personal_agent_messages?select=role')) {
                    return new Response(JSON.stringify([]), { status: 200 });
                }
                if (href.includes('/personal_agent_secrets?select=')) {
                    return new Response(JSON.stringify([{ secret_box: box, last_four: 'mnop' }]), { status: 200 });
                }
                if (href.includes('/personal_agent_messages?select=id,metadata,created_at')) {
                    pendingLookups += 1;
                    return new Response(JSON.stringify(pendingRows), { status: 200 });
                }
                if (href.includes('/personal_agent_messages?') && options.method === 'PATCH') {
                    transitions.push(body.metadata.delete_confirmation.state);
                    return new Response(JSON.stringify([{
                        ...pendingRow,
                        metadata: body.metadata
                    }]), { status: 200 });
                }
                if (href.includes('/personal_agent_records?')) {
                    recordCalls += 1;
                    throw new Error('record mutation must not run');
                }
                if (href === 'https://openrouter.ai/api/v1/chat/completions') {
                    completionCalls += 1;
                    if (completionCalls === 1) {
                        return new Response(JSON.stringify({ choices: [{ message: {
                            role: 'assistant',
                            content: null,
                            tool_calls: [{
                                id: 'confirm-guard',
                                type: 'function',
                                function: { name: 'confirm_delete_record', arguments: '{}' }
                            }]
                        } }] }), { status: 200 });
                    }
                    toolResult = JSON.parse(body.messages.find(item => item.role === 'tool').content);
                    return new Response(JSON.stringify({
                        choices: [{ message: { role: 'assistant', content: 'Удаление не выполнено.', tool_calls: [] } }]
                    }), { status: 200 });
                }
                if (href.endsWith('/rpc/personal_agent_message_ready')) {
                    return new Response(JSON.stringify(true), { status: 200 });
                }
                if (href.endsWith('/rpc/complete_personal_agent_message')) {
                    return new Response(JSON.stringify(true), { status: 200 });
                }
                throw new Error(`Unexpected URL: ${url}`);
            };
            try {
                const result = await handlePersonalMessage({
                    agent: { id: agentId, name: 'Agent', language: 'ru', model: 'openrouter/free', instructions: '' },
                    channel: 'web',
                    chatId,
                    message: scenario.message,
                    externalMessageId
                });
                assert.equal(result.reply, 'Удаление не выполнено.');
                assert.deepEqual(result.actions, []);
                assert.equal(recordCalls, 0);
                assert.deepEqual(transitions, scenario.expectedTransitions);
                assert.equal(pendingLookups, scenario.noLookup ? 0 : 1);
                assert.equal(toolResult.ok, false);
                assert.doesNotMatch(JSON.stringify(toolResult), /server-only-challenge-hash|request_hash|challenge_hash/);
            } finally {
                globalThis.fetch = previousFetch;
            }
        });
    }
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

test('personal Telegram stops when the live account no longer has Hub access', async () => {
    const previousFetch = globalThis.fetch;
    const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const accountId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const urls = [];
    globalThis.fetch = async url => {
        const href = String(url);
        urls.push(href);
        if (href.includes('/personal_agents?')) {
            return new Response(JSON.stringify([{ id: agentId, account_id: accountId }]), { status: 200 });
        }
        if (href.includes('/managers_auth?')) {
            return new Response(JSON.stringify([{
                id: accountId, login: 'manager-now', role: 'manager'
            }]), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
    };
    try {
        assert.equal(await findPersonalAgentByWebhookSecret('valid-looking-secret'), null);
        assert.equal(urls.length, 2);
        assert.match(urls[1], /select=id,login,role/);
    } finally {
        globalThis.fetch = previousFetch;
    }
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
    const token = '4503599627370495:abcdefghijklmnopqrstuvwxyz';
    const webhookUrl = 'https://shaikh.digital/api/telegram';
    let webhookSecret = '';
    globalThis.fetch = async (url, options = {}) => {
        const call = { url: String(url), options, body: options.body ? JSON.parse(options.body) : null };
        calls.push(call);
        if (call.url.includes('api.telegram.org') && call.url.endsWith('/getMe')) {
            return new Response(JSON.stringify({ ok: true, result: { id: 4503599627370495, username: 'safe_test_bot' } }), { status: 200 });
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
        if (call.url.includes('api.telegram.org') && call.url.endsWith('/getWebhookInfo')) {
            return new Response(JSON.stringify({
                ok: true,
                result: { url: webhookUrl, pending_update_count: 0 }
            }), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
    };
    try {
        const result = await connectPersonalTelegram(agent, token, 'https://shaikh.digital');
        assert.equal(result.telegram.connected, true);
        const reservationIndex = calls.findIndex(call => call.url.includes('/personal_agents?') && call.body?.telegram_connected === false);
        const webhookIndex = calls.findIndex(call => call.url.endsWith('/setWebhook'));
        const verificationIndex = calls.findIndex(call => call.url.endsWith('/getWebhookInfo'));
        const confirmationIndex = calls.findIndex(call => call.url.includes('/personal_agents?') && call.body?.telegram_connected === true);
        assert.ok(reservationIndex >= 0 && reservationIndex < webhookIndex);
        assert.ok(webhookIndex < verificationIndex && verificationIndex < confirmationIndex);
        assert.ok(webhookSecret);
        const supabaseCalls = calls.filter(call => call.url.includes('test.supabase.co'));
        assert.equal(supabaseCalls.some(call => call.url.includes(webhookSecret)), false);
        assert.equal(supabaseCalls.some(call => JSON.stringify(call.body).includes(webhookSecret)), false);
        assert.equal(calls.some(call => call.url.endsWith('/deleteWebhook')), false);
    } finally { globalThis.fetch = previousFetch; }
});

test('personal Telegram connect rejects bot IDs outside Telegram safe integer range before network access', async () => {
    const previousFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
        called = true;
        throw new Error('should not fetch');
    };
    try {
        await assert.rejects(
            connectPersonalTelegram(
                { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', telegram_connected: false },
                '4503599627370496:abcdefghijklmnopqrstuvwxyz',
                'https://shaikh.digital'
            ),
            /BotFather/
        );
        assert.equal(called, false);
    } finally { globalThis.fetch = previousFetch; }
});

test('personal Telegram connect aborts when getWebhookInfo does not confirm a clean canonical webhook', async t => {
    const cases = [
        {
            name: 'wrong URL',
            info: secret => ({ url: `https://wrong.example/${secret}`, pending_update_count: 0 })
        },
        {
            name: 'Telegram delivery error',
            info: (secret, token) => ({
                url: 'https://shaikh.digital/api/telegram',
                pending_update_count: 0,
                last_error_message: `provider details ${token} ${secret}`
            })
        }
    ];

    for (const scenario of cases) {
        await t.test(scenario.name, async () => {
            const previousFetch = globalThis.fetch;
            const calls = [];
            const agent = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', telegram_connected: false };
            const token = '1234567890123456:abcdefghijklmnopqrstuvwxyz';
            let webhookSecret = '';
            globalThis.fetch = async (url, options = {}) => {
                const call = { url: String(url), body: options.body ? JSON.parse(options.body) : null };
                calls.push(call);
                if (call.url.endsWith('/getMe')) {
                    return new Response(JSON.stringify({
                        ok: true,
                        result: { id: 1234567890123456, username: 'safe_test_bot' }
                    }), { status: 200 });
                }
                if (call.url.endsWith('/rpc/clear_stale_personal_telegram_connect')) {
                    return new Response(JSON.stringify(false), { status: 200 });
                }
                if (call.url.includes('/personal_agents?') && call.body?.telegram_connected === false) {
                    return new Response(JSON.stringify([{ id: agent.id, ...call.body }]), { status: 200 });
                }
                if (call.url.includes('/personal_agent_secrets?on_conflict=')) {
                    return new Response('', { status: 201 });
                }
                if (call.url.endsWith('/setWebhook')) {
                    webhookSecret = call.body.secret_token;
                    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
                }
                if (call.url.endsWith('/getWebhookInfo')) {
                    return new Response(JSON.stringify({
                        ok: true,
                        result: scenario.info(webhookSecret, token)
                    }), { status: 200 });
                }
                if (call.url.endsWith('/rpc/abort_personal_telegram_connect')) {
                    return new Response(JSON.stringify(true), { status: 200 });
                }
                throw new Error(`Unexpected URL: ${url}`);
            };

            try {
                await assert.rejects(
                    connectPersonalTelegram(agent, token, 'https://shaikh.digital'),
                    error => {
                        assert.equal(error.status, 503);
                        assert.match(error.message, /не подтвердил webhook/);
                        assert.ok(webhookSecret);
                        assert.equal(error.message.includes(token), false);
                        assert.equal(error.message.includes(webhookSecret), false);
                        return true;
                    }
                );
                assert.ok(calls.some(call => call.url.endsWith('/rpc/abort_personal_telegram_connect')));
                assert.equal(calls.some(call => call.body?.telegram_connected === true), false);
            } finally {
                globalThis.fetch = previousFetch;
            }
        });
    }
});

