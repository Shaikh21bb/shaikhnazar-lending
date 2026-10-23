import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.AUTH_SECRET = 'legacy-data-test-secret';
process.env.NODE_ENV = 'test';

const { createSession } = await import('../server/api/_auth.js');
const { default: legacyData } = await import('../server/api/legacy/data.js');

const IDS = {
    owner: '11111111-1111-4111-8111-111111111111',
    account: '22222222-2222-4222-8222-222222222222',
    manager: '33333333-3333-4333-8333-333333333333',
    agent: '44444444-4444-4444-8444-444444444444',
    task: '55555555-5555-4555-8555-555555555555'
};

function cookieFor({ id, login, role }) {
    const token = createSession({ id, login, role });
    return `shaikh_session=${encodeURIComponent(token)}`;
}

function request(account, body, headers = {}) {
    return {
        method: 'POST',
        headers: {
            cookie: cookieFor(account),
            ...headers
        },
        body
    };
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

function activeAccount(account, managerId = null) {
    return {
        id: account.id,
        login: account.login,
        role: account.role,
        disabled_at: null,
        manager_id: managerId
    };
}

const owner = { id: IDS.owner, login: 'Shaikh', role: 'owner' };
const manager = { id: IDS.account, login: 'manager-one', role: 'manager' };
const sameOrigin = {
    origin: 'https://shaikh.example',
    host: 'shaikh.example',
    'x-forwarded-proto': 'https'
};

test('owner selects only allowlisted agent fields and response sanitization removes secrets', async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (String(url).includes('/managers_auth?')) {
            return new Response(JSON.stringify([activeAccount(owner)]), { status: 200 });
        }
        return new Response(JSON.stringify([{
            id: IDS.agent,
            name: 'Sales bot',
            token: 'must-not-leak',
            webhook_secret: 'must-not-leak-either',
            metadata: { telegram_connection_nonce: 'nested-secret', safe: true }
        }]), {
            status: 200,
            headers: { 'Content-Range': '0-0/1' }
        });
    };
    try {
        const res = response();
        await legacyData(request(owner, {
            table: 'agents',
            operation: 'select',
            columns: '*',
            filters: [],
            orders: [{ column: 'created_at', ascending: false }],
            limit: 20,
            count: 'exact',
            head: false,
            payload: null,
            returning: false
        }), res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.body.error, null);
        assert.equal(res.body.count, 1);
        assert.deepEqual(res.body.data, [{
            id: IDS.agent,
            name: 'Sales bot'
        }]);
        const dataCall = calls.at(-1);
        const url = new URL(dataCall.url);
        const selected = url.searchParams.get('select').split(',');
        assert.ok(selected.includes('id'));
        assert.ok(selected.includes('ai_enabled'));
        assert.ok(!selected.includes('token'));
        assert.ok(!selected.some(column => column.includes('webhook')));
        assert.equal(url.searchParams.get('order'), 'created_at.desc');
        assert.equal(url.searchParams.get('limit'), '20');
        assert.equal(dataCall.options.headers.Prefer, 'count=exact');
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('secret columns cannot be selected or used as filters', async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async url => {
        calls += 1;
        assert.match(String(url), /\/managers_auth\?/);
        return new Response(JSON.stringify([activeAccount(owner)]), { status: 200 });
    };
    try {
        for (const body of [
            { table: 'agents', operation: 'select', columns: 'id,token' },
            {
                table: 'agents', operation: 'select', columns: 'id',
                filters: [{ column: 'webhook_secret_hash', operator: 'eq', value: 'guess' }]
            }
        ]) {
            const res = response();
            await legacyData(request(owner, body), res);
            assert.equal(res.statusCode, 400);
            assert.equal(typeof res.body.error, 'string');
        }
        assert.equal(calls, 2, 'only the two account validation requests are allowed');
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('owner can submit an agent token but returning never exposes it', async () => {
    const previousFetch = globalThis.fetch;
    let databaseCall;
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).includes('/managers_auth?')) {
            return new Response(JSON.stringify([activeAccount(owner)]), { status: 200 });
        }
        databaseCall = { url: String(url), options };
        return new Response(JSON.stringify([{
            id: IDS.agent,
            name: 'Telegram bot',
            token: 'echoed-secret',
            webhook_secret_hash: 'echoed-hash'
        }]), { status: 201 });
    };
    try {
        const res = response();
        await legacyData(request(owner, {
            table: 'agents',
            operation: 'insert',
            columns: '*',
            filters: [],
            orders: [],
            limit: null,
            count: null,
            head: false,
            payload: {
                name: 'Telegram bot',
                platform: 'telegram',
                token: '123456789:provider-secret'
            },
            returning: true
        }, sameOrigin), res);

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, {
            data: [{ id: IDS.agent, name: 'Telegram bot' }],
            error: null
        });
        assert.equal(databaseCall.options.method, 'POST');
        assert.equal(databaseCall.options.headers.Prefer, 'return=representation');
        assert.equal(JSON.parse(databaseCall.options.body).token, '123456789:provider-secret');
        assert.ok(!new URL(databaseCall.url).searchParams.get('select').split(',').includes('token'));
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('mutations require same-origin and update/delete require caller filters', async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async url => {
        calls += 1;
        assert.match(String(url), /\/managers_auth\?/);
        return new Response(JSON.stringify([activeAccount(owner)]), { status: 200 });
    };
    try {
        const crossOrigin = response();
        await legacyData(request(owner, {
            table: 'tasks',
            operation: 'update',
            filters: [{ column: 'id', operator: 'eq', value: IDS.task }],
            payload: { status: 'done' }
        }, {
            origin: 'https://attacker.example',
            host: 'shaikh.example',
            'x-forwarded-proto': 'https'
        }), crossOrigin);
        assert.equal(crossOrigin.statusCode, 403);
        assert.equal(crossOrigin.body.error, 'Origin check failed');

        const unfiltered = response();
        await legacyData(request(owner, {
            table: 'tasks',
            operation: 'delete',
            filters: []
        }, sameOrigin), unfiltered);
        assert.equal(unfiltered.statusCode, 400);
        assert.match(unfiltered.body.error, /require filters/);
        assert.equal(calls, 2, 'no data mutation may run after either rejection');
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('manager task reads are forced to the linked chat scope', async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        const requestUrl = String(url);
        calls.push({ url: requestUrl, options });
        if (requestUrl.includes('select=id,login,role,disabled_at')) {
            return new Response(JSON.stringify([activeAccount(manager, IDS.manager)]), { status: 200 });
        }
        if (requestUrl.includes('select=manager_id')) {
            return new Response(JSON.stringify({ message: 'column manager_id does not exist' }), { status: 400 });
        }
        if (requestUrl.includes('/managers?')) {
            return new Response(JSON.stringify([{
                id: IDS.manager,
                name: 'manager-one',
                chat_id: '777001',
                agent_id: IDS.agent
            }]), { status: 200 });
        }
        return new Response(JSON.stringify([{ id: IDS.task, title: 'Scoped task' }]), { status: 200 });
    };
    try {
        const res = response();
        await legacyData(request(manager, {
            table: 'tasks',
            operation: 'select',
            columns: 'id,title,chat_id',
            filters: [{ column: 'id', operator: 'eq', value: IDS.task }]
        }), res);

        assert.equal(res.statusCode, 200);
        const dataUrl = new URL(calls.at(-1).url);
        assert.equal(dataUrl.pathname, '/rest/v1/tasks');
        assert.equal(dataUrl.searchParams.get('id'), `eq.${IDS.task}`);
        assert.equal(dataUrl.searchParams.get('chat_id'), 'eq.777001');
        assert.equal(dataUrl.searchParams.get('agent_id'), `eq.${IDS.agent}`);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('manager client history is selected only for the explicitly linked agent', async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        const requestUrl = String(url);
        calls.push({ url: requestUrl, options });
        if (requestUrl.includes('select=id,login,role,disabled_at')) {
            return new Response(JSON.stringify([activeAccount(manager, IDS.manager)]), { status: 200 });
        }
        if (requestUrl.includes('select=manager_id')) {
            return new Response(JSON.stringify([{ manager_id: IDS.manager }]), { status: 200 });
        }
        if (requestUrl.includes('/managers?')) {
            return new Response(JSON.stringify([{
                id: IDS.manager,
                name: 'manager-one',
                chat_id: '777001',
                agent_id: IDS.agent
            }]), { status: 200 });
        }
        return new Response(JSON.stringify([{
            agent_id: IDS.agent,
            chat_id: 'client-1',
            text: 'Scoped message',
            role: 'user'
        }]), { status: 200 });
    };
    try {
        const res = response();
        await legacyData(request(manager, {
            table: 'agent_chats',
            operation: 'select',
            columns: 'agent_id,chat_id,text,role,created_at',
            orders: [{ column: 'created_at', ascending: false }],
            limit: 600
        }), res);

        assert.equal(res.statusCode, 200);
        const dataUrl = new URL(calls.at(-1).url);
        assert.equal(dataUrl.pathname, '/rest/v1/agent_chats');
        assert.equal(dataUrl.searchParams.get('agent_id'), `eq.${IDS.agent}`);

        const escaped = response();
        await legacyData(request(manager, {
            table: 'agent_chats',
            operation: 'select',
            columns: 'agent_id,chat_id,text',
            filters: [{ column: 'agent_id', operator: 'eq', value: IDS.owner }]
        }), escaped);
        assert.equal(escaped.statusCode, 403);
        assert.match(escaped.body.error, /outside the manager scope/);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('manager assignment is fail-closed after migration and for ambiguous legacy names', async () => {
    const previousFetch = globalThis.fetch;
    try {
        globalThis.fetch = async url => {
            const requestUrl = String(url);
            if (requestUrl.includes('select=id,login,role,disabled_at')) {
                return new Response(JSON.stringify([activeAccount(manager)]), { status: 200 });
            }
            if (requestUrl.includes('select=manager_id')) {
                return new Response(JSON.stringify([{ manager_id: null }]), { status: 200 });
            }
            throw new Error(`Unexpected request: ${requestUrl}`);
        };
        const unassigned = response();
        await legacyData(request(manager, {
            table: 'tasks', operation: 'select', columns: 'id,title'
        }), unassigned);
        assert.equal(unassigned.statusCode, 403);
        assert.match(unassigned.body.error, /assignment required/);

        globalThis.fetch = async url => {
            const requestUrl = String(url);
            if (requestUrl.includes('select=id,login,role,disabled_at')) {
                return new Response(JSON.stringify([activeAccount(manager)]), { status: 200 });
            }
            if (requestUrl.includes('select=manager_id')) {
                return new Response(JSON.stringify({
                    code: 'PGRST204', message: "Could not find the 'manager_id' column"
                }), { status: 400 });
            }
            if (requestUrl.includes('/managers?')) {
                return new Response(JSON.stringify([
                    { id: IDS.manager, name: 'manager-one', chat_id: '1', agent_id: IDS.agent },
                    { id: IDS.owner, name: ' Manager-One ', chat_id: '2', agent_id: IDS.owner }
                ]), { status: 200 });
            }
            throw new Error(`Unexpected request: ${requestUrl}`);
        };
        const ambiguous = response();
        await legacyData(request(manager, {
            table: 'tasks', operation: 'select', columns: 'id,title'
        }), ambiguous);
        assert.equal(ambiguous.statusCode, 403);
        assert.match(ambiguous.body.error, /assignment required/);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('manager task mutations cannot escape or replace their assignment', async () => {
    const previousFetch = globalThis.fetch;
    let savedPayload;
    globalThis.fetch = async (url, options = {}) => {
        const requestUrl = String(url);
        if (requestUrl.includes('select=id,login,role,disabled_at')) {
            return new Response(JSON.stringify([activeAccount(manager, IDS.manager)]), { status: 200 });
        }
        if (requestUrl.includes('select=manager_id')) {
            return new Response(JSON.stringify([{ manager_id: IDS.manager }]), { status: 200 });
        }
        if (requestUrl.includes('/managers?')) {
            return new Response(JSON.stringify([{
                id: IDS.manager,
                name: 'manager-one',
                chat_id: '777001',
                agent_id: IDS.agent
            }]), { status: 200 });
        }
        savedPayload = JSON.parse(options.body);
        return new Response(JSON.stringify([{ id: IDS.task, ...savedPayload }]), { status: 201 });
    };
    try {
        const inserted = response();
        await legacyData(request(manager, {
            table: 'tasks',
            operation: 'insert',
            columns: 'id,title,manager,chat_id,agent_id',
            payload: { title: 'My task' },
            returning: true
        }, sameOrigin), inserted);
        assert.equal(inserted.statusCode, 200);
        assert.deepEqual(savedPayload, {
            title: 'My task',
            chat_id: '777001',
            manager: 'manager-one',
            agent_id: IDS.agent
        });

        const escaped = response();
        await legacyData(request(manager, {
            table: 'tasks',
            operation: 'update',
            filters: [{ column: 'id', operator: 'eq', value: IDS.task }],
            payload: { status: 'done', chat_id: 'attacker-chat' }
        }, sameOrigin), escaped);
        assert.equal(escaped.statusCode, 403);
        assert.match(escaped.body.error, /outside the manager scope/);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('manager cannot access owner projects or mutate the assigned agent', async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async url => {
        calls += 1;
        assert.match(String(url), /\/managers_auth\?/);
        return new Response(JSON.stringify([activeAccount(manager, IDS.manager)]), { status: 200 });
    };
    try {
        const projects = response();
        await legacyData(request(manager, {
            table: 'projects',
            operation: 'select',
            columns: 'id,name'
        }), projects);
        assert.equal(projects.statusCode, 403);

        const agents = response();
        await legacyData(request(manager, {
            table: 'agents',
            operation: 'update',
            filters: [{ column: 'id', operator: 'eq', value: IDS.agent }],
            payload: { status: 'paused' }
        }, sameOrigin), agents);
        assert.equal(agents.statusCode, 403);
        assert.equal(calls, 2, 'denied requests stop before manager or data lookups');
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('server-only migration drops all legacy policies and revokes browser roles', async () => {
    const source = await readFile(
        new URL('../supabase/migrations/20261023231000_legacy_dashboard_server_only.sql', import.meta.url),
        'utf8'
    );
    for (const table of ['agents', 'projects', 'agent_chats', 'managers', 'tasks', 'scripts', 'meta', 'sessions']) {
        assert.match(source, new RegExp(`'${table}'`));
    }
    assert.match(source, /DROP POLICY IF EXISTS %I ON public\.%I/);
    assert.match(source, /REVOKE ALL PRIVILEGES ON TABLE public\.%I FROM PUBLIC, anon, authenticated/);
    assert.match(source, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.%I TO service_role/);
    assert.match(source, /ADD COLUMN IF NOT EXISTS manager_id uuid REFERENCES public\.managers\(id\)/);
    assert.match(source, /REVOKE ALL ON FUNCTION public\.enforce_global_telegram_bot_id\(\)/);
    assert.doesNotMatch(source, /CREATE POLICY/i);
});

test('the single API function registers the legacy data proxy', async () => {
    const source = await readFile(new URL('../api/index.js', import.meta.url), 'utf8');
    assert.match(source, /import legacyData from '\.\.\/server\/api\/legacy\/data\.js'/);
    assert.match(source, /\['legacy\/data', legacyData\]/);
});
