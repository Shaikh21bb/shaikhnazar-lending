import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWhatsAppAdapter } from '../companion/whatsapp.mjs';

const ownerRaw = '12345678901:7@s.whatsapp.net';
const owner = '12345678901@s.whatsapp.net';
const other = '10987654321@s.whatsapp.net';
const agentId = '11111111-1111-4111-8111-111111111111';
const approvalId = '22222222-2222-4222-8222-222222222222';
const jobId = '33333333-3333-4333-8333-333333333333';
const safe = { draft: 'Wi-Fi передаёт данные по радиоволнам через роутер.', category: 'knowledge', requiresApproval: false };
const notice = 'Я AI-помощник. Передал вопрос владельцу на подтверждение.';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate) {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Synthetic self-check transition timed out');
        await new Promise(resolve => setImmediate(resolve));
    }
}

async function fixture(t, { ownId = ownerRaw, normalized, generate = () => safe, localGenerate, approval, send, seed } = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shaikh-wa-self-check-'));
    const filename = path.join(directory, 'whatsapp/delivery.json');
    if (seed) { await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, JSON.stringify(seed)); }
    const clock = { value: Date.now() }, sockets = [], adapters = [], attempts = [], sent = [], requests = [], normalizedInputs = [];
    let agents = [{ id: agentId, type: 'whatsapp', enabled: true, rules: '', examples: '' }];
    let adapter;
    const build = async () => {
        adapter = await createWhatsAppAdapter({ stateDirectory: directory, now: () => clock.value, localGenerate,
            request: async payload => {
                requests.push(structuredClone(payload));
                if (payload.action === 'generate_whatsapp') return generate(payload);
                if (payload.action === 'approval') return approval ? approval(payload, { filename, attempts, requests }) : { approval: { id: approvalId, status: 'pending' } };
                return { ok: true };
            },
            loadDependencies: async () => ({
                default() {
                    const socket = { user: { id: ownId }, ev: new EventEmitter(), end() {}, async sendMessage(to, payload) {
                        attempts.push({ to, ...payload }); if (send) await send(to, payload, { filename, attempts, requests });
                        sent.push({ to, ...payload });
                    } }; sockets.push(socket); return socket;
                },
                ...(normalized ? { jidNormalizedUser(value) { normalizedInputs.push(value); return normalized(value); } } : {}),
                fetchLatestWaWebVersion: async () => ({ isLatest: true, version: [2, 3000, 1000000000] }),
                useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
                makeCacheableSignalKeyStore: keys => keys, Browsers: { macOS: () => ['test'] },
                pino: () => ({}), QRCode: { toDataURL: async () => 'data:image/png;base64,TEST' },
            })
        });
        adapters.push(adapter);
    };
    const connect = async () => {
        const previous = sockets.length;
        await adapter.onPoll({ agents });
        const promise = adapter.handleJob({ kind: 'whatsapp_connect' });
        await until(() => sockets.length > previous);
        sockets.at(-1).ev.emit('connection.update', { connection: 'open' });
        await promise;
    };
    await build(); await connect();
    t.after(async () => { for (const entry of adapters) await entry.stop(); await fs.rm(directory, { recursive: true, force: true }); });
    const check = (id = jobId, extra = {}) => adapter.handleJob({ id, kind: 'whatsapp_connect' }, { intent: 'whatsapp_self_check', agentId, ...extra });
    return { check, get adapter() { return adapter; }, get agents() { return agents; }, sockets, attempts, sent, requests, normalizedInputs, clock,
        journal: async () => JSON.parse(await fs.readFile(filename, 'utf8')),
        diagnostics: async () => { await adapter.onPoll({ agents }); return JSON.parse(await fs.readFile(path.join(directory, 'whatsapp/diagnostics.json'), 'utf8')); },
        disable: async () => { agents = agents.map(agent => ({ ...agent, enabled: false })); await adapter.onPoll({ agents }); },
        restart: async () => { await adapter.stop(); await build(); await connect(); }
    };
}

