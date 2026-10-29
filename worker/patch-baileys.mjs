import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const requireWorker = createRequire(new URL('./package.json', import.meta.url));
const expectedVersion = '6.7.24';
const original = '                    await nodeProcessor(node);';
const marker = '// SHAIKH: isolate offline handler failures (Baileys 6.7.24).';
// Upstream per-node error isolation:
// https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/src/Utils/offline-node-processor.ts
const replacement = [
    `                    ${marker}`,
    '                    await nodeProcessor(node).catch(error => {',
    '                        try { onUnexpectedError(error, `processing offline ${type}`); }',
    '                        catch { /* A failing error reporter must not lock the queue. */ }',
    '                    });',
].join('\n');

const occurrences = (source, text) => source.split(text).length - 1;
const fail = () => new Error('Unsupported Baileys offline queue source; no patch applied.');

export function patchOfflineQueue(source) {
    if (typeof source !== 'string'
        || occurrences(source, 'const makeOfflineNodeProcessor = () => {') !== 1
        || occurrences(source, 'const offlineNodeProcessor = makeOfflineNodeProcessor();') !== 1) throw fail();
    if (source.includes(marker)) {
        if (occurrences(source, marker) !== 1 || occurrences(source, replacement) !== 1 || occurrences(source, original) !== 0) throw fail();
        return source;
    }
    if (occurrences(source, original) !== 1) throw fail();
    const blockStart = source.indexOf('const makeOfflineNodeProcessor = () => {');
    const blockEnd = source.indexOf('const offlineNodeProcessor = makeOfflineNodeProcessor();', blockStart);
    const target = source.indexOf(original);
    if (target <= blockStart || target >= blockEnd) throw fail();
    return source.replace(original, replacement);
}

export async function main() {
    const entry = requireWorker.resolve('@whiskeysockets/baileys');
    const packageRoot = path.resolve(path.dirname(entry), '..');
    const metadata = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    if (metadata.name !== '@whiskeysockets/baileys' || metadata.version !== expectedVersion) {
        throw new Error('Offline queue patch requires the pinned Baileys 6.7.24 package.');
    }
    const filename = path.join(packageRoot, 'lib/Socket/messages-recv.js');
    const source = await fs.readFile(filename, 'utf8');
    const patched = patchOfflineQueue(source);
    if (patched === source) {
        console.log('Baileys offline queue patch is already applied.');
        return;
    }
    const temporary = `${filename}.shaikh-${randomUUID()}.tmp`;
    try {
        const mode = (await fs.stat(filename)).mode & 0o777;
        await fs.writeFile(temporary, patched, { mode, flag: 'wx' });
        await fs.rename(temporary, filename);
    } finally {
        await fs.rm(temporary, { force: true });
    }
    console.log('Applied the Baileys offline queue recovery patch.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(() => {
        console.error('Baileys offline queue patch failed. Verify the pinned dependency and reviewed source.');
        process.exitCode = 1;
    });
}
