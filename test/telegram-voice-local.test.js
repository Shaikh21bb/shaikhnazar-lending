import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CompanionRuntime } from '../companion/runtime.mjs';
import { LocalVault } from '../companion/vault.mjs';
import { generateEnvelopeKeyPair, encryptEnvelope } from '../lib/private-envelope.mjs';
import { LocalVoiceProcessor, LocalSpeechRecognizer, VoiceError, VOICE_LIMITS, validateVoice, validateTelegramFilePath, localProgram } from '../companion/voice.mjs';

const KEY = 'c'.repeat(64);
const VOICE = { fileId: 'File_123', uniqueId: 'Unique_123', duration: 4, size: 100, mimeType: 'audio/ogg' };
async function directory(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shaikh-voice-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}
async function processor(t, overrides = {}) {
    const root = await directory(t), requests = [];
    let speechCalls = 0;
    const value = new LocalVoiceProcessor({ stateDirectory: root, config: {},
        delivery: { credentials: async () => ({ token: `123456:${'x'.repeat(35)}`, conversationKey: KEY }) },
        recognizer: { status: async () => ({ ready: true }), transcribe: async input => {
            speechCalls++;
            assert.equal((await fs.stat(input)).mode & 0o777, 0o600);
            assert.equal((await fs.stat(path.dirname(input))).mode & 0o777, 0o700);
            return { text: 'Какая была проверка?' };
        } },
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            return url.endsWith('/getFile')
                ? Response.json({ ok: true, result: { file_path: 'voice/file_1.oga', file_size: 16 } })
                : new Response(Buffer.from('OggSsynthetic'));
        }, ...overrides,
    });
    await value.initialize();
    return { root, value, requests, speechCalls: () => speechCalls };
}
async function runtime(t, overrides = {}) {
    const root = await directory(t), vaultPath = path.join(root, 'vault'), stateDirectory = path.join(root, 'state');
    await fs.mkdir(vaultPath); await fs.mkdir(stateDirectory);
    const keys = await generateEnvelopeKeyPair(), requests = [], replies = [], generations = [];
    const options = { config: { privateKey: keys.privateKey, vaultPath, telegramDialogueEnabled: true, telegramVoiceEnabled: true }, stateDirectory,
        vault: await new LocalVault(vaultPath, { backupDirectory: path.join(stateDirectory, 'backups') }).initialize(),
        model: { status: async () => ({ ready: true }), converse: async text => { generations.push(text); return { action: 'answer', answer: 'Ответ по локальной базе', sources: [] }; } },
        voiceProcessor: { initialize: async () => {}, status: async () => ({ ready: true }), transcribe: async () => ({ text: 'Как работает проверка?' }) },
        request: async data => { requests.push(data); return data.action === 'poll' ? { jobs: [] } : {}; },
        telegramDelivery: { sendChunk: async text => { replies.push(text); return { status: 'sent', messageId: replies.length }; } },
        now: () => new Date('2026-10-27T12:00:00Z'), log() {}, ...overrides,
    };
    const value = await new CompanionRuntime(options).initialize();
    const job = async (payload = { voice: VOICE }) => ({ id: randomUUID(), kind: 'telegram_thought', created_at: '2026-10-27T11:59:00Z', lease_token: randomUUID(),
        envelope: await encryptEnvelope(keys.publicKey, { intent: 'dialogue', text: '', conversationKey: KEY, telegramMessageId: 99, ...payload }) });
    return { root, stateDirectory, keys, value, options, requests, replies, generations, job };
}

test('voice metadata and Telegram paths reject oversized input and remote/traversal references', () => {
    assert.equal(validateVoice(VOICE).fileId, VOICE.fileId);
    for (const value of [{ ...VOICE, duration: 601 }, { ...VOICE, size: VOICE_LIMITS.bytes + 1 }, { ...VOICE, fileId: 'http://evil' }]) assert.throws(() => validateVoice(value));
    for (const value of ['https://evil.test/x', '//evil/x', '../secret', 'voice/../secret', 'voice/%2e%2e/a', 'voice/a?token=x', 'voice/a#x', 'voice\\a', '.hidden/a']) assert.throws(() => validateTelegramFilePath(value));
});

