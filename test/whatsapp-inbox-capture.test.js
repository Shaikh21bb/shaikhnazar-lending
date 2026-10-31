import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWhatsAppAdapter } from '../companion/whatsapp.mjs';
import { createWhatsAppInbox, inboxId, inboxMessageContent } from '../companion/whatsapp-inbox.mjs';
import { INBOX_INGEST_SCHEMA, assertInboxSchema } from '../lib/whatsapp-inbox-contract.mjs';

const agentId = '11111111-1111-4111-8111-111111111111';
const approvalId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';
const recipient = '12345678901@s.whatsapp.net';
const owner = '10987654321@s.whatsapp.net';
const start = Date.UTC(2026, 9, 31, 7, 0, 0, 123);
const safe = { draft: 'Wi-Fi передаёт данные по радиоволнам.', category: 'knowledge', requiresApproval: false };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate) {
    const deadline = Date.now() + 2500;
    while (!await predicate()) {
        if (Date.now() > deadline) throw new Error('Synthetic inbox transition timed out');
        await new Promise(resolve => setImmediate(resolve));
    }
}
function message(id, timestamp = start, content = { conversation: 'Как работает Wi-Fi?' }, key = {}) {
    return { key: { remoteJid: recipient, id, fromMe: false, ...key }, messageTimestamp: Math.floor(timestamp / 1000),
        pushName: 'Тестовый контакт', message: content };
}
function outgoing(id, status = 'sent') {
    return { id: inboxId(id), recipient, contactName: null, agentId, direction: 'outgoing', actor: 'agent',
        kind: 'text', text: `Synthetic reply ${id}`, status, occurredAt: new Date(start).toISOString(),
        approvalId: null, replyToId: null, origin: 'live', reason: null };
}
async function helperFixture(t, options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shaikh-inbox-helper-'));
    const filename = path.join(directory, 'inbox.json'), requests = [], clock = { value: start };
    let inbox;
    const build = async () => {
        inbox = await createWhatsAppInbox({ filename, deviceId, now: () => clock.value, request: async payload => {
            requests.push(structuredClone(payload));
            assertInboxSchema(INBOX_INGEST_SCHEMA, { captureSince: payload.captureSince, events: payload.events });
            return options.upload ? options.upload(payload) : { ok: true, accepted: payload.events.length };
        } });
    };
    await build();
    t.after(async () => { await inbox.stop(); await fs.rm(directory, { recursive: true, force: true }); });
    return { get inbox() { return inbox; }, requests, clock, filename,
        read: async () => JSON.parse(await fs.readFile(filename, 'utf8')),
        restart: async () => { await inbox.stop(); await build(); } };
}
async function fixture(t, options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shaikh-inbox-adapter-'));
    let currentDeviceId = options.deviceId === undefined ? deviceId : options.deviceId;
    const filename = () => path.join(directory, `whatsapp/inbox-${currentDeviceId}.json`);
    const clock = { value: start }, requests = [], attempts = [], sockets = [], adapters = [];
    let adapter, agents = [{ id: agentId, type: 'whatsapp', enabled: true, rules: '', examples: '' }];
    const build = async () => {
        adapter = await createWhatsAppAdapter({ config: { deviceId: currentDeviceId }, stateDirectory: directory, now: () => clock.value,
            request: async payload => {
                requests.push(structuredClone(payload));
                if (payload.action === 'generate_whatsapp') return options.generate ? options.generate(payload) : safe;
                if (payload.action === 'approval') return options.approval ? options.approval(payload) : { approval: { id: approvalId, status: 'pending' } };
                if (payload.action === 'whatsapp_inbox') {
                    assertInboxSchema(INBOX_INGEST_SCHEMA, { captureSince: payload.captureSince, events: payload.events });
                    return options.upload ? options.upload(payload) : { ok: true, accepted: payload.events.length };
                }
                return { ok: true };
            },
            loadDependencies: async () => ({
                default() { const socket = { user: { id: owner }, ev: new EventEmitter(), end() {},
                    async sendMessage(to, payload) { attempts.push({ to, ...payload }); if (options.send) await options.send(to, payload); } };
                    sockets.push(socket); return socket; },
                fetchLatestWaWebVersion: async () => ({ isLatest: true, version: [2, 3000, 1000000000] }),
                useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
                makeCacheableSignalKeyStore: keys => keys, Browsers: { macOS: () => ['test'] },
                pino: () => ({}), QRCode: { toDataURL: async () => 'synthetic-qr' }
            })
        }); adapters.push(adapter);
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
    t.after(async () => { for (const item of adapters) await item.stop(); await fs.rm(directory, { recursive: true, force: true }); });
    return { get adapter() { return adapter; }, clock, requests, attempts,
        emit(messages, extra = {}) { sockets.at(-1).ev.emit('messages.upsert', { type: 'notify', messages, ...extra }); },
        poll: decisions => adapter.onPoll({ agents, decisions }),
        pause: () => adapter.handleJob({ kind: 'whatsapp_disconnect' }),
        read: async () => JSON.parse(await fs.readFile(filename(), 'utf8')),
        events: async () => Object.values(JSON.parse(await fs.readFile(filename(), 'utf8')).records).map(item => item.event).filter(Boolean),
        restart: async (nextDeviceId = currentDeviceId) => { await adapter.stop(); currentDeviceId = nextDeviceId; await build(); await connect(); },
        readDevice: async id => JSON.parse(await fs.readFile(path.join(directory, `whatsapp/inbox-${id}.json`), 'utf8')) };
}

test('inbox projection exposes only human kind/caption, cleans controls and never copies media secrets', () => {
    for (const [field, kind] of [['imageMessage', 'image'], ['videoMessage', 'video'], ['audioMessage', 'audio'],
        ['documentMessage', 'document'], ['stickerMessage', 'sticker'], ['locationMessage', 'location'], ['contactMessage', 'contact']]) {
        const result = inboxMessageContent({ [field]: { caption: 'Фото\0\u0001\ud800 подпись', mediaKey: 'SECRET',
            url: 'https://private.invalid', fileSha256: 'BASE64', vcard: 'PRIVATE_CONTACT', degreesLatitude: 12 } });
        assert.equal(result.kind, kind);
        assert.equal(JSON.stringify(result).includes('SECRET'), false);
        assert.equal(JSON.stringify(result).includes('private.invalid'), false);
        assert.equal(JSON.stringify(result).includes('PRIVATE_CONTACT'), false);
        assert.equal(result.text, ['image', 'video', 'document'].includes(kind) ? 'Фото подпись' : null);
    }
    assert.equal(inboxMessageContent({ protocolMessage: {}, conversation: 'control' }), null);
    assert.equal(inboxMessageContent({ reactionMessage: { text: '👍' } }), null);
    assert.equal(inboxMessageContent({ unknownControlMessage: {} }), null);
    assert.equal(inboxMessageContent({ editedMessage: { message: { conversation: 'edited' } } }), null);
    assert.equal(inboxMessageContent({ pollCreationMessage: { name: 'private title' } }).text, null);
    const wrapped = inboxMessageContent({ ephemeralMessage: { message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'Подпись' } } } } } });
    assert.equal(wrapped.text, 'Подпись');
});

