import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalVault, discoverVaults } from '../companion/vault.mjs';
import { LocalModel, localModelURL } from '../companion/model.mjs';
import { normalizeTasks, deferQuietHours, nextDailyOverview, explicitDeadline, bindExplicitDeadline, localTimestamp } from '../companion/reminders.mjs';
import { CompanionRuntime, deviceRequest, hasExplicitTime, writePrivateJSON } from '../companion/runtime.mjs';
import { generateEnvelopeKeyPair, encryptEnvelope, decryptEnvelope } from '../lib/private-envelope.mjs';
import { parseArguments } from '../companion/start.mjs';

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shaikh-companion-'));
    const vaultDirectory = path.join(directory, 'vault');
    const stateDirectory = path.join(directory, 'state');
    await fs.mkdir(vaultDirectory);
    await fs.mkdir(stateDirectory);
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const vault = await new LocalVault(vaultDirectory, { backupDirectory: path.join(stateDirectory, 'backups') }).initialize();
    return { directory, vaultDirectory, stateDirectory, vault };
}

test('vault rejects traversal and symlinks, and backs up explicit updates', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.directory, 'outside.md'), 'keep outside');
    await fs.symlink(path.join(f.directory, 'outside.md'), path.join(f.vaultDirectory, 'escape.md'));
    await fs.symlink(f.directory, path.join(f.vaultDirectory, 'outside'));
    for (const name of ['../outside.md', '/tmp/outside.md', '.obsidian/config.md', 'outside/outside.md', 'escape.md', 'a\\b.md']) {
        await assert.rejects(f.vault.safePath(name));
    }
    const first = await f.vault.write({ title: 'Идея / проекта', body: 'Initial private thought', tags: ['проект'], jobId: 'stable-job' });
    await f.vault.write({ title: 'Новый заголовок', body: 'Updated private thought', updatePath: first.path, jobId: 'stable-job' });
    assert.match(await fs.readFile(path.join(f.vaultDirectory, first.path), 'utf8'), /Updated private thought/);
    const backups = await fs.readdir(path.join(f.stateDirectory, 'backups'));
    assert.equal(backups.length, 1);
    assert.match(await fs.readFile(path.join(f.stateDirectory, 'backups', backups[0]), 'utf8'), /Initial private thought/);
    assert.equal(await fs.readFile(path.join(f.directory, 'outside.md'), 'utf8'), 'keep outside');
    assert.equal((await f.vault.notes()).length, 1);
});

test('same job writes exactly one note and local linking skips dot folders', async t => {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.vaultDirectory, '.obsidian'));
    await fs.writeFile(path.join(f.vaultDirectory, '.obsidian/hidden.md'), 'Проект агент');
    await fs.writeFile(path.join(f.vaultDirectory, 'Агент.md'), '# Мой агент\nПроект заметок.');
    const first = await f.vault.write({ title: 'Мысль', body: 'Первый вариант', jobId: 'one-job' });
    const second = await f.vault.write({ title: 'Другой заголовок после повторного AI-ответа', body: 'Второй вариант', jobId: 'one-job' });
    assert.equal(first.path, second.path);
    assert.equal(second.reused, true);
    assert.match(await fs.readFile(path.join(f.vaultDirectory, first.path), 'utf8'), /Первый вариант/);
    const related = await f.vault.related('Проект агент');
    assert.equal(related[0].path, 'Агент.md');
    assert.ok(related.every(note => !note.path.includes('.obsidian')));
});

test('model endpoints reject cloud destinations and HTTP redirects', async () => {
    for (const value of ['https://api.openai.com/v1', 'http://localhost.evil.test:11434', 'http://192.168.1.5:11434', 'http://127.0.0.1@evil.test', 'file:///etc/passwd', 'http://127.0.0.1:11434?token=x']) {
        assert.throws(() => localModelURL(value));
    }
    assert.equal(localModelURL('http://127.0.0.1:1234/v1').hostname, '127.0.0.1');
    let observed;
    const model = new LocalModel({ fetchImpl: async (url, options) => {
        observed = { url, options };
        return { ok: true, json: async () => url.endsWith('/api/show') ? { model_info: { 'general.architecture': 'qwen' } } : { models: [{ name: 'local-only' }] } };
    } });
    assert.deepEqual(await model.status(), { ready: true, model: 'local-only' });
    assert.equal(observed.options.redirect, 'error');
    assert.equal(observed.url, 'http://127.0.0.1:11434/api/show');
});

