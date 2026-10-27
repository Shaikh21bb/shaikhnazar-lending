#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateEnvelopeKeyPair, validatePublicKey } from '../lib/private-envelope.mjs';
import { discoverVaults } from './vault.mjs';
import { LocalModel, localModelURL } from './model.mjs';
import { createCompanion, readPrivateJSON, writePrivateJSON, deviceRequest } from './runtime.mjs';

export function parseArguments(argv) {
    const options = {};
    const valued = new Set(['--pair', '--url', '--vault', '--model', '--model-url', '--state-dir']);
    const flags = new Set(['--once', '--status', '--help', '--telegram-dialogue', '--no-telegram-dialogue', '--telegram-voice', '--no-telegram-voice']);
    for (let index = 0; index < argv.length; index++) {
        const key = argv[index];
        if (valued.has(key)) {
            if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Укажи значение ${key}.`);
            options[key.slice(2)] = argv[++index];
        } else if (flags.has(key)) options[key.slice(2)] = true;
        else throw new Error('Неизвестный параметр. Справка: node companion/start.mjs --help');
    }
    if (options['telegram-dialogue'] && options['no-telegram-dialogue']) throw new Error('Выбери включение или выключение диалога Telegram.');
    if (options['telegram-voice'] && options['no-telegram-voice']) throw new Error('Выбери включение или выключение голосовых Telegram.');
    return options;
}

export const defaultStateDirectory = () => path.join(os.homedir(), 'Library/Application Support/SHAIKH/companion');

async function selectVault(explicit, saved) {
    if (explicit) {
        const directory = path.resolve(explicit);
        const stat = await fs.stat(directory);
        if (!stat.isDirectory()) throw new Error('Путь --vault должен указывать на папку Obsidian.');
        return directory;
    }
    if (saved) return saved;
    const vaults = await discoverVaults();
    if (vaults.length === 1) return vaults[0].path;
    if (!vaults.length) throw new Error('Не найдена база Obsidian. Укажи её папку через --vault.');
    throw new Error('На Mac несколько баз Obsidian. Выбери одну параметром --vault "/путь/к/базе".');
}

async function claimLock(stateDirectory) {
    const lockPath = path.join(stateDirectory, 'agent.pid');
    try {
        const current = Number((await fs.readFile(lockPath, 'utf8')).trim());
        if (Number.isSafeInteger(current) && current > 1) {
            try { process.kill(current, 0); throw new Error('Личный агент уже запущен. Для остановки используй stop-personal-agent.command.'); }
            catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        await fs.unlink(lockPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.writeFile(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
    return async () => {
        try { if ((await fs.readFile(lockPath, 'utf8')).trim() === String(process.pid)) await fs.unlink(lockPath); }
        catch { /* A previous shutdown may already have removed the lock. */ }
    };
}

export async function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    if (options.help) {
        console.log('SHAIKH — локальный личный агент\n\nПервое подключение:\n  node companion/start.mjs --pair КОД --url https://shaikh.digital\n\nДальше:\n  node companion/start.mjs\n\nПараметры: --vault "/папка/Obsidian", --model ИМЯ, --model-url http://127.0.0.1:11434, --once, --status\nДиалог: --telegram-dialogue / --no-telegram-dialogue. При включении ответы по заметкам отправляются владельцу в Telegram. База, история и AI-обработка остаются на Mac.\nМодель и заметки не отправляются в облачные AI-сервисы.');
        console.log('Голосовые: --telegram-voice / --no-telegram-voice. Нужны локальные speechPython, speechModelPath и ffmpegPath в конфигурации; распознавание работает без сети.');
        return;
    }
    const stateDirectory = options['state-dir'] ? path.resolve(options['state-dir']) : defaultStateDirectory();
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(stateDirectory, 0o700);
    const configPath = path.join(stateDirectory, 'config.json');
    const config = await readPrivateJSON(configPath, {});
    if (options['telegram-dialogue']) config.telegramDialogueEnabled = true;
    if (options['no-telegram-dialogue']) config.telegramDialogueEnabled = false;
    if (options['telegram-voice']) config.telegramVoiceEnabled = true;
    if (options['no-telegram-voice']) config.telegramVoiceEnabled = false;
    config.modelURL = localModelURL(options['model-url'] || config.modelURL || 'http://127.0.0.1:11434').toString().replace(/\/$/, '');
    config.model = options.model || config.model || '';
    if (options.status) {
        const model = await new LocalModel({ url: config.modelURL, model: config.model }).status();
        console.log(`Кабинет: ${config.token ? 'сопряжён' : 'не сопряжён'}. Локальная модель: ${model.ready ? 'готова' : 'недоступна'}.`);
        return;
    }
    // Reserve this Mac before rotating its server token. A running instance
    // must keep its working credential when a second pairing command is run.
    const unlock = await claimLock(stateDirectory);
    try {
        config.vaultPath = await selectVault(options.vault, config.vaultPath);
        if (options.pair) {
            const base = new URL(options.url || config.baseURL || 'https://shaikh.digital');
            if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw new Error('Для сопряжения требуется HTTPS.');
            let keys;
            if (config.baseURL === base.origin && config.publicKey && config.privateKey) {
                validatePublicKey(config.publicKey);
                if (config.privateKey.n !== config.publicKey.n || config.privateKey.e !== config.publicKey.e) throw new Error('Локальные ключи не совпадают. Не удаляй config.json; восстанови его из локальной копии.');
                await globalThis.crypto.subtle.importKey('jwk', config.privateKey, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
                keys = { publicKey: config.publicKey, privateKey: config.privateKey };
            } else keys = await generateEnvelopeKeyPair();
            const response = await fetch(new URL('/api/hub/device', base), {
                method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'pair', code: options.pair, publicKey: keys.publicKey, name: 'Мой MacBook' }),
                signal: AbortSignal.timeout(30_000),
            });
            if (!response.ok) throw new Error('Код сопряжения недействителен или истёк. Создай новый в кабинете.');
            const paired = await response.json();
            if (typeof paired.token !== 'string' || !paired.deviceId) throw new Error('Платформа вернула неполные данные сопряжения.');
            Object.assign(config, { baseURL: base.origin, token: paired.token, deviceId: paired.deviceId, publicKey: keys.publicKey, privateKey: keys.privateKey });
            await writePrivateJSON(configPath, config);
            console.log('Mac подключён. Приватный ключ сохранён только на этом Mac.');
        } else if (options.url || options.vault || options.model || options['model-url'] || options['telegram-dialogue'] || options['no-telegram-dialogue'] || options['telegram-voice'] || options['no-telegram-voice']) {
            if (options.url && new URL(options.url).origin !== config.baseURL) throw new Error('Для смены платформы создай новый код сопряжения.');
            await writePrivateJSON(configPath, config);
        }
        if (!config.token || !config.privateKey) throw new Error('Сначала создай код в личном кабинете и выполни команду сопряжения.');
        const request = deviceRequest({ baseURL: config.baseURL, token: config.token });
        let adapter;
        try {
            const module = await import('./whatsapp.mjs');
            adapter = await module.createWhatsAppAdapter({ config, request, stateDirectory });
        } catch (error) {
            if (error.code !== 'ERR_MODULE_NOT_FOUND') throw new Error('Не удалось подготовить WhatsApp-модуль.');
        }
        const runtime = createCompanion({ config, stateDirectory, request, adapter });
        const shutdown = () => { void runtime.stop(); };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
        try { await runtime.run({ once: options.once }); }
        finally {
            process.removeListener('SIGINT', shutdown);
            process.removeListener('SIGTERM', shutdown);
            await runtime.stop();
        }
    } finally { await unlock(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(() => {
        // Do not print fetch/model exceptions: they may carry private prompt text or credentials.
        console.error('Агент не запущен. Проверь сопряжение, папку Obsidian и локальную модель. Справка: node companion/start.mjs --help');
        process.exitCode = 1;
    });
}