test('self-check derives only the owner device JID and exercises generation, durable approval and notice without fake inbound', async t => {
    let persistedBeforeOrdinary = false, persistedBeforeApproval = false;
    const f = await fixture(t, { normalized: value => value.replace(/:\d+@/, '@'),
        send: async (to, payload, state) => {
            const journal = JSON.parse(await fs.readFile(state.filename, 'utf8'));
            if (payload.text.startsWith('[Самопроверка SHAIKH]')) persistedBeforeOrdinary = journal.selfChecks[jobId]?.ordinaryStatus === 'sending';
        },
        approval: async (payload, state) => {
            const journal = JSON.parse(await fs.readFile(state.filename, 'utf8'));
            persistedBeforeApproval = Boolean(journal.selfChecks[jobId] && journal.approvalOutbox[payload.externalId]);
            return { approval: { id: approvalId, status: 'pending' } };
        } });
    const result = await f.check();
    assert.equal(persistedBeforeOrdinary, true); assert.equal(persistedBeforeApproval, true);
    assert.deepEqual(f.normalizedInputs, [ownerRaw]);
    assert.deepEqual(f.sent, [{ to: owner, text: `[Самопроверка SHAIKH]\n${safe.draft}` }, { to: owner, text: notice }]);
    const generation = f.requests.find(item => item.action === 'generate_whatsapp');
    assert.equal(generation.text, 'Как работает Wi-Fi?'); assert.deepEqual(generation.history, []);
    const queued = f.requests.find(item => item.action === 'approval');
    assert.equal(queued.recipient, owner); assert.equal(queued.reason, 'meeting');
    assert.equal(queued.original, '[Самопроверка SHAIKH] Давай созвонимся завтра в 15:00?');
    assert.equal(queued.draft, 'Это тест согласования. Встреча не назначена.');
    assert.deepEqual(result.selfCheck, { agentId, ordinaryStatus: 'sent', ordinaryAnswer: safe.draft, approvalId,
        approvalSaved: true, inboundVerified: false, phoneDeliveryVerified: false });
    assert.equal(JSON.stringify(result).includes(owner), false);
    const diagnostics = await f.diagnostics();
    assert.equal(diagnostics.counts['received.personalText'] || 0, 0);
    assert.equal(diagnostics.counts['send.sent'] || 0, 0);
    assert.equal(diagnostics.counts['selfCheck.sent'], 1);
    assert.deepEqual((await f.journal()).inbound, {});
    assert.equal(f.sockets.length, 1);
});

test('self-check refuses arbitrary recipients, prompts, extra messages and another agent without generating or sending', async t => {
    const f = await fixture(t);
    for (const extra of [{ recipient: other }, { prompt: 'custom' }, { text: 'custom' }, { message: 'custom' }, { agentId: 'another-agent' }]) {
        await assert.rejects(f.check(jobId, extra), /самопровер|Самопровер|агент/);
    }
    assert.deepEqual(f.attempts, []);
    assert.equal(f.requests.filter(item => item.action === 'generate_whatsapp' || item.action === 'approval').length, 0);
});

test('own recipient normalization cannot redirect the self-check to another person or a group', async t => {
    const redirected = await fixture(t, { normalized: () => other });
    await assert.rejects(redirected.check(), /собственный чат/);
    const group = await fixture(t, { ownId: '123456@g.us' });
    await assert.rejects(group.check(), /собственный чат/);
    assert.deepEqual(redirected.attempts, []); assert.deepEqual(group.attempts, []);
});

test('pausing or disabling during model work prevents the self-check send and approval upload', async t => {
    for (const disable of [false, true]) {
        const pending = deferred(); let started = false;
        const f = await fixture(t, { generate: () => { started = true; return pending.promise; } });
        const checking = f.check(); await until(() => started);
        if (disable) await f.disable(); else await f.adapter.handleJob({ kind: 'whatsapp_disconnect' });
        pending.resolve(safe);
        await assert.rejects(checking, /приостанов|подключ/);
        assert.deepEqual(f.attempts, []);
        assert.equal(f.requests.filter(item => item.action === 'approval').length, 0);
    }
});