test('durable activation admits only arrivals since its persisted second and does not copy old phone history', async t => {
    const f = await helperFixture(t);
    assert.equal(f.inbox.captureSince, new Date(Math.floor(start / 1000) * 1000).toISOString());
    assert.equal(f.inbox.incoming(message('old'), { timestamp: start - 1000, receivedAt: start, agentId }), null);
    assert.equal(f.inbox.incoming(message('future'), { timestamp: start + 61_000, receivedAt: start, agentId }), null);
    assert.equal(f.inbox.incoming(message('own', start, undefined, { fromMe: true }), { timestamp: start, receivedAt: start, agentId }), null);
    for (const jid of ['12345@g.us', 'status@broadcast', '12345@newsletter']) {
        assert.equal(f.inbox.incoming(message('group', start, undefined, { remoteJid: jid }), { timestamp: start, receivedAt: start, agentId }), null);
    }
    f.clock.value += 20 * 60_000; await f.restart();
    const late = f.inbox.incoming(message('late'), { timestamp: start + 60_000, receivedAt: f.clock.value, agentId });
    await late.saved;
    assert.equal(f.inbox.captureSince, new Date(Math.floor(start / 1000) * 1000).toISOString());
    assert.equal(f.inbox.event(late.id).direction, 'incoming');
    assert.equal((await fs.stat(f.filename)).mode & 0o777, 0o600);
});

