import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.SUPABASE_URL = 'https://reliability-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-key';
process.env.AUTH_SECRET = 'synthetic-workspace-auth-secret-for-tests';

const { workspaceDeviceMutation, workspaceMutation, workspaceOverview } = await import('../server/api/_agent/workspace.js');

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ROOT = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const OTHER_AGENT = '55555555-5555-4555-8555-555555555555';
const root = { id: ROOT, account_id: ACCOUNT };
const device = { id: DEVICE, root_id: ROOT };
const session = { sub: ACCOUNT, role: 'client', login: 'synthetic-client' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function accountLookup(url) {
    if (url.includes('/managers_auth?')) return json([{ id: ACCOUNT, login: session.login, role: 'client' }]);
    if (url.includes('/personal_agents?')) return json([root]);
    return null;
}

async function mockFetch(implementation, run) {
    const previous = globalThis.fetch;
    globalThis.fetch = implementation;
    try { return await run(); }
    finally { globalThis.fetch = previous; }
}

test('a partial WhatsApp transport update preserves model and Telegram capabilities through the atomic RPC', async () => {
    const current = { model: 'qwen-local', status: { state: 'model_offline', whatsapp: 'disconnected', modelReady: false, telegramDialogue: true, telegramVoice: true } };
    let request;
    await mockFetch(async (input, options) => {
        assert.match(String(input), /\/rpc\/workspace_patch_runtime$/);
        assert.equal(options.method, 'POST');
        request = JSON.parse(options.body);
        Object.assign(current.status, request.p_status);
        if (request.p_model !== null) current.model = request.p_model;
        return json(true);
    }, async () => {
        await workspaceDeviceMutation({ root, device }, { action: 'runtime', status: { whatsapp: 'connected' } });
    });
    assert.deepEqual(request, { p_device_id: DEVICE, p_root_id: ROOT, p_status: { whatsapp: 'connected' }, p_model: null });
    assert.equal(current.model, 'qwen-local');
    assert.deepEqual(current.status, { state: 'model_offline', whatsapp: 'connected', modelReady: false, telegramDialogue: true, telegramVoice: true });
});

test('partial runtime payloads omit invalid or private fields and explicit dialogue false also disables voice', async () => {
    const patches = [];
    await mockFetch(async (_input, options) => { patches.push(JSON.parse(options.body)); return json(true); }, async () => {
        await workspaceDeviceMutation({ root, device }, {
            action: 'runtime', model: 'https://private.invalid/SECRET',
            status: { state: 'SECRET', whatsapp: 'SECRET', modelReady: 'true', telegramDialogue: 'true', telegramVoice: 'true', vaultText: 'SECRET' }
        });
        await workspaceDeviceMutation({ root, device }, { action: 'runtime', status: { telegramDialogue: false, telegramVoice: true } });
        await workspaceDeviceMutation({ root, device }, { action: 'runtime', model: '' });
    });
    assert.deepEqual(patches[0].p_status, {});
    assert.equal(patches[0].p_model, null);
    assert.equal(JSON.stringify(patches).includes('SECRET'), false);
    assert.deepEqual(patches[1].p_status, { telegramDialogue: false, telegramVoice: false });
    assert.equal(patches[2].p_model, '', 'empty model is an explicit clear, unlike omitted/null');
});

test('a full poll retains model_offline and replaces capabilities only from explicit booleans', async () => {
    let patch;
    await mockFetch(async (input, options = {}) => {
        const url = String(input);
        if (options.method === 'PATCH') { patch = JSON.parse(options.body); return json(null); }
        if (url.includes('/rpc/workspace_claim_jobs') || url.includes('/workspace_agents?')) return json([]);
        throw new Error('Unexpected request');
    }, async () => {
        await workspaceDeviceMutation({ root, device }, { action: 'poll', status: {
            state: 'model_offline', modelReady: true, model: 'qwen-local', whatsapp: 'paused', telegramDialogue: true, telegramVoice: 'true', privateText: 'SECRET'
        } });
    });
    assert.equal(patch.status.state, 'model_offline');
    assert.equal(patch.status.modelReady, false);
    assert.equal(patch.status.telegramDialogue, true);
    assert.equal(patch.status.telegramVoice, false);
    assert.equal(patch.model, 'qwen-local');
    assert.equal(JSON.stringify(patch).includes('SECRET'), false);
});

test('an atomic runtime patch cannot revive a revoked or mismatched device', async () => {
    await mockFetch(async () => json(false), async () => {
        await assert.rejects(workspaceDeviceMutation({ root, device }, { action: 'runtime', status: { whatsapp: 'connected' } }), error => error.status === 401);
    });
});

test('a second enabled WhatsApp agent receives a friendly conflict before any write', async () => {
    let writes = 0;
    await mockFetch(async (input, options = {}) => {
        const url = String(input);
        const account = accountLookup(url); if (account) return account;
        if (options.method) { writes += 1; throw new Error('Conflicting agent must not be written'); }
        if (url.includes('enabled=eq.true')) {
            assert.match(url, new RegExp(`root_id=eq\\.${ROOT}`));
            assert.match(url, new RegExp(`id=neq\\.${AGENT}`));
            return json([{ id: OTHER_AGENT }]);
        }
        if (url.includes('/workspace_agents?')) return json([{ id: AGENT, type: 'whatsapp', name: 'Saved assistant', enabled: false }]);
        throw new Error('Unexpected request');
    }, async () => {
        await assert.rejects(workspaceMutation(session, { action: 'update_agent', id: AGENT, agent: { enabled: true } }), error => error.status === 409 && /Сначала остановите/.test(error.message));
    });
    assert.equal(writes, 0);
});

test('a database uniqueness race becomes the same stable WhatsApp activation conflict', async () => {
    await mockFetch(async (input, options = {}) => {
        const url = String(input);
        const account = accountLookup(url); if (account) return account;
        if (options.method === 'PATCH') return json({ code: '23505', message: 'DATABASE DETAIL MUST STAY PRIVATE' }, 409);
        if (url.includes('enabled=eq.true')) return json([]);
        if (url.includes('/workspace_agents?')) return json([{ id: AGENT, type: 'whatsapp', name: 'Saved assistant', enabled: false }]);
        throw new Error('Unexpected request');
    }, async () => {
        await assert.rejects(workspaceMutation(session, { action: 'update_agent', id: AGENT, agent: { enabled: true } }), error => error.status === 409 && /WhatsApp/.test(error.message) && !/DATABASE/.test(error.message));
    });
});

test('new WhatsApp agents stay disabled even when another assistant is active and the caller requests activation', async () => {
    let created;
    await mockFetch(async (input, options = {}) => {
        const url = String(input);
        const account = accountLookup(url); if (account) return account;
        if (options.method === 'POST') { created = JSON.parse(options.body); return json([{ id: AGENT, ...created }]); }
        if (url.includes('/workspace_agents?')) return json([{ id: OTHER_AGENT, type: 'whatsapp', name: 'Current', enabled: true }]);
        throw new Error('Unexpected request');
    }, async () => {
        const result = await workspaceMutation(session, { action: 'create_agent', agent: { name: 'New assistant', type: 'whatsapp', enabled: true, root_id: OTHER_AGENT } });
        assert.equal(result.agent.enabled, false);
    });
    assert.equal(created.enabled, false);
    assert.equal(created.root_id, ROOT);
});

test('disabling an existing WhatsApp agent remains possible even when an old duplicate exists', async () => {
    let preflight = false;
    await mockFetch(async (input, options = {}) => {
        const url = String(input);
        const account = accountLookup(url); if (account) return account;
        if (url.includes('enabled=eq.true')) { preflight = true; return json([{ id: OTHER_AGENT }]); }
        if (options.method === 'PATCH') return json([{ id: AGENT, name: 'Current', type: 'whatsapp', ...JSON.parse(options.body) }]);
        if (url.includes('/workspace_agents?')) return json([{ id: AGENT, type: 'whatsapp', name: 'Current', enabled: true }]);
        throw new Error('Unexpected request');
    }, async () => {
        const result = await workspaceMutation(session, { action: 'update_agent', id: AGENT, agent: { enabled: false } });
        assert.equal(result.agent.enabled, false);
    });
    assert.equal(preflight, false);
});

function overviewStorage(approvals, queries) {
    return async input => {
        const url = new URL(String(input));
        queries.push(url);
        const account = accountLookup(url.href); if (account) return account;
        if (url.pathname.endsWith('/workspace_devices')) return json([]);
        if (url.pathname.endsWith('/workspace_agents')) return json([{ id: AGENT, name: 'Personal', type: 'personal', enabled: true }]);
        if (url.pathname.endsWith('/workspace_jobs') || url.pathname.endsWith('/workspace_reminders')) return json([]);
        if (url.pathname.endsWith('/workspace_approvals')) {
            assert.equal(url.searchParams.get('root_id'), `eq.${ROOT}`);
            const active = url.searchParams.get('status') === 'eq.pending';
            const cutoff = Date.parse(active ? url.searchParams.get('expires_at').slice(3) : url.searchParams.get('or').match(/expires_at\.lte\.([^)]*)/)[1]);
            const rows = approvals.filter(item => active ? item.status === 'pending' && Date.parse(item.expires_at) > cutoff : item.status !== 'pending' || Date.parse(item.expires_at) <= cutoff);
            assert.equal(url.searchParams.get('order'), active ? 'created_at.asc,id.asc' : 'activity_at.desc,id.desc');
            const activity = item => Math.max(...['activity_at', 'created_at', 'decided_at', 'delivered_at'].map(field => Date.parse(item[field])).filter(Number.isFinite));
            rows.sort((a, b) => active ? a.created_at.localeCompare(b.created_at) : activity(b) - activity(a));
            const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit'));
            return json(rows.slice(offset, offset + limit));
        }
        throw new Error('Unexpected overview request');
    };
}

