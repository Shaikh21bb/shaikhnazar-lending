import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWhatsAppAdapter } from '../companion/whatsapp.mjs';

const person = '77771234567@s.whatsapp.net';

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shaikh-wa-buffer-'));
    let clock = Date.now(), buffered = false, flushes = 0, options;
    const emitter = new EventEmitter(), queued = [], requests = [], sent = [];
    const ev = {
        on: (...args) => emitter.on(...args),
        emit(name, value) {
            if (name === 'messages.upsert' && buffered) { queued.push([name, value]); return true; }
            return emitter.emit(name, value);
        },
        buffer() { buffered = true; },
        isBuffering: () => buffered,
        flush() {
            flushes++;
            if (!buffered) return false;
            buffered = false;
            for (const [name, value] of queued.splice(0)) emitter.emit(name, value);
            return true;
        },
    };
    const socket = { ev, ws: { isOpen: true }, end() {}, async sendMessage(to, payload) { sent.push({ to, ...payload }); } };
    const adapter = await createWhatsAppAdapter({ stateDirectory: directory, now: () => clock,
        request: async payload => {
            requests.push(payload);
            if (payload.action === 'generate_whatsapp') return { draft: 'Норм, а у тебя?', category: 'casual', requiresApproval: false };
            return { ok: true };
        }, loadDependencies: async () => ({
            default(config) { options = config; return socket; },
            fetchLatestWaWebVersion: async () => ({ isLatest: true, version: [2, 3000, 1000000000] }),
            useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
            makeCacheableSignalKeyStore: keys => keys, Browsers: { macOS: () => ['test'] },
            pino: () => ({}), QRCode: { toDataURL: async () => 'data:image/png;base64,TEST' },
        }) });
    const agents = [{ id: 'buffer-agent', type: 'whatsapp', enabled: true, rules: '', examples: '' }];
    await adapter.onPoll({ agents });
    const connecting = adapter.handleJob({ kind: 'whatsapp_connect' });
    while (!options) await new Promise(resolve => setImmediate(resolve));
    ev.emit('connection.update', { qr: 'TEST' });
    await connecting;
    ev.emit('connection.update', { connection: 'open' });
    await new Promise(resolve => setImmediate(resolve));
    let serial = 0;
    const queue = ({ jid = person, id = `buffer-${serial++}`, fromMe = false,
        timestamp = Math.floor(clock / 1000), type = 'append' } = {}) => {
        ev.buffer();
        ev.emit('messages.upsert', { type, messages: [{ key: { remoteJid: jid, id, fromMe },
            message: { conversation: 'Ты как, всё нормально?' }, messageTimestamp: timestamp }] });
    };
    t.after(async () => { await adapter.stop(); await fs.rm(directory, { recursive: true, force: true }); });
    return { adapter, agents, socket, queue, requests, sent, directory,
        advance: ms => { clock += ms; }, flushes: () => flushes };
}

test('a late fresh offline upsert is released after startup grace and replies once', async t => {
    const f = await fixture(t);
    f.queue({ id: 'same-offline-message' });
    f.queue({ id: 'same-offline-message', type: 'notify' });
    f.advance(4999);
    await f.adapter.onPoll({ agents: f.agents });
    assert.equal(f.flushes(), 0);
    assert.equal(f.sent.length, 0);
    f.advance(2);
    await f.adapter.onPoll({ agents: f.agents });
    await f.adapter.idle();
    assert.equal(f.flushes(), 1);
    assert.deepEqual(f.sent, [{ to: person, text: 'Норм, а у тебя?' }]);
    await f.adapter.onPoll({ agents: f.agents });
    await f.adapter.idle();
    assert.equal(f.flushes(), 1);
    assert.equal(f.sent.length, 1);
    const diagnostics = JSON.parse(await fs.readFile(path.join(f.directory, 'whatsapp/diagnostics.json'), 'utf8'));
    assert.equal(diagnostics.counts['buffer.recovered'], 1);
});

test('releasing a stuck batch still ignores group, stale and owner messages', async t => {
    const f = await fixture(t);
    f.queue({ jid: '123456789@g.us' });
    f.queue({ timestamp: Math.floor(Date.now() / 1000) - 3600 });
    f.queue({ fromMe: true });
    f.advance(5001);
    await f.adapter.onPoll({ agents: f.agents });
    await f.adapter.idle();
    assert.equal(f.flushes(), 1);
    assert.equal(f.sent.length, 0);
    assert.equal(f.requests.some(request => ['generate_whatsapp', 'approval'].includes(request.action)), false);
});

test('closed transport does not release buffered messages even after startup grace', async t => {
    const f = await fixture(t);
    f.queue();
    f.advance(10000);
    f.socket.ws.isOpen = false;
    await f.adapter.onPoll({ agents: f.agents });
    await f.adapter.idle();
    assert.equal(f.flushes(), 0);
    assert.equal(f.sent.length, 0);
});

for (const action of ['pause', 'disable']) {
    test(`${action} prevents recovery from releasing or sending buffered messages`, async t => {
        const f = await fixture(t);
        f.queue();
        f.advance(10000);
        if (action === 'pause') await f.adapter.handleJob({ kind: 'whatsapp_disconnect' });
        await f.adapter.onPoll({ agents: action === 'disable' ? [{ ...f.agents[0], enabled: false }] : f.agents });
        await f.adapter.idle();
        assert.equal(f.adapter.status, 'paused');
        assert.equal(f.flushes(), 0);
        assert.equal(f.sent.length, 0);
    });
}