test('arrival capture is durable before a blocked AI queue and survives an owner pause', async t => {
    const generation = deferred(); let started = false;
    const f = await fixture(t, { generate: () => { started = true; return generation.promise; } });
    f.emit([message('slow')]); await until(() => started);
    f.emit([message('waiting'), message('photo', start, { imageMessage: { caption: 'Новая фотография', mediaKey: 'PRIVATE' } })]);
    await until(async () => (await f.events()).filter(item => item.direction === 'incoming').length === 3);
    assert.equal((await f.events()).find(item => item.id === inboxId(`${recipient}:waiting`)).status, 'received');
    await f.pause(); generation.resolve(safe); await f.adapter.idle();
    const events = await f.events();
    assert.equal(events.filter(item => item.direction === 'incoming' && item.status === 'skipped' && item.reason === 'inactive').length, 3);
    assert.deepEqual(f.attempts, []);
});

test('offline arrivals after activation are archived stale and media/history/control/own gates never generate', async t => {
    const f = await fixture(t);
    f.clock.value += 20 * 60_000; await f.restart();
    f.emit([message('offline', start + 1000)], { type: 'append' });
    f.emit([message('old-phone', start - 60 * 60_000)]);
    f.emit([message('media', f.clock.value, { audioMessage: { mediaKey: 'PRIVATE', url: 'https://private.invalid' } })]);
    f.emit([message('history', f.clock.value)], { type: 'append', requestId: 'history-request' });
    f.emit([message('empty-history', f.clock.value)], { type: 'append', requestId: '' });
    f.emit([message('set-history', f.clock.value)], { type: 'history' });
    f.emit([message('protocol', f.clock.value, { protocolMessage: {} }), message('own', f.clock.value, undefined, { fromMe: true }),
        message('group', f.clock.value, undefined, { remoteJid: '12345@g.us' }), message('future', f.clock.value + 61_000)]);
    await f.adapter.idle();
    const events = await f.events();
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(item => item.reason).sort(), ['stale', 'unsupported_media']);
    assert.equal(events.find(item => item.kind === 'audio').text, null);
    assert.equal(f.requests.some(item => item.action === 'generate_whatsapp'), false);
    assert.deepEqual(f.attempts, []);
});

test('automatic replies, handoff notices and approved sends use real durable sources without own-echo duplicates', async t => {
    const f = await fixture(t);
    f.emit([message('ordinary')]); await f.adapter.idle();
    f.emit([message('meeting', start, { conversation: 'Давай созвонимся завтра в 15:00?' })]); await f.adapter.idle();
    const source = inboxId(`${recipient}:meeting`);
    let events = await f.events();
    const incoming = events.find(item => item.id === source);
    assert.equal(incoming.status, 'awaiting_approval'); assert.equal(incoming.approvalId, approvalId);
    const notice = events.find(item => item.id === inboxId(`handoff:${source}`));
    assert.equal(notice.actor, 'system'); assert.equal(notice.status, 'sent'); assert.equal(notice.replyToId, source);
    const auto = events.find(item => item.id === inboxId(`automatic:${inboxId(`${recipient}:ordinary`)}`));
    assert.equal(auto.status, 'sent'); assert.equal(auto.actor, 'agent');
    const decision = { id: approvalId, agent_id: agentId, recipient, external_id: source, draft: 'Это проверка. Встреча не назначена.' };
    await f.poll([decision]); await f.poll([decision]);
    f.emit([message('echo', start, { conversation: decision.draft }, { fromMe: true }), message('ordinary')]);
    await f.adapter.idle(); events = await f.events();
    assert.equal(f.attempts.length, 3);
    assert.equal(events.length, 5);
    assert.equal(events.find(item => item.id === source).status, 'answered');
    const approved = events.find(item => item.id === inboxId(`approved:${approvalId}`));
    assert.equal(approved.status, 'sent'); assert.equal(approved.approvalId, approvalId); assert.equal(approved.replyToId, source);
    assert.equal(events.filter(item => item.direction === 'outgoing').length, 3);
});