test('local model filters invented links and keeps prompts on loopback', async () => {
    const seen = [];
    const model = new LocalModel({ model: 'offline-model', fetchImpl: async (url, options) => {
        seen.push({ url, options });
        if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'offline-model' }] }) };
        if (url.endsWith('/api/show')) return { ok: true, json: async () => ({ model_info: { architecture: 'qwen' } }) };
        return { ok: true, json: async () => ({ message: { content: JSON.stringify({ title: 'Мысль', body: 'Текст', tags: ['проект'], links: ['Known.md', '../Secret.md', 'Invented.md'], tasks: [] }) } }) };
    } });
    const result = await model.analyze('Private thought', [{ path: 'Known.md', title: 'Known', excerpt: 'Private known note' }]);
    assert.deepEqual(result.links, ['Known.md']);
    assert.ok(seen.every(item => item.url.startsWith('http://127.0.0.1:11434/')));
    assert.match(seen.find(item => item.url.endsWith('/api/chat')).options.body, /Private known note/);
});

test('Ollama cloud aliases and remote-host metadata never receive a private prompt', async () => {
    let prompts = 0;
    const model = new LocalModel({ fetchImpl: async url => {
        if (url.endsWith('/api/chat')) prompts++;
        return { ok: true, json: async () => url.endsWith('/api/tags')
            ? { models: [{ name: 'cloud-alias', remote_model: 'some-model' }, { name: 'ordinary-alias' }] }
            : { remote_host: 'https://ollama.com', remote_model: 'private-cloud', model_info: { architecture: 'qwen' } } };
    } });
    assert.equal((await model.status()).ready, false);
    await assert.rejects(model.analyze('Private vault text'));
    assert.equal(prompts, 0);
    const namedCloud = new LocalModel({ model: 'qwen:cloud', fetchImpl: async () => { throw new Error('No network expected'); } });
    await assert.rejects(namedCloud.analyze('Private vault text'));
});

