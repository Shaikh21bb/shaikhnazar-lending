import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSalesAgent } from '../worker/local-sales.mjs';
import { conversationalReply, rememberClient, withChatPresence } from '../worker/conversation.mjs';

test('local Sales Agent requires explicit local switch and verified training', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shaikh-local-sales-'));
    let calls = 0;
    const agent = new LocalSalesAgent({
        sessionDir: dir,
        fetcher: async () => { calls++; return new Response(JSON.stringify({ message: { content: 'Здравствуйте!' } })); }
    });
    const inbound = {
        externalId: '77771234567@s.whatsapp.net', messageId: 'msg-1', text: 'Привет',
        context: { enabled: true, knowledge: 'Приветствие: Здравствуйте!', name: 'Шаихназар', language: 'ru' },
        sendMessage: async () => { throw new Error('Must not send'); }
    };
    try {
        assert.equal((await agent.reply(inbound)).reason, 'disabled');
        await writeFile(join(dir, 'sales-agent.enabled'), 'enabled');
        assert.equal((await agent.reply({ ...inbound, context: { enabled: false } })).reason, 'disabled');
        assert.equal(calls, 0);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('local Sales Agent calls Ollama directly, stores history and never resends a duplicate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shaikh-local-sales-'));
    await writeFile(join(dir, 'sales-agent.enabled'), 'enabled');
    const payloads = [];
    const sent = [];
    const agent = new LocalSalesAgent({
        sessionDir: dir,
        fetcher: async (url, options) => {
            assert.equal(url, 'http://host.docker.internal:11434/api/chat');
            payloads.push(JSON.parse(options.body));
            return new Response(JSON.stringify({ message: { content: 'Здравствуйте! Что вас интересует?' } }), {
                status: 200, headers: { 'content-type': 'application/json' }
            });
        }
    });
    const base = {
        externalId: '77771234567@s.whatsapp.net',
        context: { enabled: true, knowledge: 'Продаём консультацию.', name: 'Шаихназар', language: 'ru' },
        sendMessage: async (_recipient, value) => { sent.push(value.text); }
    };
    try {
        assert.equal((await agent.reply({ ...base, messageId: 'msg-1', text: 'Привет' })).replied, true);
        assert.equal((await agent.reply({ ...base, messageId: 'msg-1', text: 'Привет' })).reason, 'duplicate');
        assert.equal((await agent.reply({ ...base, messageId: 'msg-2', text: 'Подробнее?' })).replied, true);
        assert.equal(payloads.length, 2);
        assert.equal(payloads[0].stream, false);
        assert.equal(payloads[0].model, 'qwen3.5:9b-mlx');
        assert.equal(payloads[0].messages[0].role, 'system');
        assert.match(payloads[0].messages[0].content, /Продаём консультацию/);
        assert.equal(payloads[0].options.num_ctx, 8192);
        assert.deepEqual(payloads[1].messages.slice(-3).map(x => x.role), ['user', 'assistant', 'user']);
        assert.equal(sent.length, 2);
        const historyDir = join(dir, 'sales-history');
        const files = await import('node:fs/promises').then(fs => fs.readdir(historyDir));
        const stored = JSON.parse(await readFile(join(historyDir, files[0]), 'utf8'));
        assert.deepEqual(stored.ids, ['msg-1', 'msg-2']);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('local Sales Agent rejects an Ollama endpoint outside the private host', () => {
    assert.throws(() => new LocalSalesAgent({
        sessionDir: '/tmp', ollamaUrl: 'https://example.com/api/chat'
    }), /private Ollama API/);
});

test('one slow client does not queue all other customers behind it', async () => {
    let firstStarted;
    let finishFirst;
    const started = new Promise(resolve => { firstStarted = resolve; });
    const blocked = new Promise(resolve => { finishFirst = resolve; });
    const agent = new LocalSalesAgent({ sessionDir: '/tmp', fetcher: async (_url, options) => {
        const text = JSON.parse(options.body).messages.at(-1).content;
        if (text === 'Первый') { firstStarted(); await blocked; }
        return new Response(JSON.stringify({ message: { content: `Ответ: ${text}` } }));
    } });
    const context = { enabled: true, knowledge: 'Проверенные факты' };
    const first = agent.generate({ text: 'Первый', context });
    await started;
    assert.equal(await agent.generate({ text: 'Второй', context }), 'Ответ: Второй');
    finishFirst();
    assert.equal(await first, 'Ответ: Первый');
});

test('cloud mode bypasses local Ollama and keeps customer conversation history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shaikh-cloud-sales-'));
    await writeFile(join(dir, 'sales-agent.enabled'), 'enabled');
    const requests = [];
    const sent = [];
    const agent = new LocalSalesAgent({
        sessionDir: dir,
        fetcher: async () => { throw new Error('Cloud mode must not call Ollama'); },
        cloudGenerate: async ({ messages }) => { requests.push(messages); return requests.length === 1 ? 'Здравствуйте! Чем помочь?' : 'Да, мы уже обсуждали ваш вопрос.'; }
    });
    const base = { externalId: 'buyer@s.whatsapp.net', displayName: 'Buyer',
        context: { enabled: true, provider: 'openrouter', model: 'openrouter/free', knowledge: 'Shyraq.ai — платформа для учителей.' },
        sendMessage: async (_recipient, value) => { sent.push(value.text); } };
    try {
        await agent.reply({ ...base, messageId: 'cloud-1', text: 'Здравствуйте' });
        await agent.reply({ ...base, messageId: 'cloud-2', text: 'Помните, о чём говорили?' });
        assert.equal(requests.length, 2);
        assert.deepEqual(requests[1].slice(-3).map(message => message.role), ['user', 'assistant', 'user']);
        assert.equal(sent.length, 2);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('dashboard control changes apply once and do not undo a later local pause', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shaikh-local-control-'));
    const agent = new LocalSalesAgent({ sessionDir: dir });
    try {
        const config = { enableRevision: 'change-1', autoReplies: true, model: 'qwen3:1.7b' };
        await agent.applyControl(config);
        assert.equal(await agent.isEnabled(), true);
        assert.equal(agent.model, 'qwen3:1.7b');
        await unlink(join(dir, 'sales-agent.enabled'));
        await agent.applyControl(config);
        assert.equal(await agent.isEnabled(), false);
        await agent.applyControl({ ...config, enableRevision: 'change-2' });
        assert.equal(await agent.isEnabled(), true);
        await agent.applyControl({ ...config, enableRevision: 'change-3', autoReplies: false });
        assert.equal(await agent.isEnabled(), false);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('test generation works while paused, uses the selected model and never sends WhatsApp', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shaikh-local-demo-'));
    let payload;
    const agent = new LocalSalesAgent({
        sessionDir: dir,
        fetcher: async (_url, options) => {
            payload = JSON.parse(options.body);
            return new Response(JSON.stringify({ message: { content: 'Тестовый ответ' } }));
        }
    });
    try {
        assert.equal(await agent.isEnabled(), false);
        const answer = await agent.generate({ text: 'Привет', context: { enabled: true, knowledge: 'Тестовая компания', model: 'llama3.1:8b' } });
        assert.equal(answer, 'Тестовый ответ');
        assert.equal(payload.model, 'llama3.1:8b');
        assert.equal(await agent.isEnabled(), false);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pausing during generation prevents the pending WhatsApp send', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shaikh-local-pause-'));
    await writeFile(join(dir, 'sales-agent.enabled'), 'enabled');
    let sent = false;
    const agent = new LocalSalesAgent({
        sessionDir: dir,
        fetcher: async () => {
            await unlink(join(dir, 'sales-agent.enabled'));
            return new Response(JSON.stringify({ message: { content: 'Не отправлять' } }));
        }
    });
    try {
        const result = await agent.reply({ externalId: 'customer', messageId: 'pause-1', text: 'Привет',
            context: { enabled: true, knowledge: 'Тест' }, sendMessage: async () => { sent = true; } });
        assert.equal(result.reason, 'disabled');
        assert.equal(sent, false);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('memory survives restart, stays isolated per client and archives the full new dialogue', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shaikh-memory-'));
    await writeFile(join(dir, 'sales-agent.enabled'), 'enabled');
    const payloads = [];
    const setup = { sessionDir: dir, fetcher: async (_url, options) => {
        payloads.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ message: { content: 'Понял вас. Какие задания нужны?' } }));
    } };
    const context = { enabled: true, knowledge: 'Платформа для учителей' };
    const sendMessage = async () => {};
    try {
        await new LocalSalesAgent(setup).reply({ externalId: 'client-a', messageId: 'a1', text: 'Меня зовут Айгуль, я учитель математики, 6 класс.', displayName: 'Айгуль', context, sendMessage });
        const restarted = new LocalSalesAgent(setup);
        await restarted.reply({ externalId: 'client-a', messageId: 'a2', text: 'Вы помните мой класс?', context, sendMessage });
        await restarted.reply({ externalId: 'client-b', messageId: 'b1', text: 'Здравствуйте', context, sendMessage });
        assert.match(payloads[1].messages[0].content, /Айгуль/);
        assert.match(payloads[1].messages[0].content, /6 класс/);
        assert.deepEqual(payloads[1].messages.slice(-3).map(x => x.role), ['user', 'assistant', 'user']);
        assert.equal(JSON.stringify(payloads[2]).includes('Айгуль'), false);
        const archives = await readdir(join(dir, 'sales-transcripts'));
        const lines = (await Promise.all(archives.map(file => readFile(join(dir, 'sales-transcripts', file), 'utf8')))).flatMap(value => value.trim().split('\n'));
        assert.equal(lines.length, 6);
        assert.ok(lines.every(line => JSON.parse(line).at));
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('short replies avoid walls of text while explicit detail requests allow more', () => {
    const long = 'Первое предложение. Второе предложение. Третье предложение. Четвёртое предложение.';
    assert.equal(conversationalReply(long, 'Что это?'), 'Первое предложение. Второе предложение.');
    assert.equal(conversationalReply(long, 'Расскажите подробнее'), long);
    assert.ok(conversationalReply('А'.repeat(1000)).length <= 421);
    assert.throws(() => conversationalReply('<think>hidden'), /безопасный ответ/);
    assert.deepEqual(rememberClient({}, 'Привет').statements, []);
    assert.match(rememberClient({}, '6 класс', '', 'Какой класс вы преподаёте?').statements[0], /6 класс/);
});

test('WhatsApp marks the specific message read and always stops typing, including on errors', async () => {
    const calls = [];
    const socket = {
        readMessages: async keys => { calls.push(['read', keys]); },
        sendPresenceUpdate: async value => { calls.push(value); }
    };
    const timers = { setInterval: () => 1, clearInterval: value => { calls.push(['cleared', value]); } };
    const key = { id: 'm1', remoteJid: 'test' };
    await assert.rejects(withChatPresence(socket, key, 'test', async () => { throw new Error('test error'); }, timers), /test error/);
    assert.deepEqual(calls, [['read', [key]], 'composing', ['cleared', 1], 'paused']);
});
