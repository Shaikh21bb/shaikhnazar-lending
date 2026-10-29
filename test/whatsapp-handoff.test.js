import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWhatsAppAdapter } from '../companion/whatsapp.mjs';

const personA = '77771234567@s.whatsapp.net';
const personB = '77779876543@s.whatsapp.net';
const NOTICE = 'Я AI-помощник. Передал вопрос владельцу на подтверждение.';
const important = { draft: 'Давай уточним время.', category: 'important', requiresApproval: true };

async function until(predicate) {
    const deadline = Date.now() + 1500;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Synthetic handoff transition timed out');
        await new Promise(resolve => setImmediate(resolve));
    }
}

async function fixture(t, { approval, generate = () => important, send, seed } = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shaikh-wa-handoff-'));
    const journalPath = path.join(directory, 'whatsapp/delivery.json');
    const clock = { value: Date.now() };
    if (seed) {
        await fs.mkdir(path.dirname(journalPath), { recursive: true, mode: 0o700 });
        await fs.writeFile(journalPath, JSON.stringify(seed(clock.value)), { mode: 0o600 });
    }
    const ev = new EventEmitter(), sent = [], attempts = [], requests = [], order = [];
    const approvalIds = new Map();
    let created = false;
    const socket = { ev, end() {}, async sendMessage(to, payload) {
        attempts.push({ to, ...payload }); order.push('send');
        if (send) await send(to, payload);
        sent.push({ to, ...payload });
    } };
    const adapter = await createWhatsAppAdapter({ stateDirectory: directory, now: () => clock.value,
        request: async payload => {
            requests.push(structuredClone(payload));
            if (payload.action === 'generate_whatsapp') return generate(payload);
            if (payload.action === 'approval') {
                order.push('upload');
                if (!approvalIds.has(payload.externalId)) approvalIds.set(payload.externalId, `approval-${approvalIds.size + 1}`);
                const response = approval ? await approval(payload, { journalPath, sent, requests })
                    : { approval: { id: approvalIds.get(payload.externalId), status: 'pending' } };
                if (response?.approval?.id) order.push('confirmed');
                return response;
            }
            return { ok: true };
        },
        loadDependencies: async () => ({
            default() { created = true; return socket; },
            fetchLatestWaWebVersion: async () => ({ isLatest: true, version: [2, 3000, 1000000000] }),
            useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
            makeCacheableSignalKeyStore: keys => keys, Browsers: { macOS: () => ['test'] },
            pino: () => ({}), QRCode: { toDataURL: async () => 'data:image/png;base64,TEST' },
        }),
    });
    const agents = [{ id: 'agent-a', type: 'whatsapp', enabled: true, rules: '', examples: '' }];
    await adapter.onPoll({ agents });
    const connecting = adapter.handleJob({ kind: 'whatsapp_connect' });
    await until(() => created);
    ev.emit('connection.update', { connection: 'open' });
    await connecting;
    let serial = 0;
    const inbound = (text, { jid = personA, id = `handoff-${serial++}`, fromMe = false } = {}) => {
        ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: jid, id, fromMe },
            message: { conversation: text }, messageTimestamp: Math.floor(clock.value / 1000) }] });
    };
    const readJournal = async () => JSON.parse(await fs.readFile(journalPath, 'utf8'));
    t.after(async () => { await adapter.stop(); await fs.rm(directory, { recursive: true, force: true }); });
    return { adapter, agents, inbound, sent, attempts, requests, order, clock, readJournal };
}

test('an important draft is queued durably before one fixed sender notice is sent', async t => {
    let persistedBeforeUpload = false;
    const f = await fixture(t, { approval: async (payload, state) => {
        const journal = JSON.parse(await fs.readFile(state.journalPath, 'utf8'));
        persistedBeforeUpload = journal.inbound[payload.externalId] === 'approval'
            && journal.handoffs?.[payload.externalId]?.status === 'waiting';
        assert.deepEqual(state.sent, []);
        return { approval: { id: 'approval-1', status: 'pending' } };
    } });
    f.inbound('Давай созвонимся завтра в 15:00?');
    await f.adapter.idle();
    assert.equal(persistedBeforeUpload, true);
    assert.deepEqual(f.sent, [{ to: personA, text: NOTICE }]);
    assert.deepEqual(f.order, ['upload', 'confirmed', 'send']);
    assert.equal(f.sent.some(message => message.text === important.draft), false);
    assert.equal(Object.values((await f.readJournal()).handoffs)[0].status, 'sent');
});

test('duplicate incoming events never repeat the handoff upload or notice', async t => {
    const f = await fixture(t);
    f.inbound('Одолжи 10000 ₸', { id: 'same-request' });
    await f.adapter.idle();
    f.inbound('Одолжи 10000 ₸', { id: 'same-request' });
    await f.adapter.idle();
    await f.adapter.onPoll({ agents: f.agents });
    assert.equal(f.requests.filter(request => request.action === 'approval').length, 1);
    assert.deepEqual(f.sent, [{ to: personA, text: NOTICE }]);
});