test('missing times require clarification, meetings use 30 minutes and quiet hours use Almaty', () => {
    const now = new Date('2026-10-27T03:00:00Z');
    const result = normalizeTasks([
        { text: 'Позвонить', dueAt: null },
        { text: 'Date only', dueAt: '2026-10-29' },
        { text: 'Встреча', dueAt: '2026-10-27T12:00:00+05:00', kind: 'meeting' },
        { text: 'Вечерняя задача', dueAt: '2026-10-27T23:00:00+05:00' },
    ], { jobId: 'job', now });
    assert.equal(result.clarification.length, 2);
    assert.equal(result.reminders[0].due_at, '2026-10-27T06:30:00.000Z');
    assert.equal(result.reminders[1].due_at, '2026-10-28T04:00:00.000Z');
    assert.match(result.reminders[0].id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(deferQuietHours(new Date('2026-10-27T01:00:00Z')).toISOString(), '2026-10-27T04:00:00.000Z');
    assert.equal(nextDailyOverview(now).toISOString(), '2026-10-27T04:00:00.000Z');
    assert.equal(nextDailyOverview(new Date('2026-10-27T05:00:00Z')).toISOString(), '2026-10-28T04:00:00.000Z');
    assert.equal(hasExplicitTime('Надо позвонить и обсудить проект'), false);
    assert.equal(hasExplicitTime('Сейчас думаю об участке'), false);
    assert.equal(hasExplicitTime('Завтра в 10:30'), true);
});

test('explicit deadlines are parsed from user text in Almaty without trusting model dates or offsets', () => {
    const now = new Date('2026-10-27T08:00:00Z');
    const cases = [
        ['Завтра в 15:00 встреча по проекту портфолио. Подготовить список вопросов.', '2026-10-28T10:00:00.000Z'],
        ['Сегодня в 16:45 позвонить', '2026-10-27T11:45:00.000Z'],
        ['Послезавтра в 09:15 отправить документ', '2026-10-29T04:15:00.000Z'],
        ['28.10.2026 в 15:00 созвон', '2026-10-28T10:00:00.000Z'],
        ['2026-10-28 в 15:00 позвонить', '2026-10-28T10:00:00.000Z'],
        ['2026-10-28T15:00:00+05:00 встреча', '2026-10-28T10:00:00.000Z'],
        ['2026-10-28T15:00:00+03:00 встреча', '2026-10-28T12:00:00.000Z'],
    ];
    for (const [text, expected] of cases) assert.equal(explicitDeadline(text, { now }).dueAt, expected, text);
    for (const text of ['позвонить в 15:00', 'Завтра позвонить', 'В 15:00 или 16:00 завтра встреча', 'Завтра и послезавтра в 15:00', '31.02.2026 в 15:00', '2026-10-28 в 25:00']) {
        assert.equal(explicitDeadline(text, { now }).resolved, false, text);
    }
    const wrongModel = [{ text: 'Встреча по портфолио', dueAt: '2026-10-28T15:00:00+03:00', needsClarification: true, kind: 'task' }];
    const bound = bindExplicitDeadline(wrongModel, cases[0][0], { now });
    assert.equal(bound[0].dueAt, '2026-10-28T10:00:00.000Z');
    assert.equal(bound[0].kind, 'meeting');
    assert.equal(bound[0].needsClarification, false);
    const normalized = normalizeTasks(bound, { jobId: 'date-source', now });
    assert.equal(normalized.reminders[0].due_at, '2026-10-28T09:30:00.000Z');
    const preparation = bindExplicitDeadline([{ text: 'Подготовить список вопросов для встречи', kind: 'task' }], cases[0][0], { now });
    assert.equal(preparation[0].kind, 'meeting');
    assert.equal(preparation[0].dueAt, '2026-10-28T10:00:00.000Z');
    assert.equal(preparation[1].needsClarification, true);
    assert.equal(preparation[1].dueAt, null);
    assert.equal(bindExplicitDeadline(wrongModel, 'Позвонить в 15:00', { now })[0].dueAt, null);
    assert.ok(bindExplicitDeadline([...wrongModel, { text: 'Подготовить список' }], cases[0][0], { now }).every(task => task.needsClarification));
    assert.equal(localTimestamp(now), '2026-10-27 13:00:00 (Asia/Almaty)');
});

test('deadline clarifications merge only explicit components and preserve the original relative date', () => {
    const originalNow = new Date('2026-10-27T08:00:00Z');
    const now = new Date('2026-10-28T03:00:00Z');
    assert.equal(explicitDeadline('Завтра позвонить', { originalNow, now, clarification: 'В 15:00' }).dueAt, '2026-10-28T10:00:00.000Z');
    assert.equal(explicitDeadline('Позвонить в 15:00', { originalNow, now, clarification: 'Завтра' }).dueAt, '2026-10-29T10:00:00.000Z');
    assert.equal(explicitDeadline('Завтра в 15:00', { originalNow, now, clarification: '30.10.2026 в 16:30' }).dueAt, '2026-10-30T11:30:00.000Z');
});

test('encrypted job flows browser → Mac → note → encrypted reply without plaintext requests', async t => {
    const f = await fixture(t);
    const mac = await generateEnvelopeKeyPair();
    const browser = await generateEnvelopeKeyPair();
    const thought = 'Локальная приватная мысль: обсудить проект';
    const job = { id: randomUUID(), kind: 'thought', lease_token: 'lease-secret', envelope: await encryptEnvelope(mac.publicKey, { text: thought, intent: 'thought', replyPublicKey: browser.publicKey }) };
    const requests = [];
    const runtime = new CompanionRuntime({ config: { privateKey: mac.privateKey }, stateDirectory: f.stateDirectory, vault: f.vault,
        model: { status: async () => ({ ready: true, model: 'local' }), analyze: async () => ({ title: 'Проект', body: thought, tags: ['проект'], links: [], tasks: [{ text: 'Обсудить проект', dueAt: '2026-10-29T12:00:00+05:00' }] }) },
        request: async data => { requests.push(data); return {}; }, log() {}, now: () => new Date('2026-10-27T03:00:00Z'),
    });
    await runtime.initialize();
    const result = await runtime.handleJob(job, true);
    assert.ok(result.clarification, 'Even an invented model date cannot replace the missing user time');
    assert.equal(result.reminders.length, 0);
    const completion = requests.find(item => item.action === 'complete');
    assert.equal(completion.leaseToken, 'lease-secret');
    assert.equal(completion.status, 'complete');
    assert.ok(!JSON.stringify(requests).includes(thought));
    assert.ok(!JSON.stringify(requests).includes('Обсудить проект'));
    const reply = await decryptEnvelope(browser.privateKey, completion.resultEnvelope);
    assert.equal(reply.note.title, 'Проект');
    assert.ok(reply.note.openUrl.startsWith('obsidian://open?'));
    assert.match(await fs.readFile(path.join(f.vaultDirectory, reply.note.path), 'utf8'), /Локальная приватная мысль/);
    assert.match(await fs.readFile(path.join(f.vaultDirectory, reply.note.path), 'utf8'), /## Исходная мысль/);
    await runtime.handleJob(job, true);
    assert.equal((await f.vault.notes()).length, 1);
    const journalStat = await fs.stat(path.join(f.stateDirectory, 'journal.json'));
    assert.equal(journalStat.mode & 0o777, 0o600);
});

test('offline model saves thought, then retries locally with backup and neutral schedule', async t => {
    const f = await fixture(t);
    const mac = await generateEnvelopeKeyPair();
    const browser = await generateEnvelopeKeyPair();
    const thought = 'Завтра в 12:00 встреча по проекту';
    const job = { id: randomUUID(), kind: 'thought', lease_token: 'lease', envelope: await encryptEnvelope(mac.publicKey, { text: thought, replyPublicKey: browser.publicKey }) };
    const requests = [];
    let calls = 0;
    const runtime = new CompanionRuntime({ config: { privateKey: mac.privateKey }, stateDirectory: f.stateDirectory, vault: f.vault,
        model: { analyze: async () => { calls++; return { title: 'Встреча по проекту', body: thought, tags: ['проект'], links: [], tasks: [{ text: 'Встреча по проекту', kind: 'meeting', dueAt: '2026-10-28T12:00:00+05:00' }] }; } },
        request: async data => { requests.push(data); return {}; }, log() {}, now: () => new Date('2026-10-27T03:00:00Z'),
    });
    await runtime.initialize();
    const offlineResult = await runtime.handleJob(job, false);
    assert.equal(calls, 0);
    assert.equal(offlineResult.pendingAnalysis, true);
    assert.match(await fs.readFile(path.join(f.vaultDirectory, offlineResult.note.path), 'utf8'), /analysis: pending/);
    await runtime.retryPending(true);
    assert.equal(calls, 1);
    assert.equal((await f.vault.notes()).length, 1);
    assert.equal((await fs.readdir(path.join(f.stateDirectory, 'backups'))).length, 1);
    const sync = requests.find(item => item.action === 'sync_reminders');
    assert.equal(sync.reminders[0].due_at, '2026-10-28T06:30:00.000Z');
    assert.ok(!JSON.stringify(requests).includes(thought));
    const reply = await decryptEnvelope(browser.privateKey, sync.resultEnvelope);
    assert.equal(reply.pendingAnalysis, false);
});

test('clarification reuses original note and only publishes neutral metadata', async t => {
    const f = await fixture(t);
    const mac = await generateEnvelopeKeyPair();
    const requests = [];
    const runtime = new CompanionRuntime({ config: { privateKey: mac.privateKey }, stateDirectory: f.stateDirectory, vault: f.vault,
        model: { analyze: async (_text, _related, options) => ({ title: 'Звонок', body: 'Позвонить по проекту', tags: [], links: [], tasks: [{ text: 'Позвонить', dueAt: options.clarification ? '2026-10-28T12:00:00+05:00' : null }] }) },
        request: async data => { requests.push(data); return {}; }, log() {}, now: () => new Date('2026-10-27T03:00:00Z'),
    });
    await runtime.initialize();
    const originalId = randomUUID();
    const original = await runtime.handleJob({ id: originalId, kind: 'telegram_thought', envelope: await encryptEnvelope(mac.publicKey, { text: 'Позвонить по проекту' }) }, true);
    assert.ok(original.clarification);
    const clarified = await runtime.handleJob({ id: randomUUID(), kind: 'telegram_thought', envelope: await encryptEnvelope(mac.publicKey, { text: 'Завтра в 12:00', intent: 'clarify', relatedJobId: originalId }) }, true);
    assert.equal(clarified.note.path, original.note.path);
    assert.equal(clarified.clarification, null);
    assert.equal(clarified.reminders.length, 1);
    assert.equal((await f.vault.notes()).length, 1);
    assert.ok(requests.some(item => item.action === 'notify' && item.kind === 'clarification'));
    assert.ok(!JSON.stringify(requests).includes('Позвонить'));
});

test('network failure after local analysis preserves reminder outbox across restart', async t => {
    const f = await fixture(t);
    const mac = await generateEnvelopeKeyPair();
    const id = randomUUID();
    let fail = true;
    const delivered = [];
    const options = { config: { privateKey: mac.privateKey }, stateDirectory: f.stateDirectory, vault: f.vault,
        model: { analyze: async () => ({ title: 'Встреча', body: 'Завтра в 12:00 встреча', tags: [], links: [], tasks: [{ text: 'Встреча', dueAt: '2026-10-28T12:00:00+05:00', kind: 'meeting' }] }) },
        request: async data => { if (data.action === 'sync_reminders' && fail) throw new Error('offline'); delivered.push(data); return {}; },
        log() {}, now: () => new Date('2026-10-27T03:00:00Z'),
    };
    const runtime = await new CompanionRuntime(options).initialize();
    await runtime.handleJob({ id, kind: 'thought', envelope: await encryptEnvelope(mac.publicKey, { text: 'Завтра в 12:00 встреча' }) }, false);
    await runtime.retryPending(true);
    assert.ok(runtime.journal.jobs[id].syncPending);
    fail = false;
    const restarted = await new CompanionRuntime(options).initialize();
    await restarted.retryPending(false);
    assert.equal(restarted.journal.jobs[id].syncPending, undefined);
    assert.ok(delivered.some(item => item.action === 'sync_reminders' && item.reminders.length === 1));
    assert.equal((await f.vault.notes()).length, 1);
});

test('a thought queued while Mac is off keeps the submission date for tomorrow', async t => {
    const f = await fixture(t);
    const mac = await generateEnvelopeKeyPair();
    let modelContext;
    const runtime = new CompanionRuntime({ config: { privateKey: mac.privateKey }, stateDirectory: f.stateDirectory, vault: f.vault,
        model: { analyze: async (_text, _related, context) => { modelContext = context; return { title: 'Звонок', body: 'Позвонить завтра в 15:00', tags: [], links: [], tasks: [{ text: 'Позвонить', dueAt: '2026-10-29T15:00:00+03:00' }] }; } },
        request: async () => ({}), log() {}, now: () => new Date('2026-10-28T03:00:00Z'),
    });
    await runtime.initialize();
    const result = await runtime.handleJob({ id: randomUUID(), created_at: '2026-10-27T08:00:00Z', kind: 'thought',
        envelope: await encryptEnvelope(mac.publicKey, { text: 'Позвонить завтра в 15:00' }) }, true);
    assert.equal(result.reminders[0].dueAt, '2026-10-28T10:00:00.000Z');
    assert.equal(modelContext.submittedAt, '2026-10-27T08:00:00.000Z');
});

test('registration discovery, config permissions and argument parser are explicit', async t => {
    const f = await fixture(t);
    const configPath = path.join(f.directory, 'obsidian.json');
    await fs.writeFile(configPath, JSON.stringify({ vaults: { one: { path: f.vaultDirectory, open: true }, missing: { path: '/not/a/vault' } } }));
    const vaults = await discoverVaults(configPath);
    assert.equal(vaults.length, 1);
    assert.equal(vaults[0].open, true);
    await writePrivateJSON(path.join(f.stateDirectory, 'config.json'), { token: 'not-real-secret' });
    assert.equal((await fs.stat(path.join(f.stateDirectory, 'config.json'))).mode & 0o777, 0o600);
    assert.deepEqual(parseArguments(['--once', '--model', 'local']), { once: true, model: 'local' });
    assert.throws(() => parseArguments(['--pair']));
    assert.throws(() => parseArguments(['--paid-fallback']));
});

test('device client forbids remote HTTP and never forwards through redirects', async () => {
    assert.throws(() => deviceRequest({ baseURL: 'http://evil.test', token: 'secret' }));
    let observed;
    const request = deviceRequest({ baseURL: 'https://shaikh.digital', token: 'secret', fetchImpl: async (url, options) => {
        observed = { url: url.toString(), options };
        return { ok: true, json: async () => ({ jobs: [] }) };
    } });
    await request({ action: 'poll' });
    assert.equal(observed.url, 'https://shaikh.digital/api/hub/device');
    assert.equal(observed.options.redirect, 'error');
    assert.equal(observed.options.headers.authorization, 'Bearer secret');
});
