import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.AUTH_SECRET = 'legacy-dashboard-access-test-secret';

const { createSession } = await import('../server/api/_auth.js');
const { default: customerState } = await import('../server/api/customers/state.js');
const { default: sendMessage } = await import('../server/api/messages/send.js');

const IDS = {
    owner: '11111111-1111-4111-8111-111111111111',
    manager: '22222222-2222-4222-8222-222222222222',
    client: '33333333-3333-4333-8333-333333333333',
    agent: '44444444-4444-4444-8444-444444444444',
    customer: '55555555-5555-4555-8555-555555555555'
};

function cookieFor(id, login, role) {
    const token = createSession({ id, login, role });
    return `shaikh_session=${encodeURIComponent(token)}`;
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

test('client session cannot reach a legacy message route', async () => {
    const previousFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        throw new Error('client must be rejected before database or provider access');
    };
    try {
        const res = response();
        await sendMessage({
            method: 'POST',
            headers: { cookie: cookieFor(IDS.client, 'client-one', 'client') },
            body: { id: IDS.agent, chatId: '777', text: 'must not send' }
        }, res);
        assert.equal(res.statusCode, 403);
        assert.equal(res.body.error, 'Dashboard access required');
        assert.equal(fetchCalls, 0);
    } finally { globalThis.fetch = previousFetch; }
});

test('disabled manager session is rejected before legacy customer data is read', async () => {
    const previousFetch = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async url => {
        urls.push(String(url));
        return new Response(JSON.stringify([{
            id: IDS.manager,
            login: 'manager-one',
            role: 'manager',
            disabled_at: '2026-10-23T00:00:00.000Z'
        }]), { status: 200 });
    };
    try {
        const res = response();
        await customerState({
            method: 'GET',
            headers: { cookie: cookieFor(IDS.manager, 'manager-one', 'manager') },
            query: { agentId: IDS.agent, channel: 'telegram', chatId: '777' }
        }, res);
        assert.equal(res.statusCode, 403);
        assert.equal(res.body.error, 'Account access is suspended');
        assert.equal(urls.length, 1);
        assert.match(urls[0], /managers_auth\?select=id,login,role,disabled_at/);
    } finally { globalThis.fetch = previousFetch; }
});

test('active owner and manager sessions can reach a legacy customer route', async () => {
    const previousFetch = globalThis.fetch;
    try {
        for (const account of [
            { id: IDS.owner, login: 'owner-one', role: 'owner' },
            { id: IDS.manager, login: 'manager-one', role: 'manager' }
        ]) {
            const urls = [];
            globalThis.fetch = async url => {
                const requestUrl = String(url);
                urls.push(requestUrl);
                if (requestUrl.includes('/managers_auth?')) {
                    return new Response(JSON.stringify([{ ...account, disabled_at: null }]), { status: 200 });
                }
                if (requestUrl.includes('/customers?')) {
                    return new Response(JSON.stringify([{
                        id: IDS.customer,
                        agent_id: IDS.agent,
                        channel: 'telegram',
                        external_id: '777',
                        handoff_status: 'ai',
                        ai_enabled: true
                    }]), { status: 200 });
                }
                throw new Error(`Unexpected URL: ${requestUrl}`);
            };

            const res = response();
            await customerState({
                method: 'GET',
                headers: { cookie: cookieFor(account.id, account.login, account.role) },
                query: { agentId: IDS.agent, channel: 'telegram', chatId: '777' }
            }, res);
            assert.equal(res.statusCode, 200);
            assert.equal(res.body.customer.id, IDS.customer);
            assert.equal(urls.length, 2);
        }
    } finally { globalThis.fetch = previousFetch; }
});
