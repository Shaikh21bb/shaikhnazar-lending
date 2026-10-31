import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { generateEnvelopeKeyPair, encryptEnvelope, decryptEnvelope } from '../lib/private-envelope.mjs';

const projectFile = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('browser thought submission encrypts text and reply keys before calling the server', async () => {
    const source = await projectFile('js/workspace.js');
    const macKeys = await generateEnvelopeKeyPair();
    const thought = 'PRIVATE FIXTURE: обсудить проект завтра в 15:00';
    const stored = new Map();
    let outbound;
    const context = vm.createContext({
        generateEnvelopeKeyPair, encryptEnvelope, decryptEnvelope, crypto: webcrypto,
        document: {}, setTimeout, clearTimeout, setInterval, clearInterval,
        sessionStorage: { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) },
        fetch: async (url, request) => { outbound = { url, body: JSON.parse(request.body) }; return { ok: true, status: 200, json: async () => ({ job: { id: 'job-1' } }) }; }
    });
    vm.runInContext(source.replace(/^import .*;\n/, '').replace(/\ninit\(\);\s*$/, ''), context);
    context.fixturePublicKey = macKeys.publicKey;
    context.fixtureThought = thought;
    await vm.runInContext("state.data = { device: { public_key: fixturePublicKey } }; enqueueEncrypted('thought', {text: fixtureThought, intent: 'thought'})", context);
    assert.equal(outbound.url, '/api/hub/workspace');
    assert.equal(outbound.body.action, 'enqueue');
    assert.equal(outbound.body.kind, 'thought');
    assert.ok(outbound.body.request_id);
    assert.equal(JSON.stringify(outbound).includes(thought), false, 'the HTTP request must never contain clear note content');
    const payload = await decryptEnvelope(macKeys.privateKey, outbound.body.envelope);
    assert.equal(payload.text, thought);
    assert.equal(payload.intent, 'thought');
    assert.equal(payload.replyPublicKey.kty, 'RSA');
    assert.equal(JSON.stringify([...stored.values()]).includes(thought), false, 'browser storage must not keep clear thought drafts');
});

test('browser refuses a thought until a local Mac public key has been paired', async () => {
    const source = await projectFile('js/workspace.js');
    let called = false;
    const context = vm.createContext({ document: {}, generateEnvelopeKeyPair, encryptEnvelope, decryptEnvelope,
        fetch: () => { called = true; }, setTimeout, clearTimeout });
    vm.runInContext(source.replace(/^import .*;\n/, '').replace(/\ninit\(\);\s*$/, ''), context);
    await assert.rejects(vm.runInContext("enqueueEncrypted('thought', {text: 'secret'})", context), /Сначала привяжите Mac/);
    assert.equal(called, false);
});

test('an ambiguous network failure retries the same encrypted request without duplicating a thought', async () => {
    const source = await projectFile('js/workspace.js');
    const keys = await generateEnvelopeKeyPair();
    const requests = [];
    const context = vm.createContext({ document: {}, generateEnvelopeKeyPair, encryptEnvelope, decryptEnvelope,
        crypto: webcrypto, setTimeout, clearTimeout,
        sessionStorage: { getItem: () => null, setItem() {} },
        fetch: async (url, request) => {
            requests.push(JSON.parse(request.body));
            if (requests.length === 1) throw new Error('connection lost after server accepted');
            return { ok: true, status: 200, json: async () => ({ job: { id: 'existing-job' } }) };
        }
    });
    vm.runInContext(source.replace(/^import .*;\n/, '').replace(/\ninit\(\);\s*$/, ''), context);
    context.fixtureKey = keys.publicKey;
    vm.runInContext('state.data = {device:{public_key:fixtureKey}};', context);
    const call = "enqueueEncrypted('thought', {text:'same private thought',intent:'thought'}, {retry:true})";
    await assert.rejects(vm.runInContext(call, context), /connection lost/);
    await vm.runInContext(call, context);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], requests[0], 'the request id and encrypted envelope must both survive a retry');
});

test('login returns owner and client to an allowlisted workspace without accepting external redirects', async () => {
    const login = await projectFile('login.html');
    const start = login.indexOf('            const requestedPage =');
    const end = login.indexOf('            let authAttempted = false;', start);
    assert.ok(start >= 0 && end > start);
    const snippet = login.slice(start, end);
    for (const [next, expected] of [
        [null, 'workspace.html'],
        ['workspace.html', 'workspace.html'], ['/workspace', 'workspace.html'],
        ['hub.html', 'hub.html'], ['/hub', 'hub.html'],
        ['//evil.example', 'workspace.html'], ['https://evil.example', 'workspace.html'],
        ['/workspace?next=https://evil.example', 'workspace.html'], ['javascript:alert(1)', 'workspace.html']
    ]) {
        const context = vm.createContext({ URLSearchParams, window: { location: { search: next === null ? '' : `?next=${encodeURIComponent(next)}` } } });
        vm.runInContext(snippet, context);
        assert.equal(vm.runInContext("destinationFor('client')", context), expected);
        assert.equal(vm.runInContext("destinationFor('manager')", context), 'dashboard.html');
        assert.equal(vm.runInContext("destinationFor('owner')", context), ['workspace.html', 'hub.html', '/workspace', '/hub'].includes(next) ? expected : 'dashboard.html');
    }
});
