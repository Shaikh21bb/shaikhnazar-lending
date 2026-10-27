import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CompanionRuntime } from '../companion/runtime.mjs';
import { LocalVault } from '../companion/vault.mjs';
import { TelegramOwnerDelivery, splitTelegramReply } from '../companion/telegram.mjs';
import { generateEnvelopeKeyPair, encryptEnvelope } from '../lib/private-envelope.mjs';

const KEY = 'a'.repeat(64);
async function fixture(t, overrides = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shaikh-dialogue-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const vaultPath = path.join(directory, 'vault');
    const stateDirectory = path.join(directory, 'state');
    await fs.mkdir(vaultPath); await fs.mkdir(stateDirectory);
    await fs.writeFile(path.join(vaultPath, 'Проект.md'), '# Проект\nКод проекта — Янтарь.');
    const keys = await generateEnvelopeKeyPair();
    const requests = [], sent = [], logs = [];
    const model = overrides.model || {
        status: async () => ({ ready: true }),
        converse: async () => ({ action: 'answer', answer: 'Код проекта — Янтарь.', sources: ['Проект.md'] }),
        analyze: async () => { throw new Error('Questions must not write notes'); },
    };
    const options = { config: { privateKey: keys.privateKey, vaultPath, telegramDialogueEnabled: true }, stateDirectory,
        vault: await new LocalVault(vaultPath, { backupDirectory: path.join(stateDirectory, 'backups') }).initialize(),
        model, now: () => new Date('2026-10-27T10:00:00Z'),
        request: async data => { requests.push(data); return data.action === 'poll' ? { jobs: [] } : {}; },
        telegramDelivery: { sendChunk: async (text, data) => { sent.push({ text, data }); return { status: 'sent', messageId: sent.length }; } },
        log: value => logs.push(value), ...overrides,
    };
    const runtime = await new CompanionRuntime(options).initialize();
    const job = async (text, extra = {}) => ({ id: randomUUID(), kind: 'telegram_thought', lease_token: randomUUID(), created_at: '2026-10-27T09:59:00Z',
        envelope: await encryptEnvelope(keys.publicKey, { text, intent: 'dialogue', conversationKey: KEY, telegramMessageId: 41, ...extra }) });
    return { directory, vaultPath, stateDirectory, keys, requests, sent, logs, model, options, runtime, job };
}

test('question answers locally with sources, without note writes or plaintext platform requests', async t => {
    const f = await fixture(t);
    await f.runtime.handleJob(await f.job('Какой код проекта?', { mode: 'ask' }), true);
    assert.equal((await f.runtime.vault.notes()).length, 1);
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].text, /Янтарь/);
    assert.match(f.sent[0].text, /Проект.md/);
    for (const marker of ['Какой код', 'Янтарь', 'Проект.md']) {
        assert.ok(!JSON.stringify(f.requests).includes(marker));
        assert.ok(!JSON.stringify(f.logs).includes(marker));
    }
    assert.equal((await fs.stat(path.join(f.stateDirectory, 'journal.json'))).mode & 0o777, 0o600);
});

test('follow-up context and sources survive a restart without duplicate replies', async t => {
    const f = await fixture(t);
    const first = await f.job('Какой код проекта?');
    await f.runtime.handleJob(first, true);
    let observed;
    const restarted = await new CompanionRuntime({ ...f.options, model: { ...f.model,
        converse: async (_text, _related, options) => { observed = options.history; return { action: 'answer', answer: 'Да, речь о проекте Янтарь.', sources: ['Проект.md'] }; },
    } }).initialize();
    await restarted.handleJob(first, true);
    assert.equal(f.sent.length, 1);
    await restarted.handleJob(await f.job('А о чём он?'), true);
    assert.ok(observed.some(turn => turn.role === 'user' && turn.content === 'Какой код проекта?'));
    assert.ok(observed.some(turn => turn.role === 'assistant' && turn.content.includes('Янтарь')));
    assert.equal(f.sent.length, 2);
});

test('offline questions stay local and never become fallback notes', async t => {
    let generations = 0;
    const f = await fixture(t, { model: { status: async () => ({ ready: true }),
        converse: async () => { generations++; return { action: 'answer', answer: 'Локальный ответ', sources: [] }; },
        analyze: async () => { throw new Error('No note analysis'); },
    } });
    const job = await f.job('Что я писал раньше?');
    await f.runtime.handleJob(job, false);
    assert.equal(generations, 0);
    assert.equal(f.sent.length, 0);
    assert.equal((await f.runtime.vault.notes()).length, 1);
    assert.equal(f.runtime.journal.jobs[job.id].pendingDialogue, true);
    await f.runtime.tick();
    assert.equal(generations, 1);
    assert.equal(f.sent.length, 1);
    assert.equal((await f.runtime.vault.notes()).length, 1);
});

