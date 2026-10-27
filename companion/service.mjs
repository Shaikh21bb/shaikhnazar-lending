#!/usr/bin/env node
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const execute = promisify(execFile);
export const LABELS = Object.freeze({ companion: 'digital.shaikh.companion', ollama: 'digital.shaikh.ollama' });
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failure = message => Object.assign(new Error(message), { safe: true });
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));

function xml(value) {
    if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
    if (typeof value === 'number') return `<integer>${value}</integer>`;
    if (Array.isArray(value)) return `<array>${value.map(xml).join('')}</array>`;
    if (typeof value === 'object' && value) return `<dict>${Object.entries(value).map(([key, item]) => `<key>${escape(key)}</key>${xml(item)}`).join('')}</dict>`;
    return `<string>${escape(value)}</string>`;
}

export function plist(value) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${xml(value)}</plist>\n`;
}

export function serviceDefinitions({ home = os.homedir(), root = projectRoot, node = process.execPath, ollama = '/opt/homebrew/bin/ollama' } = {}) {
    const stateDirectory = path.join(home, 'Library/Application Support/SHAIKH/companion');
    const logs = path.join(stateDirectory, 'logs');
    const common = { RunAtLoad: true, KeepAlive: true, ThrottleInterval: 10, ExitTimeOut: 120, ProcessType: 'Background', Umask: 0o077, WorkingDirectory: root };
    return {
        companion: { ...common, Label: LABELS.companion, ProgramArguments: [node, path.join(root, 'companion/start.mjs')],
            StandardOutPath: path.join(logs, 'agent.log'), StandardErrorPath: path.join(logs, 'agent-error.log') },
        ollama: { ...common, Label: LABELS.ollama, ProgramArguments: [node, path.join(root, 'companion/service.mjs'), 'model-host', ollama],
            EnvironmentVariables: { OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_NO_CLOUD: '1', OLLAMA_NOPRUNE: '1', OLLAMA_DEBUG_LOG_REQUESTS: 'false' },
            StandardOutPath: path.join(logs, 'ollama.log'), StandardErrorPath: path.join(logs, 'ollama-error.log') }
    };
}

export function startupPlan({ companionLoaded, ollamaLoaded, portInUse }) {
    const actions = [];
    // A pre-existing listener may belong to another app or the user. Never
    // kill, replace or change it merely to enable the private companion.
    if (!portInUse) actions.push(ollamaLoaded ? 'kickstart_ollama' : 'bootstrap_ollama');
    if (!companionLoaded) actions.push('bootstrap_companion');
    return actions;
}

async function executable(name) {
    const candidates = [...new Set([...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])];
    for (const directory of candidates) {
        if (!path.isAbsolute(directory)) continue;
        const filename = path.join(directory, name);
        try { await fs.access(filename, constants.X_OK); return filename; } catch { /* Try the next installed binary. */ }
    }
    return null;
}

export function portIsInUse() {
    return new Promise(resolve => {
        const socket = net.createConnection({ host: '127.0.0.1', port: 11434 });
        let done = false;
        const finish = occupied => { if (done) return; done = true; socket.destroy(); resolve(occupied); };
        socket.setTimeout(1500);
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        socket.once('timeout', () => finish(false));
    });
}

export async function runOllamaHost(binary, { probe = portIsInUse, spawnImpl = spawn, signal, wait = sleep } = {}) {
    if (!path.isAbsolute(binary) || path.basename(binary) !== 'ollama') throw failure('Нужен абсолютный путь к установленному Ollama.');
    const controller = new AbortController();
    const stopped = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let child;
    const shutdown = () => { controller.abort(); child?.kill('SIGTERM'); };
    const abortChild = () => { child?.kill('SIGTERM'); };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    stopped.addEventListener('abort', abortChild);
    try {
        while (!stopped.aborted) {
            if (!(await probe()) && !stopped.aborted) {
                child = spawnImpl(binary, ['serve'], { shell: false, stdio: 'inherit', env: { ...process.env,
                    OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_NO_CLOUD: '1', OLLAMA_NOPRUNE: '1', OLLAMA_DEBUG_LOG_REQUESTS: 'false' } });
                await new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
                child = undefined;
            }
            if (!stopped.aborted) {
                try { await wait(5000, undefined, { signal: stopped }); } catch (error) { if (error.name !== 'AbortError') throw error; }
            }
        }
    } finally {
        process.removeListener('SIGTERM', shutdown);
        process.removeListener('SIGINT', shutdown);
        stopped.removeEventListener('abort', abortChild);
        child?.kill('SIGTERM');
    }
}

async function exists(filename) { try { await fs.access(filename); return true; } catch { return false; } }

export async function service(command, { home = os.homedir(), root = projectRoot, node = process.execPath, run = execute, probe = portIsInUse, uid = process.getuid?.(), platform = process.platform } = {}) {
    if (platform !== 'darwin' || !Number.isInteger(uid)) throw failure('Автозапуск доступен только на Mac в вашей пользовательской сессии.');
    if (!['prepare', 'install', 'uninstall', 'status', 'start', 'stop'].includes(command)) throw failure('Команды: prepare, install, start, stop, status, uninstall.');
    const domain = `gui/${uid}`;
    const target = kind => `${domain}/${LABELS[kind]}`;
    const agentsDirectory = path.join(home, 'Library/LaunchAgents');
    const stateDirectory = path.join(home, 'Library/Application Support/SHAIKH/companion');
    const filename = kind => path.join(agentsDirectory, `${LABELS[kind]}.plist`);
    const loaded = async kind => { try { await run('/bin/launchctl', ['print', target(kind)]); return true; } catch { return false; } };
    const status = async () => ({ installed: await exists(filename('companion')),
        companionLoaded: await loaded('companion'), ollamaLoaded: await loaded('ollama'), ollamaPortInUse: await probe() });
    if (command === 'status') return status();
    if (command === 'stop' || command === 'uninstall') {
        for (const kind of command === 'uninstall' ? ['companion', 'ollama'] : ['companion']) {
            if (await loaded(kind)) await run('/bin/launchctl', ['bootout', target(kind)]);
            if (command === 'uninstall') {
                try { await fs.unlink(filename(kind)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
        }
        return status();
    }
    if (command !== 'prepare') {
        let config;
        try { config = JSON.parse(await fs.readFile(path.join(stateDirectory, 'config.json'), 'utf8')); } catch { /* No configuration has been paired yet. */ }
        if (!config?.token || !config?.privateKey || !config?.vaultPath) throw failure('Сначала подключите Mac одноразовым кодом из кабинета.');
    }
    const ollama = await executable('ollama');
    if (!ollama) throw failure('Не найден установленный Ollama. Установите его перед настройкой автозапуска.');
    if (command === 'prepare' || command === 'install') {
        await fs.mkdir(agentsDirectory, { recursive: true });
        await fs.mkdir(path.join(stateDirectory, 'logs'), { recursive: true, mode: 0o700 });
        await fs.chmod(stateDirectory, 0o700);
        await fs.chmod(path.join(stateDirectory, 'logs'), 0o700);
        const definitions = serviceDefinitions({ home, root, node, ollama });
        for (const kind of ['companion', 'ollama']) {
            await fs.writeFile(filename(kind), plist(definitions[kind]), { mode: 0o600 });
            await fs.chmod(filename(kind), 0o600);
        }
    } else if (!(await exists(filename('companion')))) {
        throw failure('Автозапуск ещё не настроен. После подключения Mac выполните node companion/service.mjs install.');
    }
    if (command === 'prepare') return { prepared: true, ...await status() };
    const current = await status();
    const actions = startupPlan({ ...current, portInUse: current.ollamaPortInUse });
    if (command === 'start' && current.companionLoaded) actions.push('kickstart_companion');
    for (const action of actions) {
        const [operation, kind] = action.split('_');
        await run('/bin/launchctl', operation === 'bootstrap' ? ['bootstrap', domain, filename(kind)] : ['kickstart', target(kind)]);
    }
    return status();
}

export async function main(argv = process.argv.slice(2)) {
    const [command = 'status', ...extra] = argv;
    if (command === 'model-host') {
        if (extra.length !== 1) throw failure('Нужен путь к установленному Ollama.');
        await runOllamaHost(extra[0]);
        return;
    }
    if (extra.length) throw failure('Укажите одну команду: install, start, stop, status или uninstall.');
    const result = await service(command);
    console.log(JSON.stringify(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(error.safe ? error.message : 'Не удалось изменить автозапуск. Проверьте пользовательскую сессию Mac и права на папку LaunchAgents.'); process.exitCode = 1; });
}