test('audio is downloaded only on Mac, kept private, recognized and removed after completion', async t => {
    const f = await processor(t);
    const result = await f.value.transcribe(VOICE, { conversationKey: KEY, jobId: randomUUID() });
    assert.equal(result.text, 'Какая была проверка?');
    assert.equal(f.speechCalls(), 1);
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests.every(call => new URL(call.url).origin === 'https://api.telegram.org' && call.options.redirect === 'error'));
    assert.deepEqual(await fs.readdir(f.value.temporary), []);
});

test('changed owner prevents download and malicious file_path never reaches the media fetch', async t => {
    const changed = await processor(t, { delivery: { credentials: async () => null } });
    await assert.rejects(changed.value.transcribe(VOICE, { conversationKey: KEY }), error => error.cancelled);
    assert.equal(changed.requests.length, 0);
    let calls = 0;
    const poisoned = await processor(t, { fetchImpl: async () => { calls++; return Response.json({ ok: true, result: { file_path: 'https://evil.test/private' } }); } });
    await assert.rejects(poisoned.value.transcribe(VOICE, { conversationKey: KEY }), error => error.code === 'invalid_audio');
    assert.equal(calls, 1);
    assert.deepEqual(await fs.readdir(poisoned.value.temporary), []);
});

test('actual streamed bytes override a lying content length and cleanup runs on partial downloads', async t => {
    let calls = 0;
    const tooLarge = await processor(t, { fetchImpl: async url => {
        calls++;
        if (url.endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: 'voice/a.oga', file_size: 1 } });
        return { ok: true, headers: new Headers({ 'content-length': '1' }), body: (async function* () { for (let i = 0; i < 20; i++) yield Buffer.alloc(1024 * 1024); })() };
    } });
    await assert.rejects(tooLarge.value.transcribe(VOICE, { conversationKey: KEY }), error => error.code === 'voice_limit');
    assert.equal(calls, 2); assert.equal(tooLarge.speechCalls(), 0);
    assert.deepEqual(await fs.readdir(tooLarge.value.temporary), []);
    const interrupted = await processor(t, { fetchImpl: async url => url.endsWith('/getFile')
        ? Response.json({ ok: true, result: { file_path: 'voice/a.oga' } })
        : { ok: true, headers: new Headers(), body: (async function* () { yield Buffer.from('private audio'); throw new Error('SECRET bot URL'); })() },
    });
    await assert.rejects(interrupted.value.transcribe(VOICE, { conversationKey: KEY }), error => error.retryable && !error.message.includes('SECRET'));
    assert.deepEqual(await fs.readdir(interrupted.value.temporary), []);
});

test('startup cleans only job-owned temporary directories and does not follow symlinks', async t => {
    const f = await processor(t);
    const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep'), 'keep');
    await fs.mkdir(path.join(f.value.temporary, 'job-old')); await fs.writeFile(path.join(f.value.temporary, 'job-old/audio'), 'temporary');
    await fs.symlink(outside, path.join(f.value.temporary, 'job-link'));
    await f.value.initialize();
    assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'keep');
    assert.ok(!(await fs.readdir(f.value.temporary)).includes('job-old'));
});

