import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://database.example';
process.env.SUPABASE_KEY = 'test-service-key';
process.env.WHATSAPP_DELIVERY_MODE = 'qr';
process.env.WHATSAPP_BRIDGE_SECRET = 'test-bridge-secret';

const { default: bridge } = await import('../server/api/whatsapp/bridge.js');
const { sendChannelMessage } = await import('../server/api/_agent/providers.js');
const agentId = '00000000-0000-0000-0000-000000000001';
const outboxId = '00000000-0000-0000-0000-000000000002';

function response() {
    return {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

test('QR worker selects its configured Sales Agent when multiple exist', async () => {
    const originalFetch = globalThis.fetch;
    let requestedPath = '';
    globalThis.fetch = async url => {
        requestedPath = new URL(url).search;
        return new Response(JSON.stringify([{ id: agentId, name: 'Selected Agent' }]), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });
    };
    try {
        const selected = response();
        await bridge({
            method: 'POST',
            headers: { 'x-whatsapp-bridge-secret': 'test-bridge-secret' },
            body: { action: 'bootstrap', agentId }
        }, selected);
        assert.equal(selected.statusCode, 200);
        assert.equal(selected.body.agentId, agentId);
        assert.match(requestedPath, /id=eq\./);
        assert.ok(requestedPath.includes(agentId));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('QR pairing cannot read, store or send customer messages before delivery is enabled', async () => {
    const originalFetch = globalThis.fetch;
    const previous = process.env.WHATSAPP_MESSAGE_DELIVERY_ENABLED;
    delete process.env.WHATSAPP_MESSAGE_DELIVERY_ENABLED;
    globalThis.fetch = async () => { throw new Error('Database must not be contacted'); };
    try {
        const inbound = response();
        await bridge({
            method: 'POST',
            headers: { 'x-whatsapp-bridge-secret': 'test-bridge-secret' },
            body: { action: 'inbound', agentId, from: '77771234567@s.whatsapp.net', text: 'Private customer message', messageId: 'msg-1' }
        }, inbound);
        assert.deepEqual(inbound.body, { ok: true, ignored: true });

        const poll = response();
        await bridge({
            method: 'POST',
            headers: { 'x-whatsapp-bridge-secret': 'test-bridge-secret' },
            body: { action: 'poll', agentId }
        }, poll);
        assert.deepEqual(poll.body, { ok: true, jobs: [] });

        await assert.rejects(sendChannelMessage({
            channel: 'whatsapp', agent: { id: agentId },
            recipientId: '77771234567@s.whatsapp.net', text: 'Do not send'
        }), /delivery is disabled/);
    } finally {
        globalThis.fetch = originalFetch;
        if (previous === undefined) delete process.env.WHATSAPP_MESSAGE_DELIVERY_ENABLED;
        else process.env.WHATSAPP_MESSAGE_DELIVERY_ENABLED = previous;
    }
});

test('local n8n context is released only for the configured, active, trained Sales Agent', async () => {
    const originalFetch = globalThis.fetch;
    const previous = process.env.WHATSAPP_LOCAL_AGENT_ENABLED;
    const paths = [];
    globalThis.fetch = async url => {
        const path = new URL(url).pathname + new URL(url).search;
        paths.push(path);
        const data = path.startsWith('/rest/v1/agents?select=*')
            ? [{ id: agentId, name: 'Шаихназар', platform: 'whatsapp', agent_type: 'sales', status: 'active', ai_enabled: true, connected: true, project_id: 'project-1' }]
            : path.startsWith('/rest/v1/projects?select=')
                ? [{ name: 'Компания', description: 'Описание', knowledge: 'Одобренный сценарий' }]
                : [];
        return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const request = { method: 'POST', headers: { 'x-whatsapp-bridge-secret': 'test-bridge-secret' }, body: { action: 'local_context', agentId } };
    try {
        delete process.env.WHATSAPP_LOCAL_AGENT_ENABLED;
        const blocked = response();
        await bridge(request, blocked);
        assert.deepEqual(blocked.body, { enabled: false });
        assert.equal(paths.some(path => path.startsWith('/rest/v1/projects?')), false);

        process.env.WHATSAPP_LOCAL_AGENT_ENABLED = 'true';
        const enabled = response();
        await bridge(request, enabled);
        assert.equal(enabled.body.enabled, true);
        assert.match(enabled.body.knowledge, /Одобренный сценарий/);
        assert.equal(enabled.body.name, 'Шаихназар');

        globalThis.fetch = async url => {
            const path = new URL(url).pathname + new URL(url).search;
            const data = path.startsWith('/rest/v1/agents?select=*')
                ? [{ id: agentId, name: 'Шаихназар', platform: 'whatsapp', agent_type: 'sales', status: 'active', ai_enabled: true, connected: true, project_id: 'project-1' }]
                : [{ name: 'Компания', description: 'Описание', knowledge: '' }];
            return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        const untrained = response();
        await bridge(request, untrained);
        assert.deepEqual(untrained.body, { enabled: false });
    } finally {
        globalThis.fetch = originalFetch;
        if (previous === undefined) delete process.env.WHATSAPP_LOCAL_AGENT_ENABLED;
        else process.env.WHATSAPP_LOCAL_AGENT_ENABLED = previous;
    }
});

test('QR bridge queues, claims and acknowledges a message without a Meta token', async () => {
    const originalFetch = globalThis.fetch;
    const previous = process.env.WHATSAPP_MESSAGE_DELIVERY_ENABLED;
    process.env.WHATSAPP_MESSAGE_DELIVERY_ENABLED = 'true';
    const paths = [];
    globalThis.fetch = async (url, options = {}) => {
        const parsed = new URL(url);
        const path = parsed.pathname + parsed.search;
        paths.push({ path, method: options.method || 'GET' });
        let body = null;
        if (path.startsWith('/rest/v1/agents?select=*')) body = [{ id: agentId, platform: 'whatsapp', agent_type: 'sales' }];
        else if (path === '/rest/v1/whatsapp_outbox' && options.method === 'POST') body = [{ id: outboxId }];
        else if (path.startsWith('/rest/v1/whatsapp_outbox?select=id,recipient_id')) {
            body = [{ id: outboxId, recipient_id: '77771234567@s.whatsapp.net', body: 'Привет', attempts: 0, task_id: null }];
        } else if (path.startsWith('/rest/v1/whatsapp_outbox?id=') && options.method === 'PATCH') {
            body = [{ id: outboxId }];
        } else if (path.startsWith('/rest/v1/whatsapp_outbox?select=id,attempts')) {
            body = [{ id: outboxId, attempts: 1, task_id: null }];
        }
        return new Response(body === null ? '' : JSON.stringify(body), {
            status: options.method === 'POST' ? 201 : 200,
            headers: { 'content-type': 'application/json' }
        });
    };
    try {
        const queued = await sendChannelMessage({
            channel: 'whatsapp', agent: { id: agentId },
            recipientId: '77771234567@s.whatsapp.net', text: 'Привет'
        });
        assert.equal(queued.queued, true);
        assert.equal(queued.outboxId, outboxId);

        const poll = response();
        await bridge({ method: 'POST', headers: { 'x-whatsapp-bridge-secret': 'test-bridge-secret' }, body: { action: 'poll', agentId } }, poll);
        assert.equal(poll.statusCode, 200);
        assert.deepEqual(poll.body.jobs, [{ id: outboxId, recipientId: '77771234567@s.whatsapp.net', text: 'Привет' }]);

        const ack = response();
        await bridge({ method: 'POST', headers: { 'x-whatsapp-bridge-secret': 'test-bridge-secret' }, body: { action: 'ack', agentId, id: outboxId, sent: true, messageId: 'wamid.test' } }, ack);
        assert.equal(ack.statusCode, 200);
        assert.equal(ack.body.ok, true);
        assert.ok(paths.some(item => item.path === '/rest/v1/whatsapp_outbox' && item.method === 'POST'));
    } finally {
        globalThis.fetch = originalFetch;
        if (previous === undefined) delete process.env.WHATSAPP_MESSAGE_DELIVERY_ENABLED;
        else process.env.WHATSAPP_MESSAGE_DELIVERY_ENABLED = previous;
    }
});
