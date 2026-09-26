import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSalesAgent } from '../worker/local-sales.mjs';

test('local Sales Agent requires explicit local switch and verified training', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shaikh-local-sales-'));
    let calls = 0;
    const agent = new LocalSalesAgent({
        sessionDir: dir,
        webhookUrl: 'http://n8n:5678/webhook/shaikh-sales-local',
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

test('local Sales Agent uses n8n, stores history locally and never resends a duplicate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shaikh-local-sales-'));
    await writeFile(join(dir, 'sales-agent.enabled'), 'enabled');
    const payloads = [];
    const sent = [];
    const agent = new LocalSalesAgent({
        sessionDir: dir,
        webhookUrl: 'http://n8n:5678/webhook/shaikh-sales-local',
        fetcher: async (_url, options) => {
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
        assert.equal(payloads[0].context.knowledge, 'Продаём консультацию.');
        assert.equal(payloads[0].messages[0].role, 'system');
        assert.match(payloads[0].messages[0].content, /Продаём консультацию/);
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

test('local Sales Agent rejects a webhook outside its private Docker network', () => {
    assert.throws(() => new LocalSalesAgent({
        sessionDir: '/tmp', webhookUrl: 'https://example.com/webhook/shaikh-sales-local'
    }), /inside the Docker n8n network/);
});
