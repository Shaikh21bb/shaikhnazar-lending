import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWhatsAppAdapter } from '../companion/whatsapp.mjs';

async function fixture(t, { generate, examples = '', approval } = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shaikh-wa-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const ev = new EventEmitter();
    const sent = [];
    const requests = [];
    const socket = { ev, end() {}, async sendMessage(to, payload) { sent.push({ to, ...payload }); } };
    let created = false;
    const adapter = await createWhatsAppAdapter({ stateDirectory: directory,
        request: async payload => {
            requests.push(payload);
            if (payload.action === 'generate_whatsapp') return generate ? generate(payload) : { draft: 'Я обещаю отправить деньги', requiresApproval: false };
            if (payload.action === 'approval' && approval) return approval(payload);
            return { ok: true };
        },
        loadDependencies: async () => ({ default() { created = true; return socket; },
            useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
            makeCacheableSignalKeyStore: key => key, Browsers: { macOS: () => ['test'] }, pino: () => ({}), QRCode: { toDataURL: async () => 'data:image/png;base64,TEST' } }) });
    const agents = [{ id: 'agent-a', type: 'whatsapp', enabled: true, rules: '', examples }];
    await adapter.onPoll({ agents });
    assert.equal(created, false, 'startup must not silently link a WhatsApp device');
    const connected = adapter.handleJob({ kind: 'whatsapp_connect' });
    while (!created) await new Promise(resolve => setImmediate(resolve));
    ev.emit('connection.update', { qr: 'TEST-QR' });
    assert.match((await connected).qr, /^data:image\/png/);
    ev.emit('connection.update', { connection: 'open' });
    await new Promise(resolve => setImmediate(resolve));
    const inbound = (text, id = text) => ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '77771234567@s.whatsapp.net', id, fromMe: false }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) }] });
    t.after(() => adapter.stop());
    return { adapter, agents, inbound, sent, requests, directory };
}

test('a fresh greeting sends once; risky input and model-generated promises enter approval', async t => {
    const f = await fixture(t);
    f.inbound('Привет!', 'greeting');
    await f.adapter.idle();
    f.inbound('Привет!', 'greeting');
    await f.adapter.idle();
    assert.equal(f.sent.length, 1);
    f.inbound('Переведи 5000 ₸', 'money');
    f.inbound('Как дела?', 'promise');
    await f.adapter.idle();
    assert.equal(f.sent.length, 1);
    const approvals = f.requests.filter(item => item.action === 'approval');
    assert.equal(approvals.length, 2);
    assert.equal(approvals[0].reason, 'money');
    assert.ok(['money', 'commitment'].includes(approvals[1].reason));
});

test('owner-approved replies are sent once and disabled agents cannot send', async t => {
    const f = await fixture(t);
    const decision = { id: 'approval-a', agent_id: 'agent-a', recipient: '77771234567@s.whatsapp.net', draft: 'Подтверждаю встречу.' };
    await f.adapter.onPoll({ agents: f.agents, decisions: [decision] });
    await f.adapter.onPoll({ agents: f.agents, decisions: [decision] });
    assert.equal(f.sent.length, 1);
    await f.adapter.onPoll({ agents: [{ ...f.agents[0], enabled: false }], decisions: [{ ...decision, id: 'approval-b' }] });
    assert.equal(f.sent.length, 1);
    assert.equal(f.requests.at(-1).status, 'failed');
});

test('an exact owner-approved factual pair can reply without a model call', async t => {
    const f = await fixture(t, { examples: 'Сообщение: Где посмотреть твои проекты?\nМой ответ: На shaikh.digital' });
    f.inbound('Где посмотреть твои проекты?', 'known-fact');
    await f.adapter.idle();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].text, 'На shaikh.digital');
    assert.equal(f.requests.some(item => item.action === 'generate_whatsapp'), false);
    assert.equal(f.requests.some(item => item.action === 'approval'), false);
});

test('a model cannot label a new draft safe and bypass owner approval', async t => {
    const f = await fixture(t, { generate: () => ({ draft: 'Рад тебя слышать', requiresApproval: false, category: 'casual' }) });
    f.inbound('Расскажи о себе', 'generated-safe-claim');
    await f.adapter.idle();
    assert.equal(f.sent.length, 0);
    assert.equal(f.requests.filter(item => item.action === 'approval').length, 1);
});