test('an offline approval upload sends no false handoff notice and retries after recovery', async t => {
    let available = false;
    const f = await fixture(t, { approval: async () => {
        if (!available) throw new Error('Synthetic platform outage');
        return { approval: { id: 'approval-recovered', status: 'pending' } };
    } });
    f.inbound('Давай встретимся завтра');
    await f.adapter.idle();
    assert.deepEqual(f.sent, []);
    let journal = await f.readJournal();
    assert.equal(Object.keys(journal.approvalOutbox).length, 1);
    assert.equal(Object.values(journal.handoffs)[0].status, 'waiting');
    available = true;
    await f.adapter.onPoll({ agents: f.agents });
    await f.adapter.onPoll({ agents: f.agents });
    assert.deepEqual(f.sent, [{ to: personA, text: NOTICE }]);
    journal = await f.readJournal();
    assert.equal(Object.keys(journal.approvalOutbox).length, 0);
    assert.equal(Object.values(journal.handoffs)[0].status, 'sent');
});

test('a generic success without a confirmed approval cannot claim the owner received it', async t => {
    const f = await fixture(t, { approval: () => ({ ok: true }) });
    f.inbound('Переведи 5000 ₸');
    await f.adapter.idle();
    await f.adapter.onPoll({ agents: f.agents });
    assert.deepEqual(f.sent, []);
});

test('handoff notices are limited per chat while each important question remains queued', async t => {
    const f = await fixture(t);
    f.inbound('Давай созвонимся завтра');
    await f.adapter.idle();
    f.inbound('И переведи деньги');
    await f.adapter.idle();
    assert.equal(f.requests.filter(request => request.action === 'approval').length, 2);
    assert.deepEqual(f.sent, [{ to: personA, text: NOTICE }]);
    f.clock.value += 5 * 60_000 + 1;
    f.inbound('Давай встретимся послезавтра');
    await f.adapter.idle();
    assert.equal(f.sent.length, 2);
    assert.ok(f.sent.every(message => message.text === NOTICE));
});

test('notice throttling is isolated between different personal chats', async t => {
    const f = await fixture(t);
    f.inbound('Давай созвонимся завтра', { jid: personA });
    f.inbound('Одолжи деньги', { jid: personB });
    await f.adapter.idle();
    assert.deepEqual(f.sent, [{ to: personA, text: NOTICE }, { to: personB, text: NOTICE }]);
});

test('pausing while a review upload is in flight prevents its later notice', async t => {
    let release, began = false;
    const f = await fixture(t, { approval: () => { began = true; return new Promise(resolve => { release = resolve; }); } });
    f.inbound('Давай встретимся завтра');
    await until(() => began);
    await f.adapter.handleJob({ kind: 'whatsapp_disconnect' });
    release({ approval: { id: 'approval-paused', status: 'pending' } });
    await f.adapter.idle();
    assert.deepEqual(f.sent, []);
});

test('disabling an agent while a review upload is in flight prevents its later notice', async t => {
    let release, began = false;
    const f = await fixture(t, { approval: () => { began = true; return new Promise(resolve => { release = resolve; }); } });
    f.inbound('Давай встретимся завтра');
    await until(() => began);
    await f.adapter.onPoll({ agents: [{ ...f.agents[0], enabled: false }] });
    release({ approval: { id: 'approval-disabled', status: 'pending' } });
    await f.adapter.idle();
    assert.deepEqual(f.sent, []);
});

test('group messages never create a handoff, approval or outbound notice', async t => {
    const f = await fixture(t);
    f.inbound('Давай созвонимся завтра', { jid: '120363000000000000@g.us' });
    await f.adapter.idle();
    assert.deepEqual(f.sent, []);
    assert.equal(f.requests.some(request => request.action === 'approval'), false);
});

test('an approved final response cancels a pending notice rather than following it', async t => {
    let available = false;
    const f = await fixture(t, { approval: () => {
        if (!available) throw new Error('Synthetic lost upload response');
        return { approval: { id: 'approval-final', status: 'pending' } };
    } });
    f.inbound('Давай созвонимся завтра');
    await f.adapter.idle();
    const externalId = f.requests.find(request => request.action === 'approval').externalId;
    available = true;
    const draft = 'Подтверждаю созвон завтра в 15:00.';
    await f.adapter.onPoll({ agents: f.agents, decisions: [{ id: 'approval-final', agent_id: 'agent-a', recipient: personA, draft, external_id: externalId }] });
    assert.deepEqual(f.sent, [{ to: personA, text: draft }]);
    assert.equal(Object.values((await f.readJournal()).handoffs)[0].status, 'cancelled');
});

