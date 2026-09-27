import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://database.example';
process.env.SUPABASE_KEY = 'test-service-key';
process.env.AUTH_SECRET = 'local-control-test-secret';
process.env.WHATSAPP_DELIVERY_MODE = 'qr';
process.env.WHATSAPP_LOCAL_AGENT_ENABLED = 'true';
const { default: bridge } = await import('../server/api/whatsapp/bridge.js');
const { createSession } = await import('../server/api/_auth.js');
const { sanitizeRuntime, dashboardLocalStatus, configureLocalAgent, createLocalTest } = await import('../server/api/whatsapp/local-control.js');
const agent = { id: '00000000-0000-0000-0000-000000000001', name: 'Test', status: 'active', ai_enabled: true, project_id: 'project', connected: true };
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('owner controls and demo requests reject guests and manager sessions before database access', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('Must not access database'); };
    try {
        for (const action of ['configure', 'test_create', 'provider_key_set', 'provider_key_delete']) {
            const guest = response();
            await bridge({ method: 'POST', headers: {}, body: { action, agentId: agent.id } }, guest);
            assert.equal(guest.statusCode, 401);
            const manager = response();
            await bridge({ method: 'POST', headers: { cookie: `shaikh_session=${createSession({ id: 'manager', login: 'manager', role: 'manager' })}` }, body: { action, agentId: agent.id } }, manager);
            assert.equal(manager.statusCode, 403);
        }
    } finally { globalThis.fetch = original; }
});

test('stale connected badge cannot report ready or enqueue a demo on an offline Mac', async () => {
    const original = globalThis.fetch;
    let writes = 0;
    globalThis.fetch = async (url, options = {}) => {
        if (options.method) writes++;
        const rows = String(url).includes('/projects?') ? [{ knowledge: 'Approved facts' }] : [{
            state: 'connected', last_seen_at: new Date(Date.now() - 60000).toISOString(), config: {},
            runtime: { mode: 'local', enabled: true, ollama: true, models: ['qwen3.5:9b-mlx'] }
        }];
        return new Response(JSON.stringify(rows));
    };
    try {
        const status = await dashboardLocalStatus(agent);
        assert.equal(status.ready, false);
        assert.equal(status.checks.mac, false);
        await assert.rejects(createLocalTest(agent, { text: 'Test' }), /Запустите локальный сервер/);
        assert.equal(writes, 0);
    } finally { globalThis.fetch = original; }
});

test('runtime published to the UI contains only allowed status fields', () => {
    const result = sanitizeRuntime({ enabled: true, models: ['qwen3:1.7b', 'unapproved'], lastLatencyMs: 14200,
        secret: 'must-not-leak', messages: ['private'], qrImage: 'secret-qr' });
    assert.deepEqual(result.models, ['qwen3:1.7b']);
    assert.equal(result.lastLatencyMs, 14200);
    assert.equal(result.secret, undefined);
    assert.equal(result.messages, undefined);
    assert.equal(result.qrImage, undefined);
});

test('local controls validate models before writes and persist a new enable revision', async () => {
    const original = globalThis.fetch;
    const writes = [];
    globalThis.fetch = async (url, options = {}) => {
        if (options.method) {
            writes.push({ url: String(url), body: JSON.parse(options.body) });
            return new Response('[]');
        }
        return new Response(JSON.stringify(String(url).includes('/projects?')
            ? [{ knowledge: 'Approved facts' }] : [{ config: { model: 'qwen3:1.7b', enableRevision: 'old' } }]));
    };
    try {
        await assert.rejects(configureLocalAgent(agent, { model: 'unapproved' }), /Выберите одну/);
        assert.equal(writes.length, 0);
        await configureLocalAgent(agent, { enabled: true, model: 'llama3.1:8b' });
        const config = writes.find(write => write.body.config)?.body.config;
        assert.equal(config.model, 'llama3.1:8b');
        assert.equal(config.autoReplies, true);
        assert.notEqual(config.enableRevision, 'old');
        assert.ok(writes.some(write => write.body.ai_enabled === true));
    } finally { globalThis.fetch = original; }
});

test('a paused agent can run an isolated bounded demo using its selected model', async () => {
    const original = globalThis.fetch;
    let job;
    globalThis.fetch = async (url, options = {}) => {
        if (options.method === 'DELETE') return new Response('[]');
        if (options.method === 'POST') {
            assert.ok(String(url).includes('/local_agent_tests'));
            job = JSON.parse(options.body);
            return new Response(JSON.stringify([{ id: 'demo' }]));
        }
        return new Response(JSON.stringify(String(url).includes('/projects?') ? [{ knowledge: 'Approved facts' }] : [{
            state: 'connected', last_seen_at: new Date().toISOString(), config: { model: 'llama3.1:8b' },
            runtime: { mode: 'local', enabled: false, ollama: true, models: ['llama3.1:8b'] }
        }]));
    };
    try {
        await createLocalTest({ ...agent, status: 'paused', ai_enabled: false }, {
            text: 'Demo', history: [{ role: 'system', content: 'untrusted override' }, { role: 'user', content: 'Earlier' }]
        });
        assert.equal(job.model, 'llama3.1:8b');
        assert.deepEqual(job.input.history, [{ role: 'user', content: 'Earlier' }]);
        assert.ok(Date.parse(job.expires_at) > Date.now());
        assert.ok(Date.parse(job.expires_at) <= Date.now() + 180000);
    } finally { globalThis.fetch = original; }
});

test('cloud selection needs its own key but not local Ollama', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async url => {
        const path = String(url);
        if (path.includes('/projects?')) return new Response(JSON.stringify([{ knowledge: 'Approved facts' }]));
        if (path.includes('/agent_provider_keys?')) return new Response(JSON.stringify([{ agent_id: agent.id }]));
        return new Response(JSON.stringify([{ state: 'connected', last_seen_at: new Date().toISOString(),
            config: { provider: 'openrouter', cloudModel: 'openrouter/free' },
            runtime: { mode: 'local', enabled: true, ollama: false } }]));
    };
    try {
        const status = await dashboardLocalStatus(agent);
        assert.equal(status.provider, 'openrouter');
        assert.equal(status.model, 'openrouter/free');
        assert.equal(status.checks.ollama, true);
        assert.equal(status.checks.mac, true);
        assert.equal(status.ready, true);
        assert.equal(status.keyConfigured, true);
    } finally { globalThis.fetch = original; }
});
