import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWhatsAppAdapter } from '../companion/whatsapp.mjs';

const currentVersion = { isLatest: true, version: [2, 3000, 1000000000] };

async function until(predicate) {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('WhatsApp recovery did not complete');
        await sleep(2);
    }
}

async function fixture(t, version) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shaikh-wa-recovery-'));
    await fs.mkdir(path.join(directory, 'whatsapp'));
    await fs.writeFile(path.join(directory, 'whatsapp/active.json'), JSON.stringify({ agentId: 'test-agent' }));
    const agents = [{ id: 'test-agent', type: 'whatsapp', enabled: true, rules: '', examples: '' }];
    const sockets = [], options = [], requests = [];
    let protocolChecks = 0;
    const adapter = await createWhatsAppAdapter({ stateDirectory: directory, reconnectBaseMs: 5,
        request: async payload => { requests.push(payload); return { ok: true }; },
        loadDependencies: async () => ({
            fetchLatestWaWebVersion: async () => version(++protocolChecks),
            useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
            makeCacheableSignalKeyStore: keys => keys, Browsers: { macOS: () => ['test'] },
            pino: () => ({}), QRCode: { toDataURL: async () => { throw new Error('A paired device needs no new QR'); } },
            DisconnectReason: { loggedOut: 401 },
            default(config) {
                options.push(config);
                const socket = { ev: new EventEmitter(), end() {}, async sendMessage() { throw new Error('No real message sends in recovery tests'); } };
                sockets.push(socket);
                setImmediate(() => socket.ev.emit('connection.update', { connection: 'open' }));
                return socket;
            },
        }),
    });
    t.after(async () => { await adapter.stop(); await fs.rm(directory, { recursive: true, force: true }); });
    await adapter.onPoll({ agents });
    return { adapter, agents, sockets, options, requests, checks: () => protocolChecks };
}

for (const failure of ['offline', 'unverified']) {
    test(`a remembered device retries ${failure} protocol checks and reconnects without owner action`, async t => {
        const f = await fixture(t, attempt => {
            if (attempt < 3) {
                if (failure === 'offline') throw new Error('Temporary network outage');
                return { isLatest: false, version: [2, 1, 1] };
            }
            return currentVersion;
        });
        await until(() => f.adapter.status === 'connected');
        assert.equal(f.checks(), 3);
        assert.equal(f.sockets.length, 1);
        assert.equal(f.options[0].syncFullHistory, false);
        assert.equal(f.options[0].shouldIgnoreJid('123456789@g.us'), true);
        assert.equal(f.requests.some(request => request.action === 'approval'), false);
    });
}

test('an established connection recovers after close and a failed next protocol check', async t => {
    const f = await fixture(t, attempt => {
        if (attempt === 2) throw new Error('Network is still waking up');
        return currentVersion;
    });
    await until(() => f.adapter.status === 'connected');
    f.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
    await until(() => f.sockets.length === 2 && f.adapter.status === 'connected');
    assert.equal(f.checks(), 3);
    assert.deepEqual(f.options[1].version, currentVersion.version);
});

test('owner pause during a failing protocol check stays paused and stops retries', async t => {
    let rejectCheck;
    const f = await fixture(t, attempt => attempt === 1 ? currentVersion : new Promise((resolve, reject) => { rejectCheck = reject; }));
    await until(() => f.adapter.status === 'connected');
    f.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
    await until(() => Boolean(rejectCheck));
    await f.adapter.handleJob({ kind: 'whatsapp_disconnect' });
    rejectCheck(new Error('Temporary network outage'));
    await sleep(60);
    await f.adapter.onPoll({ agents: f.agents });
    assert.equal(f.adapter.status, 'paused');
    assert.equal(f.checks(), 2);
    assert.equal(f.sockets.length, 1);
});

test('disabling the agent during protocol verification prevents opening a new socket', async t => {
    let resolveCheck;
    const f = await fixture(t, () => new Promise(resolve => { resolveCheck = resolve; }));
    await until(() => Boolean(resolveCheck));
    await f.adapter.onPoll({ agents: [{ ...f.agents[0], enabled: false }] });
    resolveCheck(currentVersion);
    await sleep(60);
    assert.equal(f.adapter.status, 'paused');
    assert.equal(f.checks(), 1);
    assert.equal(f.sockets.length, 0);
});
