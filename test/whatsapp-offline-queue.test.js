import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { patchOfflineQueue } from '../worker/patch-baileys.mjs';

const requireWorker = createRequire(new URL('../worker/package.json', import.meta.url));
let vendorSource;
try {
    const root = path.resolve(path.dirname(requireWorker.resolve('@whiskeysockets/baileys')), '..');
    const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    assert.equal(metadata.version, '6.7.24', 'queue regression requires the reviewed pinned dependency');
    vendorSource = await fs.readFile(path.join(root, 'lib/Socket/messages-recv.js'), 'utf8');
} catch (error) {
    if (!['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(error.code)) throw error;
}
const optional = { skip: !vendorSource && 'Optional WhatsApp worker dependencies are absent; run npm ci --prefix worker.' };

function processor(source, handler, report) {
    const start = source.indexOf('const makeOfflineNodeProcessor = () => {');
    const end = source.indexOf('const offlineNodeProcessor = makeOfflineNodeProcessor();', start);
    assert.ok(start >= 0 && end > start);
    const block = source.slice(start, end);
    // Execute only this trusted, locally installed vendor queue in the test.
    // The production patcher never evaluates source or message content.
    const create = new Function('ws', 'onUnexpectedError', 'handleMessage', 'handleCall', 'handleReceipt', 'handleNotification',
        `${block}\nreturn makeOfflineNodeProcessor();`);
    return create({ isOpen: true }, report, handler, handler, handler, handler);
}

async function until(predicate) {
    const deadline = Date.now() + 1000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Offline queue recovery did not complete');
        await sleep(2);
    }
}

test('offline queue patch is an idempotent reviewed replacement', optional, () => {
    const patched = patchOfflineQueue(vendorSource);
    assert.match(patched, /await nodeProcessor\(node\)\.catch/);
    assert.equal(patchOfflineQueue(patched), patched);
    assert.equal(patched.includes('                    await nodeProcessor(node);'), false);
});

test('a rejected offline handler does not prevent queued or later healthy nodes', optional, async () => {
    const processed = [], reported = [];
    const queue = processor(patchOfflineQueue(vendorSource), async node => {
        if (node.id === 'bad') throw new Error('Synthetic handler failure');
        processed.push(node.id);
    }, (error, stage) => reported.push({ error, stage }));
    queue.enqueue('message', { id: 'bad' });
    queue.enqueue('message', { id: 'next' });
    await until(() => processed.length === 1);
    queue.enqueue('notification', { id: 'later' });
    await until(() => processed.length === 2);
    assert.deepEqual(processed, ['next', 'later']);
    assert.equal(reported.length, 1);
    assert.equal(reported[0].stage, 'processing offline message');
});

test('a throwing error reporter also cannot leave the offline queue locked', optional, async () => {
    const processed = [];
    let reported = 0;
    const queue = processor(patchOfflineQueue(vendorSource), async node => {
        if (node.id === 'bad') throw new Error('Synthetic handler failure');
        processed.push(node.id);
    }, () => { reported++; throw new Error('Synthetic reporter failure'); });
    queue.enqueue('receipt', { id: 'bad' });
    queue.enqueue('message', { id: 'next' });
    await until(() => processed.length === 1);
    assert.equal(reported, 1);
    assert.deepEqual(processed, ['next']);
});

test('the original reviewed vendor queue reproduces the rejected-handler lock', optional, async t => {
    if (!vendorSource.includes('                    await nodeProcessor(node);')) {
        t.skip('Installed vendor source already has the recovery patch.');
        return;
    }
    const processed = [], reported = [];
    const queue = processor(vendorSource, async node => {
        if (node.id === 'bad') throw new Error('Synthetic handler failure');
        processed.push(node.id);
    }, error => reported.push(error));
    queue.enqueue('message', { id: 'bad' });
    queue.enqueue('message', { id: 'next' });
    await until(() => reported.length === 1);
    queue.enqueue('message', { id: 'later' });
    await sleep(15);
    assert.deepEqual(processed, []);
});

test('unknown, duplicate and malformed already-patched source are rejected', () => {
    assert.throws(() => patchOfflineQueue('not the reviewed vendor source'), /Unsupported/);
    if (!vendorSource) return;
    const original = '                    await nodeProcessor(node);';
    const patched = patchOfflineQueue(vendorSource);
    assert.throws(() => patchOfflineQueue(`${patched}\n${original}`), /Unsupported/);
    assert.throws(() => patchOfflineQueue(patched.replace('.catch(error => {', '.catch(other => {')), /Unsupported/);
    assert.throws(() => patchOfflineQueue(vendorSource + '\nconst makeOfflineNodeProcessor = () => {};'), /Unsupported/);
});