test('offline turns with identical timestamps resume in their original order', async t => {
    const order = [];
    const f = await fixture(t, { model: { converse: async text => { order.push(text); return { action: 'answer', answer: `Ответ: ${text}`, sources: [] }; } } });
    await f.runtime.handleJob(await f.job('Первый вопрос'), false);
    await f.runtime.handleJob(await f.job('Второй вопрос'), false);
    await f.runtime.dialogue.retry(true);
    await f.runtime.dialogue.flush();
    assert.deepEqual(order, ['Первый вопрос', 'Второй вопрос']);
    assert.equal(f.sent.length, 2);
});

test('a rate-limited answer holds later answers in the same conversation', async t => {
    let limited = true;
    const attempts = [];
    const f = await fixture(t, { telegramDelivery: { sendChunk: async text => {
        attempts.push(text);
        return limited ? { status: 'retry', retryAfter: 60 } : { status: 'sent', messageId: attempts.length };
    } } });
    const first = await f.job('Первый вопрос');
    await f.runtime.handleJob(first, true);
    const second = await f.job('Второй вопрос');
    await f.runtime.handleJob(second, true);
    assert.equal(attempts.length, 1);
    limited = false;
    f.runtime.now = () => new Date('2026-10-27T10:02:00Z');
    await f.runtime.dialogue.flush();
    assert.equal(attempts.length, 3);
    assert.equal(f.runtime.journal.jobs[first.id].dialogue.outbox[0].status, 'sent');
    assert.equal(f.runtime.journal.jobs[second.id].dialogue.outbox[0].status, 'sent');
});

test('a Mac without explicit dialogue opt-in cannot read the vault for an answer or send it', async t => {
    let generated = false;
    const f = await fixture(t, { model: { converse: async () => { generated = true; } } });
    f.runtime.telegramDialogueEnabled = false;
    await f.runtime.handleJob(await f.job('Какой код проекта?'), true);
    assert.equal(generated, false);
    assert.equal(f.sent.length, 0);
    assert.equal((await f.runtime.vault.notes()).length, 1);
});

test('/ask cannot write even when a model misclassifies a question', async t => {
    let analyzed = 0;
    const f = await fixture(t, { model: { converse: async () => ({ action: 'save', answer: '', sources: [] }), analyze: async () => { analyzed++; } } });
    await f.runtime.handleJob(await f.job('Сохрани или расскажи?', { mode: 'ask' }), true);
    assert.equal(analyzed, 0);
    assert.equal((await f.runtime.vault.notes()).length, 1);
    assert.match(f.sent[0].text, /Уточни/);
});

test('/new archives context and prevents older offline turns from restoring it', async t => {
    let generations = 0;
    const f = await fixture(t, { model: { converse: async () => { generations++; return { action: 'answer', answer: 'Older answer', sources: [] }; } } });
    const old = await f.job('Старый вопрос');
    await f.runtime.handleJob(old, false);
    await f.runtime.handleJob(await f.job('', { mode: 'reset' }), false);
    await f.runtime.dialogue.retry(true);
    assert.equal(generations, 0);
    assert.equal(f.runtime.journal.jobs[old.id].dialogueCancelled, true);
    assert.ok(!f.runtime.journal.conversations[KEY].history.some(turn => turn.content === 'Старый вопрос'));
    assert.equal((await f.runtime.vault.notes()).length, 1);
    assert.ok((await fs.readdir(path.join(f.stateDirectory, 'dialogue', KEY))).some(name => name.startsWith('reset-')));
});

test('a lost completion response preserves one history turn and one delivery across restart', async t => {
    let fail = true;
    const f = await fixture(t);
    const request = async data => {
        if (data.action === 'complete' && fail) { fail = false; throw new Error('Lost response'); }
        return data.action === 'poll' ? { jobs: [] } : {};
    };
    f.runtime.request = request;
    const job = await f.job('Какой код проекта?');
    await assert.rejects(f.runtime.handleJob(job, true));
    const restarted = await new CompanionRuntime({ ...f.options, request }).initialize();
    await restarted.tick();
    await restarted.handleJob(job, true);
    assert.equal(f.sent.length, 1);
    assert.equal(restarted.journal.conversations[KEY].history.length, 2);
});