test('pausing while generation is in flight prevents later sends and review uploads', async t => {
    let release;
    let began;
    const started = new Promise(resolve => { began = resolve; });
    const f = await fixture(t, { generate: () => { began(); return new Promise(resolve => { release = resolve; }); } });
    f.inbound('Расскажи о себе', 'in-flight');
    await started;
    await f.adapter.handleJob({ kind: 'whatsapp_disconnect' });
    release({ draft: 'Рад тебя слышать', requiresApproval: false });
    await f.adapter.idle();
    assert.equal(f.sent.length, 0);
    assert.equal(f.requests.some(item => item.action === 'approval'), false);
});

test('pending review uploads survive a temporary platform outage without duplicate replies', async t => {
    let available = false;
    const f = await fixture(t, { approval: () => {
        if (!available) throw new Error('network unavailable');
        return { ok: true };
    } });
    f.inbound('Одолжи 10000', 'review-offline');
    await f.adapter.idle();
    const journalPath = path.join(f.directory, 'whatsapp/delivery.json');
    let journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    assert.equal(Object.keys(journal.approvalOutbox).length, 1);
    available = true;
    await f.adapter.onPoll({ agents: f.agents });
    journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    assert.equal(Object.keys(journal.approvalOutbox).length, 0);
    assert.equal(f.sent.length, 0);
    const ids = f.requests.filter(item => item.action === 'approval').map(item => item.externalId);
    assert.equal(new Set(ids).size, 1);
});

async function waitUntil(predicate) {
    const deadline = Date.now() + 1000;
    while (!await predicate()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for a local adapter transition');
        await new Promise(resolve => setTimeout(resolve, 2));
    }
}

async function reconnectFixture(t, { reconnectBaseMs = 5 } = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shaikh-wa-reconnect-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const sockets = [];
    const options = [];
    const agents = [{ id: 'agent-a', type: 'whatsapp', enabled: true, rules: '', examples: '' }];
    const adapter = await createWhatsAppAdapter({ stateDirectory: directory, reconnectBaseMs,
        request: async () => ({ ok: true }), loadDependencies: async () => ({
            default(config) {
                options.push(config);
                const next = { ev: new EventEmitter(), end() {}, async sendMessage() {} };
                sockets.push(next); return next;
            }, DisconnectReason: { loggedOut: 401 },
            useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
            makeCacheableSignalKeyStore: keys => keys, Browsers: { macOS: () => ['test'] }, pino: () => ({}), QRCode: { toDataURL: async () => 'data:image/png;base64,TEST' }
        }) });
    t.after(() => adapter.stop());
    await adapter.onPoll({ agents });
    const first = adapter.handleJob({ kind: 'whatsapp_connect' });
    await waitUntil(() => sockets.length === 1);
    sockets[0].ev.emit('connection.update', { qr: 'FIRST-QR' });
    await first;
    return { adapter, sockets, agents, options, directory };
}

test('Baileys restartRequired and transient closes reconnect without importing phone history', async t => {
    const f = await reconnectFixture(t);
    f.sockets[0].ev.emit('creds.update', {});
    f.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
    await waitUntil(() => f.sockets.length === 2);
    f.sockets[1].ev.emit('connection.update', { connection: 'open' });
    await waitUntil(() => f.adapter.status === 'connected');
    assert.equal(f.options[1].syncFullHistory, false);
    assert.equal(f.options[1].shouldSyncHistoryMessage({}), false);
    f.sockets[0].ev.emit('connection.update', { connection: 'close' });
    assert.equal(f.adapter.status, 'connected', 'events from old sockets must not disconnect the current socket');
    f.sockets[1].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
    await waitUntil(() => f.sockets.length === 3);
    f.sockets[2].ev.emit('connection.update', { connection: 'open' });
});

test('logout never reconnects and clears the remembered delegate activation', async t => {
    const f = await reconnectFixture(t);
    f.sockets[0].ev.emit('connection.update', { connection: 'open' });
    await waitUntil(() => f.adapter.status === 'connected');
    await waitUntil(() => fs.access(path.join(f.directory, 'whatsapp/active.json')).then(() => true, () => false));
    f.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(f.sockets.length, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory, 'whatsapp/active.json'), 'utf8')), {});
});

test('QR refresh reuses one socket and owner pause cancels a scheduled reconnect', async t => {
    const f = await reconnectFixture(t, { reconnectBaseMs: 40 });
    assert.match((await f.adapter.handleJob({ kind: 'whatsapp_connect' })).qr, /^data:image/);
    assert.equal(f.sockets.length, 1);
    f.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
    await f.adapter.handleJob({ kind: 'whatsapp_disconnect' });
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(f.sockets.length, 1);
    assert.equal(f.adapter.status, 'paused');
});