test('an actionable approval older than 60 completed rows remains visible and expired pending appears in history', async () => {
    const now = Date.now();
    const pending = { id: 'old-pending', status: 'pending', created_at: new Date(now - 3600000).toISOString(), expires_at: new Date(now + 3600000).toISOString() };
    const approvals = [pending, ...Array.from({ length: 60 }, (_, index) => ({ id: `sent-${index}`, status: 'sent', created_at: new Date(now - 60000 - index).toISOString(), expires_at: new Date(now + 3600000).toISOString() })),
        { id: 'expired-pending', status: 'pending', created_at: new Date(now).toISOString(), expires_at: new Date(now - 1).toISOString() },
        { id: 'expired-offset', status: 'pending', created_at: new Date(now + 1).toISOString(), expires_at: new Date(now + 5 * 3600000 - 1000).toISOString().replace('Z', '+05:00') }];
    const queries = [];
    await mockFetch(overviewStorage(approvals, queries), async () => {
        const result = await workspaceOverview(session);
        assert.deepEqual(result.approvals.map(item => item.id), ['old-pending']);
        assert.equal(result.approvalHistory.length, 60);
        assert.equal(result.approvalHistory.find(item => item.id === 'expired-pending').status, 'expired');
        assert.equal(result.approvalHistory.find(item => item.id === 'expired-offset').status, 'expired');
        assert.equal(result.approvalHistory.some(item => item.id === 'old-pending'), false);
        assert.deepEqual(result.approvalPage, { offset: 0, limit: 250, hasMore: false });
    });
    assert.equal(queries.filter(url => url.pathname.endsWith('/workspace_approvals')).length, 2);
});

