import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CompanionRuntime } from '../companion/runtime.mjs';
import { LocalVault } from '../companion/vault.mjs';
import { generateEnvelopeKeyPair, encryptEnvelope } from '../lib/private-envelope.mjs';
import { dialogueIntent, saveRequest } from '../companion/dialogue-intent.mjs';

const KEY = 'e'.repeat(64);
const SOURCE = 'SHAIKH Inbox/0123456789abcdef01234567.md';
async function fixture(t, overrides = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shaikh-routing-quality-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'vault'), stateDirectory = path.join(root, 'state');
    await fs.mkdir(directory); await fs.mkdir(stateDirectory);
    const vault = await new LocalVault(directory, { backupDirectory: path.join(stateDirectory, 'backups') }).initialize();
    const keys = await generateEnvelopeKeyPair();
    const searches = [], answers = [], analyses = [], sent = [], requests = [];
    const notes = [
        { path: SOURCE, title: 'Проверка Telegram', excerpt: 'Техническая мысль о проверке Telegram.' },
        { path: 'Memory/Important.md', title: 'Важное', excerpt: 'Искусственная тестовая заметка.' },
        { path: 'Daily/2026-10-27.md', title: 'Планы на день', excerpt: 'Другая искусственная заметка.' },
    ];
    vault.search = async (text, options) => { searches.push({ text, options }); return notes; };
    const runtime = await new CompanionRuntime({ config: { privateKey: keys.privateKey, vaultPath: directory, telegramDialogueEnabled: true }, stateDirectory, vault,
        model: { status: async () => ({ ready: true }),
            converse: async (text, related, options) => { answers.push({ text, related, options }); return { action: 'answer', answer: 'Проверял сохранение мысли в Obsidian.', sources: notes.map(note => note.path) }; },
            analyze: async text => { analyses.push(text); return { title: 'Новая мысль', body: text, tags: [], links: [], tasks: [] }; },
            ...overrides,
        },
        request: async data => { requests.push(data); return {}; },
        telegramDelivery: { sendChunk: async text => { sent.push(text); return { status: 'sent', messageId: sent.length }; } },
        now: () => new Date('2026-10-27T12:00:00Z'), log() {},
    }).initialize();
    const job = async (text, extra = {}) => ({ id: randomUUID(), kind: 'telegram_thought', lease_token: randomUUID(), created_at: '2026-10-27T11:59:00Z',
        envelope: await encryptEnvelope(keys.publicKey, { intent: 'dialogue', text, conversationKey: KEY, telegramMessageId: 90, ...extra }) });
    return { runtime, vault, root, stateDirectory, directory, searches, answers, analyses, sent, requests, notes, job };
}

test('natural spoken save requests route before search and do not reuse previous question answers', async t => {
    const f = await fixture(t);
    for (const text of [
        'Запомни: голосовые обрабатываются на Mac.',
        'Смотри, запомни: это новая мысль.',
        'Пожалуйста, сохраните: это новая идея.',
        'Можешь, пожалуйста, записать новую идею для проекта?',
        '«Запомнить: новая идея для проекта»',
        'Новая мысль: нужно сделать удобный интерфейс.',
    ]) await f.runtime.handleJob(await f.job(text), true);
    assert.equal(f.analyses.length, 6);
    assert.equal(f.searches.length, 0);
    assert.equal(f.answers.length, 0);
    assert.equal((await f.vault.notes()).length, 6);
    assert.ok(f.sent.every(text => text.startsWith('Сохранил мысль в Obsidian:')));
    assert.ok(f.sent.every(text => !text.includes('Источник') && !text.includes('SHAIKH Inbox')));
});

test('a new ambiguous statement asks one clear confirmation without prior retrieval or an old answer', async t => {
    const f = await fixture(t);
    await f.runtime.handleJob(await f.job('Что я проверял через Telegram?'), true);
    const previousSearches = f.searches.length;
    const statement = 'Это тест голосовых заметок. Распознавание работает на Mac.';
    await f.runtime.handleJob(await f.job(statement), true);
    assert.equal(f.searches.length, previousSearches);
    assert.equal(f.answers.length, 1);
    assert.match(f.sent[1], /^Сохранить эту мысль в Obsidian\?\n\n«/u);
    assert.ok(f.sent[1].includes(statement), 'The owner can review the exact pending thought before confirming');
    assert.ok(!f.sent[1].includes('Проверял'));
    assert.equal((await f.vault.notes()).length, 0);
    assert.deepEqual(f.runtime.journal.conversations[KEY].sources, []);
});

test('yes saves the original pending thought rather than the confirmation word', async t => {
    const f = await fixture(t);
    const thought = 'Это тест голосовых заметок. Распознавание работает на Mac.';
    await f.runtime.handleJob(await f.job(thought), true);
    const confirmation = await f.job('Да');
    await f.runtime.handleJob(confirmation, true);
    assert.deepEqual(f.analyses, [thought]);
    const saved = f.runtime.journal.jobs[confirmation.id];
    assert.equal(saved.thought, thought);
    assert.equal(saved.dialogueInput, 'Да');
    assert.equal(f.runtime.journal.conversations[KEY].pendingIntent, null);
    assert.match(await fs.readFile(path.join(f.directory, saved.note.path), 'utf8'), /тест голосовых заметок/);
    assert.ok(f.sent.at(-1).startsWith('Сохранил мысль в Obsidian:'));
});