test('unconfirmed approval stays visibly pending without a fake sent draft or approval identifier', async t => {
    const f = await fixture(t, { approval: async () => { throw new Error('synthetic offline'); } });
    f.emit([message('meeting', start, { conversation: 'Встретимся завтра в 15:00?' })]); await f.adapter.idle();
    const events = await f.events();
    assert.equal(events.length, 1); assert.equal(events[0].status, 'awaiting_approval'); assert.equal(events[0].approvalId, null);
    assert.deepEqual(f.attempts, []);
});

test('long captured text is bounded and labeled while rejected by generation, contact names and Unicode are safe', async t => {
    const f = await fixture(t);
    const input = message('long', start, { conversation: 'x'.repeat(8001) + '\ud800' });
    input.pushName = 'Имя\0\u0001' + 'n'.repeat(150);
    f.emit([input]); await f.adapter.idle();
    const [event] = await f.events();
    assert.equal(event.text.length, 8000); assert.equal(event.reason, 'too_long'); assert.equal(event.status, 'skipped');
    assert.equal(event.contactName.length, 128); assert.equal(event.contactName.includes('\0'), false);
    assert.deepEqual(f.attempts, []); assert.equal(f.requests.some(item => item.action === 'generate_whatsapp'), false);
});

test('self-check creates system/outgoing records labeled as self_check and never invents a contact message', async t => {
    const f = await fixture(t);
    await f.adapter.handleJob({ id: 'synthetic-self-check', kind: 'whatsapp_connect' }, { intent: 'whatsapp_self_check', agentId });
    let events = await f.events();
    assert.equal(events.length, 3); assert.equal(events.some(item => item.direction === 'incoming'), false);
    assert.equal(events.every(item => item.origin === 'self_check' && item.recipient === owner), true);
    const question = events.find(item => item.direction === 'system');
    assert.equal(question.approvalId, approvalId); assert.equal(question.status, 'awaiting_approval');
    await f.poll([{ id: approvalId, agent_id: agentId, recipient: owner, draft: 'Это проверка. Встреча не назначена.' }]);
    events = await f.events();
    assert.equal(events.filter(item => item.direction === 'outgoing').length, 3);
    assert.equal(events.every(item => item.origin === 'self_check'), true);
    assert.equal(events.find(item => item.direction === 'system').status, 'answered');
});

test('the serialized uploader announces activation once, batches at 25, and an old ACK cannot drop a newer revision', async t => {
    const pending = deferred(); let block = true, simultaneous = 0, maxSimultaneous = 0;
    const f = await helperFixture(t, { upload: async payload => {
        simultaneous++; maxSimultaneous = Math.max(maxSimultaneous, simultaneous);
        if (payload.events.length && block) { block = false; await pending.promise; }
        simultaneous--; return { ok: true, accepted: payload.events.length };
    } });
    for (let i = 0; i < 27; i++) await f.inbox.record(outgoing(`batch-${i}`, 'sending'));
    const first = f.inbox.flush(), second = f.inbox.flush();
    await until(() => f.requests.some(item => item.events.length === 25));
    await f.inbox.patch(inboxId('batch-0'), { status: 'sent' }); pending.resolve();
    await Promise.all([first, second]);
    assert.equal(maxSimultaneous, 1);
    assert.equal(f.requests.filter(item => item.events.length === 0).length, 1);
    assert.equal(f.requests.every(item => item.events.length <= 25), true);
    const revisions = f.requests.flatMap(item => item.events).filter(item => item.id === inboxId('batch-0'));
    assert.deepEqual(revisions.map(item => item.revision), [1, 2]);
    assert.equal(Object.values((await f.read()).records).some(item => item.pending), false);
    await f.inbox.flush(); assert.equal(f.requests.length, 3);
});

