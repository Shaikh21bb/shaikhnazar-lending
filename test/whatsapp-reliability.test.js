import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWhatsAppAdapter } from '../companion/whatsapp.mjs';

const person = '77771234567@s.whatsapp.net';
const otherPerson = '77779876543@s.whatsapp.net';
const answer = { draft: 'Свет рассеивается в атмосфере.', category: 'knowledge', requiresApproval: false };

async function until(predicate) {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Synthetic WhatsApp transition timed out');
        await new Promise(resolve => setImmediate(resolve));
    }
}

async function fixture(t, { generate = () => answer, send, acknowledge, seed } = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shaikh-wa-reliability-'));
    const journalPath = path.join(directory, 'whatsapp/delivery.json');
    if (seed) {
        await fs.mkdir(path.dirname(journalPath), { recursive: true });
        await fs.writeFile(journalPath, JSON.stringify(seed));
    }
    const clock = { value: Date.now() }, sockets = [], sent = [], attempts = [], requests = [], adapters = [];
    let agents = [{ id: 'agent-a', type: 'whatsapp', enabled: true, rules: '', examples: '' }];
    const build = async () => {
        const result = await createWhatsAppAdapter({ stateDirectory: directory, now: () => clock.value,
            request: async payload => {
                requests.push(structuredClone(payload));
                if (payload.action === 'generate_whatsapp') return generate(payload);
                if (payload.action === 'delivered' && acknowledge) return acknowledge(payload, { journalPath, sent, requests });
                return { ok: true };
            },
            loadDependencies: async () => ({
                default() {
                    const socket = { ev: new EventEmitter(), end() {}, async sendMessage(to, payload) {
                        attempts.push({ to, ...payload });
                        if (send) await send(to, payload);
                        sent.push({ to, ...payload });
                    } };
                    sockets.push(socket); return socket;
                },
                fetchLatestWaWebVersion: async () => ({ isLatest: true, version: [2, 3000, 1000000000] }),
                useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
                makeCacheableSignalKeyStore: keys => keys, Browsers: { macOS: () => ['test'] },
                pino: () => ({}), QRCode: { toDataURL: async () => 'data:image/png;base64,TEST' },
            }),
        });
        adapters.push(result); return result;
    };
    let adapter = await build();
    const connect = async (nextAgents = agents) => {
        agents = nextAgents;
        const previousSockets = sockets.length;
        await adapter.onPoll({ agents });
        if (adapter.status === 'connected') return;
        const connecting = adapter.handleJob({ kind: 'whatsapp_connect' });
        await until(() => sockets.length > previousSockets);
        sockets.at(-1).ev.emit('connection.update', { connection: 'open' });
        await connecting;
    };
    await connect();
    let serial = 0;
    const inbound = (text, { id = `reliability-${serial++}`, jid = person,
        timestamp = Math.floor(clock.value / 1000), fromMe = false, type = 'notify', requestId, socket = sockets.at(-1) } = {}) => {
        socket.ev.emit('messages.upsert', { type, ...(requestId ? { requestId } : {}), messages: [{
            key: { remoteJid: jid, id, fromMe }, message: { conversation: text }, messageTimestamp: timestamp,
        }] });
    };
    t.after(async () => { for (const entry of adapters) await entry.stop(); await fs.rm(directory, { recursive: true, force: true }); });
    return { get adapter() { return adapter; }, get agents() { return agents; }, inbound, connect, clock, sockets, sent, attempts, requests,
        readJournal: async () => JSON.parse(await fs.readFile(journalPath, 'utf8')),
        diagnostics: async () => { await adapter.onPoll({ agents }); return JSON.parse(await fs.readFile(path.join(directory, 'whatsapp/diagnostics.json'), 'utf8')); },
        restart: async () => { await adapter.stop(); adapter = await build(); await connect(); },
    };
}

test('transport updates leave model readiness and Telegram capability state to the host heartbeat', async t => {
    const f = await fixture(t);
    const events = f.requests.filter(item => item.action === 'runtime');
    assert.ok(events.some(item => item.status.whatsapp === 'connected'));
    for (const event of events) assert.deepEqual(Object.keys(event.status), ['whatsapp']);
});

test('fresh messages retain their arrival freshness while an earlier AI response holds the global queue', async t => {
    let release, began = false;
    const f = await fixture(t, { generate: () => { began = true; return new Promise(resolve => { release = resolve; }); } });
    f.inbound('Почему небо голубое?', { id: 'slow-question' });
    f.inbound('Привет', { id: 'queued-fresh-greeting', jid: otherPerson });
    await until(() => began);
    f.clock.value += 601000;
    release(answer);
    await f.adapter.idle();
    assert.deepEqual(f.sent, [{ to: person, text: answer.draft }, { to: otherPerson, text: 'Привет!' }]);
    assert.equal((await f.diagnostics()).counts['ignored.timestamp'] || 0, 0);
});

