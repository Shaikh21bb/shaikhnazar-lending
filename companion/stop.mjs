#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const lockPath = path.join(os.homedir(), 'Library/Application Support/SHAIKH/companion/agent.pid');
try {
    const pid = Number((await fs.readFile(lockPath, 'utf8')).trim());
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('invalid_pid');
    const { stdout } = await promisify(execFile)('/bin/ps', ['-p', String(pid), '-o', 'command=']);
    if (!/\bnode\b.*(?:companion\/start\.mjs)/u.test(stdout)) throw new Error('different_process');
    process.kill(pid, 'SIGTERM');
    console.log('Личный агент останавливается. Заметки и подключение WhatsApp сохранены на Mac.');
} catch {
    console.log('Личный агент сейчас не запущен.');
}