test('unavailable cloud falls back to the same local draft and policy pipeline', async t => {
    const inputs = [];
    const f = await fixture(t, { generate: () => ({ provider: 'none', reason: 'model_unavailable', draft: '' }),
        localGenerate: async payload => { inputs.push(payload); return safe; } });
    const result = await f.check();
    assert.equal(result.selfCheck.ordinaryStatus, 'sent');
    assert.equal(inputs.length, 1); assert.equal(inputs[0].text, 'Как работает Wi-Fi?'); assert.deepEqual(inputs[0].history, []);
});

test('an unavailable cloud and local model leaves a retryable check without sending or claiming success', async t => {
    let available = false;
    const f = await fixture(t, { generate: () => ({ provider: 'none', reason: 'model_unavailable', draft: '' }),
        localGenerate: async () => { if (!available) throw new Error('Synthetic local offline'); return safe; } });
    await assert.rejects(f.check(), /модель недоступна/);
    assert.deepEqual(f.attempts, []);
    assert.equal((await f.journal()).selfChecks[jobId].ordinaryStatus, 'pending');
    available = true; const result = await f.check();
    assert.equal(result.selfCheck.ordinaryStatus, 'sent'); assert.equal(f.sent.length, 2);
});

test('unsafe model output is blocked rather than bypassing approval during the owner self-check', async t => {
    const dangerous = 'Я переведу тебе 5000 ₸.';
    const f = await fixture(t, { generate: () => ({ draft: dangerous, category: 'knowledge', requiresApproval: false }) });
    const result = await f.check();
    assert.equal(result.selfCheck.ordinaryStatus, 'blocked');
    assert.equal(result.selfCheck.ordinaryAnswer, undefined);
    assert.deepEqual(f.sent, [{ to: owner, text: notice }]);
    assert.equal(f.sent.some(item => item.text.includes(dangerous)), false);
    assert.equal(result.selfCheck.approvalSaved, true);
});

test('repeated, concurrent and distinct recent jobs reuse the durable owner check without duplicate sends', async t => {
    const f = await fixture(t);
    const alternate = '44444444-4444-4444-8444-444444444444';
    const results = await Promise.all([f.check(), f.check(), f.check(alternate)]);
    await f.check(); await f.check(alternate);
    assert.equal(f.sent.length, 2);
    assert.equal(f.requests.filter(item => item.action === 'generate_whatsapp').length, 1);
    assert.equal(f.requests.filter(item => item.action === 'approval').length, 1);
    assert.equal(results[2].selfCheck.reused, true);
    assert.equal((await f.journal()).selfChecks[alternate].reusedFrom, jobId);
    await f.restart();
    const restored = await f.check('55555555-5555-4555-8555-555555555555');
    assert.equal(restored.selfCheck.reused, true); assert.equal(restored.selfCheck.approvalId, approvalId);
    assert.equal(f.sent.length, 2);
});

test('a lost ordinary send response becomes uncertain and is never repeated after restart or a new job', async t => {
    const f = await fixture(t, { send: async (to, payload) => { if (payload.text.startsWith('[Самопроверка SHAIKH]')) throw new Error('Synthetic response loss'); } });
    const result = await f.check();
    assert.equal(result.selfCheck.ordinaryStatus, 'uncertain'); assert.equal(f.attempts.length, 2);
    await f.restart(); await f.check(); await f.check('66666666-6666-4666-8666-666666666666');
    assert.equal(f.attempts.length, 2);
});