test('an ambiguous notice send is not retried automatically', async t => {
    const f = await fixture(t, { send: () => { throw new Error('Synthetic ambiguous network failure'); } });
    f.inbound('Давай созвонимся завтра');
    await f.adapter.idle();
    await f.adapter.onPoll({ agents: f.agents });
    assert.equal(f.attempts.length, 1);
    assert.equal(Object.values((await f.readJournal()).handoffs)[0].status, 'uncertain');
});

test('an approved final response waits for an already in-flight handoff notice', async t => {
    let releaseNotice, noticeStarted = false, finalStarted = false;
    const draft = 'Подтверждаю созвон завтра в 15:00.';
    const f = await fixture(t, { send: (to, payload) => {
        if (payload.text === NOTICE) {
            noticeStarted = true;
            return new Promise(resolve => { releaseNotice = resolve; });
        }
        if (payload.text === draft) finalStarted = true;
    } });
    f.inbound('Давай созвонимся завтра', { id: 'in-flight-notice' });
    await until(() => noticeStarted);
    const externalId = f.requests.find(request => request.action === 'approval').externalId;
    const deciding = f.adapter.onPoll({ agents: f.agents, decisions: [{ id: 'approval-1', agent_id: 'agent-a',
        recipient: personA, external_id: externalId, draft }] });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(finalStarted, false);
    assert.deepEqual(f.attempts, [{ to: personA, text: NOTICE }]);
    releaseNotice();
    await Promise.all([deciding, f.adapter.idle()]);
    assert.equal(finalStarted, true);
    assert.deepEqual(f.sent, [{ to: personA, text: NOTICE }, { to: personA, text: draft }]);
    assert.equal(f.sent.at(-1).text, draft);
});

test('an uncertain notice attempt reserves the per-chat cooldown for later questions', async t => {
    const f = await fixture(t, { send: () => { throw new Error('Synthetic lost send response'); } });
    f.inbound('Давай созвонимся завтра', { id: 'uncertain-first' });
    await f.adapter.idle();
    f.inbound('И переведи деньги', { id: 'uncertain-second' });
    await f.adapter.idle();
    assert.equal(f.requests.filter(request => request.action === 'approval').length, 2);
    assert.equal(f.attempts.length, 1);
    const statuses = Object.values((await f.readJournal()).handoffs).map(notice => notice.status);
    assert.ok(statuses.includes('uncertain'));
    assert.ok(statuses.includes('suppressed'));
});

test('a restart turns an interrupted notice into uncertain and does not resend it', async t => {
    const f = await fixture(t, { seed: now => ({ inbound: {}, approvals: {}, approvalOutbox: {}, conversations: {},
        handoffs: { interrupted: { agentId: 'agent-a', recipient: personA, text: NOTICE, createdAt: now, expiresAt: now + 600_000,
            status: 'sending', approvalId: 'approval-interrupted' } } }) });
    await f.adapter.onPoll({ agents: f.agents });
    assert.deepEqual(f.sent, []);
    assert.equal((await f.readJournal()).handoffs.interrupted.status, 'uncertain');
});

test('courtesy acknowledgments after a handoff create no extra reply or owner review', async t => {
    const f = await fixture(t);
    f.inbound('Давай созвонимся завтра');
    await f.adapter.idle();
    for (const text of ['Ок', 'Понял', 'Спасибо', 'Хорошо']) {
        f.inbound(text);
        await f.adapter.idle();
    }
    assert.deepEqual(f.sent, [{ to: personA, text: NOTICE }]);
    assert.equal(f.requests.filter(request => request.action === 'approval').length, 1);
    assert.equal(Object.values((await f.readJournal()).inbound).filter(status => status === 'acknowledged').length, 4);
});

test('a new general question remains automatic while a personal decision waits', async t => {
    const answer = 'Кредит — заём, который возвращают по условиям договора.';
    const f = await fixture(t, { generate: payload => payload.text === 'Как работает кредит?'
        ? { draft: answer, category: 'knowledge', requiresApproval: false } : important });
    f.inbound('Давай созвонимся завтра');
    await f.adapter.idle();
    f.inbound('Как работает кредит?');
    await f.adapter.idle();
    assert.deepEqual(f.sent, [{ to: personA, text: NOTICE }, { to: personA, text: answer }]);
    assert.equal(f.requests.filter(request => request.action === 'approval').length, 1);
});

test('persisted non-personal or expired handoffs cannot send late notices', async t => {
    const f = await fixture(t, { seed: now => ({ inbound: {}, approvals: {}, approvalOutbox: {}, conversations: {}, handoffs: {
        group: { agentId: 'agent-a', recipient: '120363000000000000@g.us', text: NOTICE, createdAt: now, expiresAt: now + 600_000, status: 'pending', approvalId: 'approval-group' },
        old: { agentId: 'agent-a', recipient: personA, text: NOTICE, createdAt: now - 700_000, expiresAt: now - 1, status: 'pending', approvalId: 'approval-old' },
    } }) });
    await f.adapter.onPoll({ agents: f.agents });
    assert.deepEqual(f.sent, []);
});