test('an outage and generic ACK retain the latest event across restart, recover sending as uncertain and do not duplicate', async t => {
    let mode = 'offline';
    const f = await helperFixture(t, { upload: async payload => {
        if (mode === 'offline') throw new Error('synthetic offline');
        return mode === 'generic' ? { ok: true } : { ok: true, accepted: payload.events.length };
    } });
    await f.inbox.record(outgoing('interrupted', 'sending')); await f.inbox.flush();
    mode = 'generic'; await f.inbox.flush();
    assert.equal((await f.read()).announced, false);
    await f.restart();
    assert.equal(f.inbox.event(inboxId('interrupted')).status, 'uncertain');
    assert.equal(f.inbox.event(inboxId('interrupted')).revision, 2);
    await f.inbox.record(outgoing('interrupted', 'sending'));
    mode = 'exact'; await f.inbox.flush();
    assert.equal((await f.read()).records[inboxId('interrupted')].pending, false);
    assert.equal(Object.keys((await f.read()).records).length, 1);
});

test('a stalled cloud inbox cannot block a real agent send and ambiguous provider outcomes are never labeled sent', async t => {
    const upload = deferred();
    const f = await fixture(t, { upload: async payload => { await upload.promise; return { ok: true, accepted: payload.events.length }; },
        send: async () => { throw new Error('synthetic ambiguous provider'); } });
    f.emit([message('uncertain')]); await f.adapter.idle();
    assert.equal(f.attempts.length, 1);
    const events = await f.events();
    assert.equal(events.find(item => item.direction === 'outgoing').status, 'uncertain');
    assert.equal(events.find(item => item.direction === 'incoming').status, 'answered');
    assert.equal(events.some(item => item.status === 'sent'), false);
    upload.resolve();
});

test('synced terminal text is pruned after two days but pending uploads and open approvals survive', async t => {
    let online = true;
    const f = await helperFixture(t, { upload: async payload => {
        if (!online) throw new Error('synthetic offline');
        return { ok: true, accepted: payload.events.length };
    } });
    await f.inbox.record(outgoing('synced')); await f.inbox.flush();
    online = false; await f.inbox.record(outgoing('pending'));
    const incoming = f.inbox.incoming(message('approval'), { timestamp: start, receivedAt: start, agentId });
    await incoming.saved; await f.inbox.patch(incoming.id, { status: 'awaiting_approval', approvalId });
    f.clock.value += 3 * 24 * 3_600_000; await f.restart();
    const state = await f.read();
    assert.equal(state.records[inboxId('synced')].event, undefined);
    assert.equal(state.records[inboxId('pending')].event.text, outgoing('pending').text);
    assert.equal(state.records[incoming.id].event.status, 'awaiting_approval');
    assert.equal(f.inbox.has(inboxId('synced')), true);
});

test('re-pairing uses a new device ledger and cannot upload the former account pending inbox', async t => {
    let online = false;
    const f = await fixture(t, { upload: async payload => {
        if (!online) throw new Error('synthetic offline');
        return { ok: true, accepted: payload.events.length };
    } });
    f.emit([message('previous-account', start, { conversation: 'Old account synthetic message' })]); await f.adapter.idle();
    const oldState = await f.readDevice(deviceId);
    assert.equal(Object.values(oldState.records).some(item => item.pending), true);
    const boundary = f.requests.length;
    const nextDeviceId = '44444444-4444-4444-8444-444444444444';
    online = true; f.clock.value += 60_000; await f.restart(nextDeviceId);
    assert.equal((await f.events()).length, 0);
    assert.equal((await f.read()).deviceId, nextDeviceId);
    f.emit([message('new-account', f.clock.value, { conversation: 'New account synthetic message' })]); await f.adapter.idle();
    await f.poll();
    await until(async () => Object.values((await f.read()).records).every(item => !item.pending));
    const uploaded = f.requests.slice(boundary).filter(item => item.action === 'whatsapp_inbox').flatMap(item => item.events);
    assert.equal(uploaded.some(item => item.id === inboxId(`${recipient}:previous-account`) || item.text?.includes('Old account')), false);
    assert.equal(uploaded.some(item => item.id === inboxId(`${recipient}:new-account`)), true);
    assert.equal(Object.values((await f.readDevice(deviceId)).records).some(item => item.pending), true);
});