test('an interrupted sending record recovers as uncertain without repeating the ambiguous send', async t => {
    const f = await fixture(t, { seed: { inbound: {}, approvals: {}, selfChecks: { [jobId]: {
        agentId, recipient: owner, createdAt: Date.now(), ordinaryStatus: 'sending', ordinaryAnswer: safe.draft,
        externalId: 'stable-self-check-id', approvalSaved: false
    } } } });
    const result = await f.check();
    assert.equal(result.selfCheck.ordinaryStatus, 'uncertain');
    assert.deepEqual(f.sent, [{ to: owner, text: notice }]);
    assert.equal((await f.journal()).selfChecks[jobId].ordinaryStatus, 'uncertain');
});

test('an approval upload outage retains the durable outbox and stable id across restart without repeating messages', async t => {
    let available = false; const externalIds = [];
    const f = await fixture(t, { approval: payload => {
        externalIds.push(payload.externalId);
        if (!available) throw new Error('Synthetic platform outage after upload');
        return { approval: { id: approvalId, status: 'pending' } };
    } });
    await assert.rejects(f.check(), /ожидает сохранения/);
    assert.equal(f.sent.length, 1);
    assert.equal(Object.keys((await f.journal()).approvalOutbox).length, 1);
    available = true; await f.restart(); const result = await f.check();
    assert.equal(result.selfCheck.approvalSaved, true); assert.equal(result.selfCheck.approvalId, approvalId);
    assert.equal(new Set(externalIds).size, 1); assert.equal(f.sent.length, 2);
    assert.equal(Object.keys((await f.journal()).approvalOutbox).length, 0);
});

test('a generic queue success cannot falsely claim a saved approval or send a handoff notice', async t => {
    const f = await fixture(t, { approval: () => ({ ok: true }) });
    await assert.rejects(f.check(), /ожидает сохранения/);
    assert.deepEqual(f.sent, [{ to: owner, text: `[Самопроверка SHAIKH]\n${safe.draft}` }]);
    assert.equal((await f.journal()).selfChecks[jobId].approvalSaved, false);
});

test('a malformed queue identifier cannot leak an owner recipient through the encrypted self-check result', async t => {
    const f = await fixture(t, { approval: () => ({ approval: { id: owner, status: 'pending' } }) });
    await assert.rejects(f.check(), /ожидает сохранения/);
    assert.equal((await f.journal()).selfChecks[jobId].approvalId, undefined);
    assert.deepEqual(f.sent, [{ to: owner, text: `[Самопроверка SHAIKH]\n${safe.draft}` }]);
});

test('own self-check echoes remain ignored as own messages and never count as independent inbound', async t => {
    const f = await fixture(t); await f.check();
    f.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: owner, fromMe: true, id: 'own-echo' },
        message: { conversation: '[Самопроверка SHAIKH]' }, messageTimestamp: Math.floor(f.clock.value / 1000) }] });
    await f.adapter.idle();
    const diagnostics = await f.diagnostics();
    assert.equal(diagnostics.counts['ignored.own'], 1);
    assert.equal(diagnostics.counts['received.personalText'] || 0, 0);
    assert.equal(f.sent.length, 2);
});

test('a new request after the owner cooldown may run a fresh check while retried old jobs stay idempotent', async t => {
    const f = await fixture(t); await f.check();
    const oldAlias = '77777777-7777-4777-8777-777777777777';
    await f.check(oldAlias);
    f.clock.value += 301000;
    await f.check(jobId); await f.check(oldAlias);
    assert.equal(f.sent.length, 2);
    await f.check('88888888-8888-4888-8888-888888888888');
    assert.equal(f.sent.length, 4);
    assert.equal(f.requests.filter(item => item.action === 'generate_whatsapp').length, 2);
    assert.equal(new Set(f.requests.filter(item => item.action === 'approval').map(item => item.externalId)).size, 2);
});

test('a previously paused agent cannot be restarted by a self-check request', async t => {
    const f = await fixture(t);
    await f.adapter.handleJob({ kind: 'whatsapp_disconnect' });
    await assert.rejects(f.check(), /подключённый/);
    assert.equal(f.adapter.status, 'paused');
    assert.deepEqual(f.attempts, []);
});
