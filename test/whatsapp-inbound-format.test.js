import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWhatsAppAdapter } from '../companion/whatsapp.mjs';
import { whatsappDiagnosticLogger } from '../companion/whatsapp-message.mjs';

test('library errors are reduced to fixed categories, including child loggers', () => {
    const kinds = [], leaked = [];
    const base = { error: (...args) => leaked.push(args), child() { return this; }, level: 'silent' };
    const logger = whatsappDiagnosticLogger(base, kind => kinds.push(kind));
    logger.error({ err: { message: 'private-payload-123456789' } }, 'Unexpected Error in processing offline nodes');
    logger.child({ component: 'test' }).error({ key: 'private-key' }, 'error in handling message');
    logger.error('other-private-payload');
    assert.deepEqual(kinds, ['offlineNode', 'message', 'other']);
    assert.deepEqual(leaked, []);
    assert.equal(logger.level, 'silent');
});

const personal = '77771234567@s.whatsapp.net';
const wrappers = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage'];
const wrap = (name, content) => ({ [name]: { message: content } });

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shaikh-wa-inbound-format-'));
    const ev = new EventEmitter(), sent = [], requests = [];
    let socketOptions;
    const socket = { ev, end() {}, async sendMessage(to, payload) { sent.push({ to, ...payload }); } };
    const adapter = await createWhatsAppAdapter({ stateDirectory: directory,
        request: async payload => {
            requests.push(structuredClone(payload));
            if (payload.action === 'generate_whatsapp') return { draft: 'Рассказывай.', category: 'casual', requiresApproval: false };
            return { ok: true };
        }, loadDependencies: async () => ({
            default(options) { socketOptions = options; return socket; },
            fetchLatestWaWebVersion: async () => ({ isLatest: true, version: [2, 3000, 1000000000] }),
            useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
            makeCacheableSignalKeyStore: keys => keys, Browsers: { macOS: () => ['test'] },
            pino: () => ({}), QRCode: { toDataURL: async () => 'data:image/png;base64,TEST' },
        }) });
    const agents = [{ id: 'agent-a', type: 'whatsapp', enabled: true, rules: '',
        examples: 'Сообщение: Как дела?\nМой ответ: Норм, а у тебя?' }];
    await adapter.onPoll({ agents });
    const connecting = adapter.handleJob({ kind: 'whatsapp_connect' });
    while (!socketOptions) await new Promise(resolve => setImmediate(resolve));
    ev.emit('connection.update', { qr: 'TEST' });
    await connecting;
    ev.emit('connection.update', { connection: 'open' });
    await new Promise(resolve => setImmediate(resolve));
    let serial = 0;
    function inbound(content, { rawJid = personal, jid = personal, id = `format-${serial++}`, type = 'notify', requestId,
        timestamp = Math.floor(Date.now() / 1000), fromMe = false, bypassTransport = false } = {}) {
        if (!bypassTransport && socketOptions.shouldIgnoreJid(rawJid)) return false;
        // Baileys normalizes a raw transport JID before messages.upsert.
        ev.emit('messages.upsert', { type, ...(requestId !== undefined ? { requestId } : {}), messages: [{
            key: { remoteJid: jid, id, fromMe, participant: personal }, message: content, messageTimestamp: timestamp,
        }] });
        return true;
    }
    t.after(async () => { await adapter.stop(); await fs.rm(directory, { recursive: true, force: true }); });
    return { adapter, inbound, sent, requests, options: socketOptions, directory, agents };
}

test('raw device and agent JIDs reach normalized personal chats without blocking control traffic', async t => {
    const f = await fixture(t);
    for (const rawJid of ['77771234567:2@s.whatsapp.net', '1234567890_0:2@lid']) {
        assert.equal(f.inbound({ conversation: 'Как дела?' }, { rawJid }), true);
    }
    await f.adapter.idle();
    assert.equal(f.sent.length, 2);
    assert.ok(f.sent.every(message => message.to === personal && message.text === 'Норм, а у тебя?'));
    for (const jid of ['server@c.us', '@s.whatsapp.net', 's.whatsapp.net']) assert.equal(f.options.shouldIgnoreJid(jid), false);
});

test('excluded surfaces remain blocked at transport and normalized message boundaries', async t => {
    const f = await fixture(t);
    for (const jid of ['123456789@g.us', 'status@broadcast', '123456789@broadcast', '123456789@newsletter']) {
        assert.equal(f.inbound({ conversation: 'Как дела?' }, { rawJid: jid, jid }), false);
        f.inbound(wrap('ephemeralMessage', { conversation: 'Как дела?' }), { rawJid: personal, jid, bypassTransport: true });
    }
    await f.adapter.idle();
    assert.equal(f.sent.length, 0);
    assert.equal(f.requests.some(request => ['generate_whatsapp', 'approval'].includes(request.action)), false);
});