test('missing or invalid pairing scope disables only observation while ordinary replies still work', async t => {
    for (const id of [null, 'invalid-device']) {
        const f = await fixture(t, { deviceId: id });
        f.emit([message('unscoped')]); await f.adapter.idle();
        assert.equal(f.attempts.length, 1);
        assert.equal(f.requests.some(item => item.action === 'whatsapp_inbox'), false);
    }
});

test('a ledger cannot be reopened under a different device even when its filename is reused', async t => {
    const f = await helperFixture(t);
    await f.inbox.record(outgoing('private-old-account'));
    await assert.rejects(createWhatsAppInbox({ filename: f.filename,
        deviceId: '44444444-4444-4444-8444-444444444444', request: async () => { throw new Error('Must not upload'); } }), /журнал WhatsApp/);
    assert.equal((await f.read()).deviceId, deviceId);
});

test('approved ambiguous delivery is recorded once and a rejected send gate never creates a sent draft', async t => {
    const f = await fixture(t, { send: async (_to, payload) => {
        if (payload.text === 'Это проверка. Встреча не назначена.') throw new Error('synthetic ambiguous delivery');
    } });
    f.emit([message('approval-uncertain', start, { conversation: 'Созвонимся завтра в 15:00?' })]); await f.adapter.idle();
    const source = inboxId(`${recipient}:approval-uncertain`);
    const decision = { id: approvalId, agent_id: agentId, recipient, external_id: source, draft: 'Это проверка. Встреча не назначена.' };
    await f.poll([decision]); await f.poll([decision]);
    const events = await f.events();
    assert.equal(events.find(item => item.id === inboxId(`approved:${approvalId}`)).status, 'uncertain');
    assert.equal(f.attempts.filter(item => item.text === decision.draft).length, 1);
    await f.poll([{ ...decision, id: '55555555-5555-4555-8555-555555555555', recipient: '12345@g.us', draft: 'Never send this draft' }]);
    assert.equal((await f.events()).some(item => item.text === 'Never send this draft'), false);
});

test('pausing during durable outgoing capture prevents the subsequent provider send', async t => {
    let f, pause;
    f = await fixture(t, { upload: async payload => {
        if (!pause && payload.events.some(item => item.direction === 'outgoing' && item.status === 'sending')) pause = f.pause();
        return { ok: true, accepted: payload.events.length };
    } });
    f.emit([message('pause-before-send')]); await f.adapter.idle();
    await pause;
    assert.equal(f.attempts.length, 0);
    const events = await f.events();
    assert.equal(events.find(item => item.direction === 'outgoing').status, 'failed');
    assert.equal(events.find(item => item.direction === 'incoming').status, 'skipped');
});

test('scoped admission rejects fresh pre-activation imports before AI while legacy unscoped policy remains intact', async t => {
    const scoped = await fixture(t);
    scoped.emit([message('fresh-old-import', start - 60_000), message('invalid-source-id', start, { conversation: 'Как работает Wi-Fi?' }, { id: 'x'.repeat(257) })]);
    await scoped.adapter.idle();
    assert.deepEqual(await scoped.events(), []);
    assert.equal(scoped.requests.some(item => item.action === 'generate_whatsapp'), false);
    assert.deepEqual(scoped.attempts, []);
    const legacy = await fixture(t, { deviceId: null });
    legacy.emit([message('legacy-fresh', start - 60_000)]); await legacy.adapter.idle();
    assert.equal(legacy.requests.some(item => item.action === 'generate_whatsapp'), true);
    assert.equal(legacy.attempts.length, 1);
});
