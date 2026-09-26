import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function filesIn(directory) {
    const result = [];
    for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) result.push(...filesIn(path));
        else if (path.endsWith('.js') || path.endsWith('.mjs')) result.push(path);
    }
    return result;
}

const files = [...filesIn('api'), ...filesIn('js'), ...filesIn('scripts')]
    .filter(path => !path.endsWith('check-js.mjs'));
let failed = false;
for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
        failed = true;
        process.stderr.write(`${file}\n${result.stderr}`);
    }
}
if (failed) process.exit(1);
console.log(`Syntax OK: ${files.length} JavaScript files`);

