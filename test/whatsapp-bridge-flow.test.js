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

test('QR bridge queues, claims and acknowledges a message without a Meta token', async () => {
    const originalFetch = globalThis.fetch;
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
    }
});