test('an ambiguous send or a restart during dispatch never sends the same answer again', async t => {
    let attempts = 0;
    const delivery = { sendChunk: async () => { attempts++; return { status: 'uncertain' }; } };
    const f = await fixture(t, { telegramDelivery: delivery });
    const job = await f.job('Какой код проекта?');
    await f.runtime.handleJob(job, true);
    await f.runtime.dialogue.flush();
    assert.equal(attempts, 1);
    f.runtime.journal.jobs[job.id].dialogue.outbox[0].status = 'dispatching';
    await f.runtime.persist();
    const restarted = await new CompanionRuntime(f.options).initialize();
    await restarted.dialogue.flush();
    assert.equal(attempts, 1);
    assert.equal(restarted.journal.jobs[job.id].dialogue.outbox[0].status, 'uncertain');
});

test('date-only follow-up updates the original note and creates a neutral reminder', async t => {
    const f = await fixture(t, { model: {
        converse: async () => ({ action: 'save', answer: '', sources: [] }),
        analyze: async () => ({ title: 'Звонок', body: 'Надо позвонить', tags: [], links: [], tasks: [{ text: 'Позвонить', dueAt: null }] }),
    } });
    const first = await f.job('Надо позвонить по проекту');
    await f.runtime.handleJob(first, true);
    assert.equal(f.runtime.journal.conversations[KEY].awaiting, first.id);
    const second = await f.job('Завтра в 12:00');
    await f.runtime.handleJob(second, true);
    assert.equal(f.runtime.journal.jobs[first.id].note.path, f.runtime.journal.jobs[second.id].note.path);
    assert.equal(f.runtime.journal.jobs[second.id].tasks.length, 1);
    assert.equal(f.runtime.journal.conversations[KEY].awaiting, null);
    assert.equal((await f.runtime.vault.notes()).length, 2);
    assert.ok(!JSON.stringify(f.requests).includes('Позвонить'));
});

test('direct Telegram delivery verifies fresh owner, disables previews, and never follows redirects', async () => {
    const keys = await generateEnvelopeKeyPair();
    let credentialKey = KEY;
    const calls = [];
    const request = async () => ({ telegramEnvelope: await encryptEnvelope(keys.publicKey, {
        token: `123456:${'x'.repeat(35)}`, chatId: '54321', ownerUserId: '54321', conversationKey: credentialKey,
    }) });
    const delivery = new TelegramOwnerDelivery({ privateKey: keys.privateKey, request,
        fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) }; },
    });
    assert.deepEqual(await delivery.sendChunk('Private answer', { conversationKey: KEY, replyToMessageId: 5 }), { status: 'sent', messageId: 7 });
    assert.equal(new URL(calls[0].url).origin, 'https://api.telegram.org');
    assert.equal(calls[0].options.redirect, 'error');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.chat_id, '54321');
    assert.equal(body.link_preview_options.is_disabled, true);
    assert.equal(body.reply_parameters.message_id, 5);
    assert.ok(!('parse_mode' in body));
    credentialKey = 'b'.repeat(64);
    assert.deepEqual(await delivery.sendChunk('Must not leak', { conversationKey: KEY }), { status: 'cancelled' });
    assert.equal(calls.length, 1);
});

test('Telegram transport suppresses credential-bearing exceptions and respects explicit rate-limit rejection', async () => {
    const keys = await generateEnvelopeKeyPair();
    const request = async () => ({ telegramEnvelope: await encryptEnvelope(keys.publicKey, {
        token: `123456:${'x'.repeat(35)}`, chatId: '54321', ownerUserId: '54321', conversationKey: KEY,
    }) });
    const broken = new TelegramOwnerDelivery({ privateKey: keys.privateKey, request, fetchImpl: async () => { throw new Error('https://api.telegram.org/botSECRET Private answer'); } });
    assert.deepEqual(await broken.sendChunk('Private answer', { conversationKey: KEY }), { status: 'uncertain' });
    const limited = new TelegramOwnerDelivery({ privateKey: keys.privateKey, request, fetchImpl: async () => ({ ok: false, status: 429,
        json: async () => ({ ok: false, parameters: { retry_after: 45 } }),
    }) });
    assert.deepEqual(await limited.sendChunk('Private answer', { conversationKey: KEY }), { status: 'retry', retryAfter: 45 });
    for (const status of [400, 401, 403]) {
        const rejected = new TelegramOwnerDelivery({ privateKey: keys.privateKey, request, fetchImpl: async () => ({ ok: false, status, json: async () => ({ ok: false }) }) });
        assert.deepEqual(await rejected.sendChunk('Private answer', { conversationKey: KEY }), { status: 'cancelled' });
    }
    const chunks = splitTelegramReply('😀'.repeat(6000));
    assert.ok(chunks.every(chunk => chunk.length <= 3500 && !/[\uD800-\uDBFF]$/u.test(chunk)));
});