test('a next-day save confirmation keeps relative deadlines anchored to the original thought', async t => {
    const f = await fixture(t, { analyze: async text => ({ title: 'Звонок', body: text, tags: [], links: [], tasks: [{ text: 'Позвонить по проекту', dueAt: null }] }) });
    f.runtime.now = () => new Date('2026-10-27T10:00:00Z');
    const original = await f.job('Для проекта: завтра в 12:00 позвонить.');
    original.created_at = '2026-10-27T09:00:00Z';
    await f.runtime.handleJob(original, true);
    f.runtime.now = () => new Date('2026-10-28T03:00:00Z');
    const confirmation = await f.job('Да'); confirmation.created_at = '2026-10-28T03:00:00Z';
    await f.runtime.handleJob(confirmation, true);
    const saved = f.runtime.journal.jobs[confirmation.id];
    assert.equal(Date.parse(saved.thoughtAt), Date.parse(original.created_at));
    assert.equal(saved.tasks[0].dueAt, '2026-10-28T07:00:00.000Z');
});

test('declining a pending save writes nothing, and a new question cannot accidentally confirm it', async t => {
    const f = await fixture(t);
    await f.runtime.handleJob(await f.job('Новая система выглядит удобнее.'), true);
    await f.runtime.handleJob(await f.job('Нет'), true);
    assert.equal(f.analyses.length, 0);
    assert.equal(f.runtime.journal.conversations[KEY].pendingIntent, null);
    await f.runtime.handleJob(await f.job('Это новая непомеченная мысль.'), true);
    await f.runtime.handleJob(await f.job('Как устроен локальный поиск?'), true);
    assert.equal(f.runtime.journal.conversations[KEY].pendingIntent, null);
    await f.runtime.handleJob(await f.job('Да'), true);
    assert.equal(f.analyses.length, 0);
    assert.equal((await f.vault.notes()).length, 0);
});

test('a voice thought retains its original provenance after a typed confirmation', async t => {
    const f = await fixture(t);
    const original = await f.job('Это мысль из голосового.');
    const record = { thought: 'Это мысль из голосового.', thoughtAt: original.created_at, source: 'telegram_thought', conversationKey: KEY,
        dialogueEpoch: 0, telegramMessageId: 90, dialogueMode: 'auto', fromVoice: true, voiceTranscribedAt: '2026-10-27T11:59:30Z', pendingDialogue: true };
    f.runtime.journal.jobs[original.id] = record;
    await f.runtime.dialogue.retry(true);
    const confirm = await f.job('Сохрани'); await f.runtime.handleJob(confirm, true);
    const saved = f.runtime.journal.jobs[confirm.id];
    assert.equal(saved.fromVoice, true);
    assert.equal(saved.voiceTranscribedAt, record.voiceTranscribedAt);
    assert.equal(saved.confirmedVoiceJobId, original.id);
    assert.equal(saved.thought, 'Это мысль из голосового.');
    assert.equal((await f.vault.notes()).length, 1);
});

test('clear questions and metalinguistic save-word questions are read-only even with a wrong model action', async t => {
    const f = await fixture(t, { converse: async () => ({ action: 'save', answer: '', sources: [] }) });
    for (const text of ['Что значит слово «запомни»?', 'Как сохранить заметку?', 'Можешь объяснить поиск?', 'А куда это сохранялось?']) {
        assert.equal(dialogueIntent(text), 'answer');
        await f.runtime.handleJob(await f.job(text), true);
    }
    assert.equal(f.analyses.length, 0);
    assert.equal((await f.vault.notes()).length, 0);
    assert.ok(f.sent.every(text => text.startsWith('Уточни')));
});

test('/ask always remains read-only and /new clears a pending save without changing notes', async t => {
    const f = await fixture(t);
    await f.runtime.handleJob(await f.job('Это новая мысль без команды.'), true);
    await f.runtime.handleJob(await f.job('Да', { mode: 'ask' }), true);
    assert.equal(f.analyses.length, 0);
    await f.runtime.handleJob(await f.job('Ещё одна новая мысль.'), true);
    await f.runtime.handleJob(await f.job('', { mode: 'reset' }), true);
    assert.equal(f.runtime.journal.conversations[KEY].pendingIntent, null);
    assert.equal((await f.vault.notes()).length, 0);
});

test('replies show at most two human source titles while canonical paths stay only in local state', async t => {
    const f = await fixture(t);
    const job = await f.job('Что я проверял через Telegram?'); await f.runtime.handleJob(job, true);
    const reply = f.sent[0];
    assert.match(reply, /Источник[и]?: «Проверка Telegram», «Важное»/u);
    assert.ok(!reply.includes(SOURCE));
    assert.ok(!reply.includes('Memory/Important.md'));
    assert.ok(!reply.includes('Планы на день'));
    assert.deepEqual(f.runtime.journal.jobs[job.id].dialogue.sources, [SOURCE, 'Memory/Important.md']);
    assert.ok(!JSON.stringify(f.requests).includes('Проверка Telegram'));
});

test('empty save commands clarify and ordinary social replies remain a conversation', () => {
    assert.equal(saveRequest('Запомни').content, '');
    assert.equal(dialogueIntent('Можешь сохранить это?'), 'clarify');
    assert.equal(dialogueIntent('Сохрани эту мысль'), 'clarify');
    for (const text of ['Привет', 'Спасибо!', 'Да, спасибо', 'Понятно.']) assert.equal(dialogueIntent(text), 'answer');
    assert.equal(dialogueIntent('Я решил создать новый проект.'), 'save');
    assert.equal(dialogueIntent('Это новая идея для интерфейса.'), 'clarify');
});