test('supported disappearing text wrappers produce a short owner-style reply once', async t => {
    const f = await fixture(t);
    for (const name of wrappers) {
        const content = wrap(name, { extendedTextMessage: { text: 'Как дела?' } });
        f.inbound(content, { id: name });
        f.inbound(content, { id: name });
    }
    await f.adapter.idle();
    assert.equal(f.sent.length, wrappers.length);
    assert.ok(f.sent.every(message => message.text === 'Норм, а у тебя?'));
    assert.equal(f.requests.some(request => request.action === 'approval'), false);
});

test('a wrapped meeting is reviewed with its original text intact', async t => {
    const f = await fixture(t);
    const original = 'Давай завтра созвонимся в 15:00?';
    f.inbound(wrap('ephemeralMessage', wrap('viewOnceMessageV2', { extendedTextMessage: { text: original } })));
    await f.adapter.idle();
    assert.equal(f.sent.length, 0);
    const review = f.requests.find(request => request.action === 'approval');
    assert.ok(review);
    assert.equal(review.original, original);
    assert.equal(review.reason, 'meeting');
});

test('a fresh offline append is handled once even if the same message later arrives as notify', async t => {
    const f = await fixture(t);
    f.inbound({ conversation: 'Как дела?' }, { type: 'append', id: 'offline-recent' });
    f.inbound({ conversation: 'Как дела?' }, { type: 'notify', id: 'offline-recent' });
    await f.adapter.idle();
    assert.equal(f.sent.length, 1);
    assert.equal(f.requests.some(request => request.action === 'approval'), false);
});

test('stale offline entries, own messages and explicit history requests are ignored', async t => {
    const f = await fixture(t);
    f.inbound({ conversation: 'Как дела?' }, { type: 'append', timestamp: Math.floor(Date.now() / 1000) - 3600 });
    f.inbound({ conversation: 'Как дела?' }, { type: 'append', fromMe: true });
    for (const type of ['append', 'notify']) {
        f.inbound({ conversation: 'Как дела?' }, { type, requestId: 'requested-history-page' });
    }
    f.inbound({ conversation: 'Как дела?' }, { type: 'replace' });
    await f.adapter.idle();
    assert.equal(f.sent.length, 0);
    assert.equal(f.requests.some(request => ['generate_whatsapp', 'approval'].includes(request.action)), false);
});

test('edits, protocols and unsupported media never become new chat requests', async t => {
    const f = await fixture(t);
    for (const content of [
        { editedMessage: { message: { conversation: 'Как дела?' } } },
        { protocolMessage: { editedMessage: { conversation: 'Как дела?' } } },
        { conversation: 'Как дела?', protocolMessage: {} },
        wrap('ephemeralMessage', { protocolMessage: { editedMessage: { conversation: 'Как дела?' } } }),
        { imageMessage: { caption: 'Как дела?' } },
        { audioMessage: {} },
    ]) f.inbound(content);
    await f.adapter.idle();
    assert.equal(f.sent.length, 0);
    assert.equal(f.requests.some(request => ['generate_whatsapp', 'approval'].includes(request.action)), false);
});

test('bounded wrapper extraction rejects overdeep and cyclic content', async t => {
    const f = await fixture(t);
    let content = { conversation: 'Как дела?' };
    for (let depth = 0; depth < 12; depth++) content = wrap('ephemeralMessage', content);
    f.inbound(content);
    const cyclic = {}; cyclic.ephemeralMessage = { message: cyclic };
    f.inbound(cyclic);
    await f.adapter.idle();
    assert.equal(f.sent.length, 0);
    assert.equal(f.requests.some(request => ['generate_whatsapp', 'approval'].includes(request.action)), false);
});

test('local diagnostic stages contain counts without addresses, content or message IDs', async t => {
    const f = await fixture(t);
    const input = 'Проверка приватности короткого сообщения XYZ';
    const messageId = 'privacy-message-format-fixture-unique';
    const group = '123456789@g.us';
    f.inbound({ conversation: input }, { id: messageId });
    f.inbound({ conversation: 'Этот групповой текст должен игнорироваться' }, { rawJid: group, jid: group });
    await f.adapter.idle();
    await f.adapter.onPoll({ agents: f.agents });
    const filename = path.join(f.directory, 'whatsapp/diagnostics.json');
    const raw = await fs.readFile(filename, 'utf8');
    const diagnostics = JSON.parse(raw);
    assert.equal(diagnostics.counts['received.personalText'], 1);
    assert.equal(diagnostics.counts['decision.started'], 1);
    assert.equal(diagnostics.counts['send.sent'], 1);
    assert.equal(diagnostics.counts['transport.nonPersonalBlocked'], 1);
    for (const privateValue of [personal, group, input, messageId, 'Рассказывай.', 'Этот групповой текст должен игнорироваться']) {
        assert.equal(raw.includes(privateValue), false);
    }
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
});