test('pending approval pages expose overflow and the next page without mixing in history', async () => {
    const now = Date.now();
    const approvals = Array.from({ length: 251 }, (_, index) => ({ id: `pending-${index}`, status: 'pending', created_at: new Date(now + index).toISOString(), expires_at: new Date(now + 3600000).toISOString() }));
    await mockFetch(overviewStorage(approvals, []), async () => {
        const first = await workspaceOverview(session);
        assert.equal(first.approvals.length, 250); assert.equal(first.approvalPage.hasMore, true);
        const next = await workspaceOverview(session, { approvalOffset: '250' });
        assert.deepEqual(next.approvals.map(item => item.id), ['pending-250']);
        assert.deepEqual(next.approvalPage, { offset: 250, limit: 250, hasMore: false });
        assert.deepEqual(next.approvalHistory, []);
    });
    await mockFetch(async () => { throw new Error('Invalid page must not reach storage'); }, async () => {
        for (const approvalOffset of [-1, 1.5, 'bad', Number.MAX_SAFE_INTEGER]) {
            await assert.rejects(workspaceOverview(session, { approvalOffset }), error => error.status === 400);
        }
    });
});

test('recent decisions and deliveries remain in history when the original approval predates 60 newer messages', async () => {
    const now = Date.now();
    const recent = Array.from({ length: 60 }, (_, index) => ({
        id: `recent-${index}`, status: 'sent', created_at: new Date(now - 60000 - index).toISOString(),
        delivered_at: new Date(now - 30000 - index).toISOString(), expires_at: new Date(now + 3600000).toISOString()
    }));
    const old = {
        id: 'old-message-recent-decision', status: 'approved', created_at: new Date(now - 3600000).toISOString(),
        decided_at: new Date(now).toISOString(), delivered_at: null, activity_at: new Date(now).toISOString(),
        expires_at: new Date(now + 3600000).toISOString()
    };
    await mockFetch(overviewStorage([...recent, old], []), async () => {
        const approved = await workspaceOverview(session);
        assert.equal(approved.approvalHistory.length, 60);
        assert.equal(approved.approvalHistory[0].id, old.id);
        assert.equal(approved.approvalHistory[0].status, 'approved');

        old.status = 'sent';
        old.delivered_at = new Date(now + 1000).toISOString();
        old.activity_at = old.delivered_at;
        const delivered = await workspaceOverview(session);
        assert.equal(delivered.approvalHistory[0].id, old.id);
        assert.equal(delivered.approvalHistory[0].status, 'sent');
        assert.equal(delivered.approvalHistory[0].activity_at, old.delivered_at);
    });
});