test('history, stale, future, own and group messages remain excluded after a slow queue drains', async t => {
    let release, began = false;
    const f = await fixture(t, { generate: () => { began = true; return new Promise(resolve => { release = resolve; }); } });
    const timestamp = Math.floor(f.clock.value / 1000);
    f.inbound('Почему небо голубое?');
    f.inbound('Привет', { id: 'stale', timestamp: timestamp - 601 });
    f.inbound('Привет', { id: 'future', timestamp: timestamp + 120 });
    f.inbound('Привет', { id: 'history', requestId: 'history-import' });
    f.inbound('Привет', { id: 'group', jid: '123456@g.us' });
    f.inbound('Привет', { id: 'own', fromMe: true });
    f.inbound('Привет', { id: 'fresh-append', type: 'append' });
    await until(() => began);
    f.clock.value += 601000;
    release(answer);
    await f.adapter.idle();
    assert.equal(f.sent.length, 2);
    const diagnostics = await f.diagnostics();
    assert.equal(diagnostics.counts['ignored.timestamp'], 2);
    assert.equal(diagnostics.counts['ignored.nonPersonal'], 1);
    assert.equal(diagnostics.counts['ignored.own'], 1);
    assert.equal(diagnostics.counts['ignored.historyBatch'], 1);
    for (const marker of ['Почему', 'stale', person, 'history-import']) assert.ok(!JSON.stringify(diagnostics).includes(marker));
});

test('a queued event cannot migrate to another agent or a replacement connection', async t => {
    let release, began = false;
    const f = await fixture(t, { generate: () => { began = true; return new Promise(resolve => { release = resolve; }); } });
    f.inbound('Почему небо голубое?');
    f.inbound('Привет', { id: 'old-agent-queued' });
    await until(() => began);
    await f.connect([{ ...f.agents[0], id: 'agent-b' }]);
    release(answer);
    await f.adapter.idle();
    assert.deepEqual(f.sent, []);
    f.inbound('Привет', { id: 'new-agent-fresh' });
    await f.adapter.idle();
    assert.deepEqual(f.sent, [{ to: person, text: 'Привет!' }]);
    assert.equal(f.requests.filter(item => item.action === 'generate_whatsapp').length, 1);
});

for (const status of ['sent', 'uncertain', 'failed']) {
    test(`an approved ${status} outcome survives an acknowledgment outage and restart without resending`, async t => {
        let online = false, persistedBeforeRequest = false;
        const f = await fixture(t, {
            send: status === 'uncertain' ? async () => { throw new Error('Lost WhatsApp response'); } : undefined,
            acknowledge: async (payload, { journalPath }) => {
                const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
                persistedBeforeRequest = journal.deliveryOutbox[payload.approvalId]?.status === status
                    && ['sent', 'uncertain', 'cancelled'].includes(journal.approvals[payload.approvalId]);
                if (!online) throw new Error('Platform acknowledgment unavailable');
                return { ok: true };
            },
        });
        const decision = { id: `approved-${status}`, agent_id: 'agent-a', recipient: status === 'failed' ? '123456@g.us' : person,
            draft: 'Ответ согласован владельцем.' };
        await f.adapter.onPoll({ agents: f.agents, decisions: [decision] });
        assert.equal(persistedBeforeRequest, true);
        assert.equal((await f.readJournal()).deliveryOutbox[decision.id].status, status);
        const expectedAttempts = status === 'failed' ? 0 : 1;
        assert.equal(f.attempts.length, expectedAttempts);
        online = true;
        await f.restart();
        await f.adapter.onPoll({ agents: f.agents });
        assert.deepEqual((await f.readJournal()).deliveryOutbox, {});
        assert.equal(f.attempts.length, expectedAttempts);
        assert.deepEqual(f.requests.filter(item => item.action === 'delivered').map(item => item.status), [status, status]);
    });
}

test('a lost acknowledgment response is resolved even when the server already changed the row', async t => {
    let committed = false;
    const f = await fixture(t, { acknowledge: async () => {
        if (!committed) { committed = true; throw new Error('Response lost after status update'); }
        return { ok: false };
    } });
    await f.adapter.onPoll({ agents: f.agents, decisions: [{ id: 'already-recorded', agent_id: 'agent-a', recipient: person, draft: 'Принято.' }] });
    assert.equal(f.sent.length, 1);
    await f.adapter.onPoll({ agents: f.agents });
    assert.deepEqual((await f.readJournal()).deliveryOutbox, {});
    assert.equal(f.sent.length, 1);
});

test('a restart during approved sending reports uncertainty without repeating the message', async t => {
    const f = await fixture(t, { seed: { inbound: {}, approvals: { interrupted: 'sending' }, deliveryOutbox: {} } });
    assert.equal((await f.readJournal()).approvals.interrupted, 'uncertain');
    assert.deepEqual(f.requests.filter(item => item.action === 'delivered'), [{ action: 'delivered', approvalId: 'interrupted', status: 'uncertain' }]);
    assert.deepEqual(f.sent, []);
});

test('legacy stored outcomes receive one metadata-only reconciliation on upgrade', async t => {
    const f = await fixture(t, { seed: { inbound: {}, approvals: { delivered: 'sent', cancelled: 'cancelled' } } });
    assert.deepEqual(f.requests.filter(item => item.action === 'delivered'), [
        { action: 'delivered', approvalId: 'delivered', status: 'sent' },
        { action: 'delivered', approvalId: 'cancelled', status: 'failed' },
    ]);
    await f.restart();
    assert.equal(f.requests.filter(item => item.action === 'delivered').length, 2);
    assert.deepEqual(f.sent, []);
});
