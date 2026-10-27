import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main as start } from '../companion/start.mjs';
import { LABELS, plist, serviceDefinitions, startupPlan, service, runOllamaHost } from '../companion/service.mjs';

async function fixture(t) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'shaikh-service-test-'));
    const state = path.join(home, 'Library/Application Support/SHAIKH/companion');
    const agents = path.join(home, 'Library/LaunchAgents');
    await fs.mkdir(state, { recursive: true });
    await fs.mkdir(agents, { recursive: true });
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    return { home, state, agents };
}

test('re-pairing a running companion cannot rotate its token or overwrite config', async t => {
    const f = await fixture(t);
    const filename = path.join(f.state, 'config.json');
    const original = JSON.stringify({ token: 'existing-test-token', privateKey: { d: 'test-only' }, vaultPath: '/fixture/vault' });
    await fs.writeFile(filename, original);
    await fs.writeFile(path.join(f.state, 'agent.pid'), String(process.pid));
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error('Pairing must not run'); };
    try {
        await assert.rejects(start(['--state-dir', f.state, '--pair', 'fake-pairing-code', '--url', 'https://shaikh.digital']), /уже запущен/);
        assert.equal(networkCalls, 0);
        assert.equal(await fs.readFile(filename, 'utf8'), original);
        assert.equal(await fs.readFile(path.join(f.state, 'agent.pid'), 'utf8'), String(process.pid));
    } finally { globalThis.fetch = originalFetch; }
});

test('launchd definitions have absolute binaries, private logs and local-only Ollama settings', () => {
    const definitions = serviceDefinitions({ home: '/Users/example', root: '/Users/example/My Project', node: '/usr/local/bin/node', ollama: '/opt/homebrew/bin/ollama' });
    assert.deepEqual(definitions.companion.ProgramArguments, ['/usr/local/bin/node', '/Users/example/My Project/companion/start.mjs']);
    assert.equal(definitions.companion.KeepAlive, true);
    assert.equal(definitions.companion.Umask, 0o077);
    assert.equal(definitions.ollama.EnvironmentVariables.OLLAMA_NO_CLOUD, '1');
    assert.equal(definitions.ollama.EnvironmentVariables.OLLAMA_HOST, '127.0.0.1:11434');
    assert.equal(JSON.stringify(definitions).includes('privateKey'), false);
    assert.equal(JSON.stringify(definitions).includes('vaultPath'), false);
    assert.match(plist({ path: 'A&B <C>' }), /A&amp;B &lt;C&gt;/);
});

test('a pre-existing Ollama listener is never stopped or replaced by startup planning', () => {
    assert.deepEqual(startupPlan({ companionLoaded: false, ollamaLoaded: false, portInUse: true }), ['bootstrap_companion']);
    assert.deepEqual(startupPlan({ companionLoaded: true, ollamaLoaded: false, portInUse: true }), []);
    assert.deepEqual(startupPlan({ companionLoaded: false, ollamaLoaded: true, portInUse: false }), ['kickstart_ollama', 'bootstrap_companion']);
});

test('the model service waits beside an existing listener without starting or killing a process', async () => {
    const controller = new AbortController();
    let starts = 0;
    await runOllamaHost('/opt/homebrew/bin/ollama', { signal: controller.signal, probe: async () => true,
        spawnImpl: () => { starts++; throw new Error('Must not replace an existing listener'); },
        wait: async () => { controller.abort(); } });
    assert.equal(starts, 0);
});

test('managed stop unloads only the companion; uninstall keeps config and unrelated agents', async t => {
    const f = await fixture(t);
    const loaded = new Set(Object.values(LABELS));
    const operations = [];
    const run = async (_binary, args) => {
        const label = args.at(-1).split('/').at(-1);
        if (args[0] === 'print' && !loaded.has(label)) throw new Error('Not loaded');
        if (args[0] === 'bootout') { operations.push(args); loaded.delete(label); }
        return { stdout: '' };
    };
    for (const label of [...Object.values(LABELS), 'other.agent']) await fs.writeFile(path.join(f.agents, `${label}.plist`), 'fixture');
    await fs.writeFile(path.join(f.state, 'config.json'), 'keep-owner-config');
    const options = { home: f.home, platform: 'darwin', uid: 501, run, probe: async () => true };
    await service('stop', options);
    assert.deepEqual(operations.map(args => args.at(-1)), ['gui/501/digital.shaikh.companion']);
    assert.equal(loaded.has(LABELS.ollama), true);
    await service('uninstall', options);
    assert.equal(await fs.readFile(path.join(f.agents, 'other.agent.plist'), 'utf8'), 'fixture');
    assert.equal(await fs.readFile(path.join(f.state, 'config.json'), 'utf8'), 'keep-owner-config');
    assert.equal(loaded.size, 0);
});

test('install prepares private plists and leaves an unrelated active model listener untouched', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.state, 'config.json'), JSON.stringify({ token: 'fixture', privateKey: { d: 'fixture' }, vaultPath: '/fixture' }));
    const loaded = new Set();
    const operations = [];
    const run = async (_binary, args) => {
        if (args[0] === 'print' && !loaded.has(args.at(-1).split('/').at(-1))) throw new Error('Not loaded');
        if (args[0] === 'bootstrap') { operations.push(args); loaded.add(path.basename(args.at(-1), '.plist')); }
        return { stdout: '' };
    };
    const result = await service('install', { home: f.home, platform: 'darwin', uid: 501, run, probe: async () => true });
    assert.equal(result.companionLoaded, true);
    assert.equal(result.ollamaLoaded, false);
    assert.equal(operations.length, 1);
    assert.match(operations[0].at(-1), /digital\.shaikh\.companion\.plist$/);
    assert.equal((await fs.stat(path.join(f.state, 'logs'))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(f.agents, `${LABELS.companion}.plist`))).mode & 0o777, 0o600);
    const definition = await fs.readFile(path.join(f.agents, `${LABELS.companion}.plist`), 'utf8');
    assert.equal(definition.includes('fixture'), false, 'no config token, private key or vault path belongs in launchd');
});