test('decoder and recognizer have local-only protocols, bounded execution and a minimal offline environment', async t => {
    const root = await directory(t), input = path.join(root, 'input'); await fs.writeFile(input, 'OggSsynthetic');
    const calls = [];
    const recognizer = new LocalSpeechRecognizer({ python: process.execPath, modelPath: root, ffmpeg: process.execPath,
        run: async (binary, args, options) => {
            calls.push({ binary, args, options });
            if (args.includes('--check')) return { code: 0, stdout: '{"ready":true}' };
            if (args.includes('-c:a')) { await fs.writeFile(args.at(-1), Buffer.alloc(100)); return { code: 0, stdout: '' }; }
            return { code: 0, stdout: JSON.stringify({ text: 'Локальная речь', language: 'ru' }) };
        },
    });
    assert.equal((await recognizer.transcribe(input, root)).text, 'Локальная речь');
    const decoder = calls.find(call => call.args.includes('-c:a'));
    assert.equal(decoder.args[decoder.args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
    assert.equal(decoder.args[decoder.args.indexOf('-format_whitelist') + 1], 'ogg');
    assert.equal(decoder.options.timeoutMs, 20000);
    const speech = calls.find(call => call.args.includes('--audio'));
    assert.ok(speech.args.includes('-I')); assert.equal(speech.options.timeoutMs, 120000);
    assert.equal(speech.options.env.HF_HUB_OFFLINE, '1');
    assert.ok(!('OPENAI_API_KEY' in speech.options.env)); assert.ok(!('PYTHONPATH' in speech.options.env));
});

test('subprocess timeout and excessive output never expose private diagnostics', async () => {
    await assert.rejects(localProgram(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 30 }), error => error instanceof VoiceError);
    await assert.rejects(localProgram(process.execPath, ['-e', 'process.stdout.write("PRIVATE".repeat(1000))'], { maxOutput: 20 }), error => !error.message.includes('PRIVATE'));
});

test('voice transcript is committed before generation and never appears in platform requests', async t => {
    let observedPersisted = false, transcriptions = 0;
    const f = await runtime(t);
    const job = await f.job();
    f.value.voice.processor.transcribe = async () => { transcriptions++; return { text: 'Как работает проверка?' }; };
    f.value.model.converse = async () => {
        const journal = JSON.parse(await fs.readFile(path.join(f.stateDirectory, 'journal.json'), 'utf8'));
        observedPersisted = journal.jobs[job.id].thought === 'Как работает проверка?' && !journal.jobs[job.id].pendingVoice;
        return { action: 'answer', answer: 'Локальный ответ', sources: [] };
    };
    await f.value.handleJob(job, true);
    assert.equal(transcriptions, 0); assert.equal(f.value.journal.jobs[job.id].pendingVoice, true);
    await f.value.tick();
    assert.equal(transcriptions, 1); assert.equal(observedPersisted, true); assert.equal(f.replies.length, 1);
    assert.equal((await f.value.vault.notes()).length, 0);
    for (const marker of [VOICE.fileId, 'Как работает проверка', 'Локальный ответ']) assert.ok(!JSON.stringify(f.requests).includes(marker));
});

test('restart after transcription reuses the transcript and does not redownload audio', async t => {
    let calls = 0;
    const f = await runtime(t);
    f.value.voice.processor.transcribe = async () => { calls++; return { text: 'Как работает проверка?' }; };
    const job = await f.job(); await f.value.handleJob(job, true); await f.value.voice.retry();
    const restarted = await new CompanionRuntime({ ...f.options, voiceProcessor: { ...f.options.voiceProcessor, transcribe: async () => { throw new Error('Must not run twice'); } } }).initialize();
    await restarted.tick(); await restarted.handleJob(job, true);
    assert.equal(calls, 1); assert.equal(f.replies.length, 1);
});

test('a later text waits behind an earlier voice, including equal timestamps', async t => {
    const f = await runtime(t);
    await f.value.handleJob(await f.job(), true);
    await f.value.handleJob(await f.job({ text: 'А потом второй вопрос' }), true);
    assert.equal(f.generations.length, 0);
    await f.value.tick();
    assert.deepEqual(f.generations, ['Как работает проверка?', 'А потом второй вопрос']);
    assert.equal(f.replies.length, 2);
});

test('only one voice is recognized per tick so a queued reset can interrupt a backlog', async t => {
    let calls = 0;
    const f = await runtime(t, { voiceProcessor: { initialize: async () => {}, status: async () => ({ ready: true }), transcribe: async () => { calls++; return { text: 'Первый голосовой вопрос?' }; } } });
    await f.value.handleJob(await f.job(), true);
    const second = await f.job(); await f.value.handleJob(second, true);
    await f.value.tick();
    assert.equal(calls, 1); assert.equal(f.replies.length, 1);
    assert.equal(f.value.journal.jobs[second.id].pendingVoice, true);
    await f.value.handleJob(await f.job({ mode: 'reset' }), true); await f.value.tick();
    assert.equal(calls, 1); assert.equal(f.value.journal.jobs[second.id].voiceCancelled, true);
});

test('/new cancels older pending voice without decoding it or deleting notes', async t => {
    let calls = 0;
    const f = await runtime(t, { voiceProcessor: { initialize: async () => {}, status: async () => ({ ready: true }), transcribe: async () => { calls++; } } });
    const old = await f.job(); await f.value.handleJob(old, true);
    await f.value.handleJob(await f.job({ mode: 'reset' }), true); await f.value.tick();
    assert.equal(calls, 0); assert.equal(f.value.journal.jobs[old.id].voiceCancelled, true);
    assert.equal(f.generations.length, 0);
});

test('unavailable local STT waits without creating a note; silence gets one helpful text reply', async t => {
    let ready = false;
    const f = await runtime(t, { voiceProcessor: { initialize: async () => {}, status: async () => ({ ready }), transcribe: async () => { throw new VoiceError('no_speech'); } } });
    const job = await f.job(); await f.value.handleJob(job, true); await f.value.tick();
    assert.equal(f.replies.length, 0); assert.equal(f.value.journal.jobs[job.id].pendingVoice, true);
    ready = true; await f.value.tick(); await f.value.tick();
    assert.equal(f.replies.length, 1); assert.match(f.replies[0], /разобрать речь/);
    assert.equal((await f.value.vault.notes()).length, 0);
    assert.equal(f.value.journal.conversations[KEY].history.length, 0);
});

test('speech resembling a bot command is dialogue data and cannot reset the conversation', async t => {
    const f = await runtime(t, { voiceProcessor: { initialize: async () => {}, status: async () => ({ ready: true }), transcribe: async () => ({ text: '/new' }) } });
    await f.value.handleJob(await f.job(), true); await f.value.tick();
    assert.equal(f.value.journal.conversations[KEY].epoch, 0);
    assert.deepEqual(f.generations, ['/new']);
});

test('voice remains cancelled when local opt-in is disabled even if an old queue contains it', async t => {
    let calls = 0;
    const f = await runtime(t, { voiceProcessor: { initialize: async () => {}, status: async () => ({ ready: true }), transcribe: async () => { calls++; } } });
    f.value.telegramVoiceEnabled = false;
    const job = await f.job(); await f.value.handleJob(job, true); await f.value.tick();
    assert.equal(calls, 0); assert.equal(f.replies.length, 0);
    assert.equal(f.value.journal.jobs[job.id].voiceCancelled, true);
    assert.equal(f.requests.find(data => data.action === 'poll').status.telegramVoice, false);
});

test('a lost voice completion can recover its lease without deadlocking a later note sync', async t => {
    let initial = true, completed = false, polls = 0, transcriptions = 0, job;
    const f = await runtime(t, {
        model: { status: async () => ({ ready: true }), converse: async () => ({ action: 'save', answer: '', sources: [] }),
            analyze: async () => ({ title: 'Голосовая мысль', body: 'Новая мысль', tags: [], links: [], tasks: [] }) },
        voiceProcessor: { initialize: async () => {}, status: async () => ({ ready: true }), transcribe: async () => { transcriptions++; return { text: 'Запомни: новая мысль' }; } },
        request: async data => {
            if (data.action === 'complete') {
                if (initial) { initial = false; throw Object.assign(new Error('Lost response'), { status: 503 }); }
                if (data.leaseToken === job.lease_token) throw Object.assign(new Error('Expired lease'), { status: 409 });
                completed = true;
            }
            if (data.action === 'sync_reminders' && !completed) throw Object.assign(new Error('Not complete yet'), { status: 404 });
            if (data.action === 'poll') { polls++; return { jobs: polls === 2 ? [{ ...job, lease_token: randomUUID() }] : [] }; }
            return {};
        },
    });
    job = await f.job();
    await assert.rejects(f.value.handleJob(job, true));
    await f.value.tick();
    assert.equal(f.value.journal.jobs[job.id].fromVoice, true);
    assert.ok(f.value.journal.jobs[job.id].syncPending);
    await f.value.tick();
    assert.equal(completed, true); assert.equal(transcriptions, 1); assert.equal(f.replies.length, 1);
    assert.equal((await f.value.vault.notes()).length, 1);
    assert.equal(f.value.journal.jobs[job.id].syncPending, undefined);
});