test('expired approved replies are shown as expired without relabeling dispatching or terminal delivery states', async () => {
    const now = Date.now();
    const approvals = ['approved', 'sent', 'dispatching', 'uncertain'].map((status, index) => ({
        id: status, status, created_at: new Date(now - 3600000 - index).toISOString(),
        expires_at: new Date(now - 1000).toISOString()
    }));
    await mockFetch(overviewStorage(approvals, []), async () => {
        const result = await workspaceOverview(session);
        assert.deepEqual(Object.fromEntries(result.approvalHistory.map(item => [item.id, item.status])), {
            approved: 'expired', sent: 'sent', dispatching: 'dispatching', uncertain: 'uncertain'
        });
        assert.deepEqual(result.approvals, []);
    });
});

test('the migration enforces one active WhatsApp agent and scopes atomic runtime merging to the service role', async () => {
    const sql = await readFile(new URL('../supabase/migrations/20261031062459_workspace_agent_reliability.sql', import.meta.url), 'utf8');
    assert.match(sql, /create unique index workspace_one_enabled_whatsapp_agent\s+on public\.workspace_agents\(root_id\)\s+where type = 'whatsapp' and enabled/i);
    assert.match(sql, /activity_at timestamptz\s+generated always as \(greatest\(created_at, decided_at, delivered_at\)\) stored/i);
    assert.match(sql, /on public\.workspace_approvals\(root_id, activity_at desc, id desc\)/i);
    assert.match(sql, /security invoker set search_path = ''/i);
    assert.match(sql, /coalesce\(d\.status, '\{\}'::jsonb\) \|\| p_status/);
    assert.match(sql, /d\.id = p_device_id and d\.root_id = p_root_id and d\.revoked_at is null/);
    assert.match(sql, /revoke all on function public\.workspace_patch_runtime\(uuid, uuid, jsonb, text\) from public, anon, authenticated/i);
    assert.match(sql, /grant execute on function public\.workspace_patch_runtime\(uuid, uuid, jsonb, text\) to service_role/i);
    assert.match(sql, /->'telegramDialogue' = 'true'::jsonb[\s\S]*else 'false'::jsonb/);
    assert.equal(/security definer/i.test(sql), false);
});
