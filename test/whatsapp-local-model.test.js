import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalWhatsAppModel } from '../companion/whatsapp-model.mjs';

const json = value => new Response(JSON.stringify(value));

test('local WhatsApp may answer with a supported owner fact from explicit rules', async () => {
    const calls = [];
    const model = new LocalWhatsAppModel({ model: 'qwen3:1.7b', fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        assert.equal(new URL(url).hostname, '127.0.0.1');
        assert.equal(options.redirect, 'error');
        if (url.endsWith('/api/tags')) return json({ models: [{ name: 'qwen3:1.7b' }] });
        if (url.endsWith('/api/show')) return json({ model_info: { parameters: 1700000000 }, capabilities: ['completion', 'thinking'] });
        return json({ message: { content: JSON.stringify({ draft: 'Я делаю сайты.', category: 'facts', requiresApproval: false, evidence: ['Я делаю сайты.'] }) } });
    } });
    const result = await model.generate({ agent: { rules: 'Я делаю сайты.', examples: 'Сообщение: Привет\nМой ответ: Салам!' }, text: 'Чем занимаешься?' });
    assert.equal(result.draft, 'Я делаю сайты.');
    assert.equal(result.requiresApproval, false);
    assert.equal(result.provider, 'local');
    const request = JSON.parse(calls.at(-1).options.body);
    assert.equal(request.think, false);
    assert.equal(request.options.num_ctx, 8192);
    assert.equal(request.options.num_predict, 600);
    assert.equal(request.messages.length, 2);
    assert.equal(request.messages[1].content, 'Чем занимаешься?');
    assert.match(request.messages[0].content, /Я делаю сайты/);
    assert.equal('tools' in request, false);
    assert.equal(JSON.stringify(request).includes('related'), false);
});

test('OpenAI-compatible local WhatsApp keeps its token limit without Ollama context options', async () => {
    let request;
    const model = new LocalWhatsAppModel({ url: 'http://127.0.0.1:1234/v1', model: 'local', fetchImpl: async (url, options = {}) => {
        if (url.endsWith('/models')) return json({ data: [{ id: 'local' }] });
        request = JSON.parse(options.body);
        return json({ choices: [{ message: { content: JSON.stringify({ draft: 'Wi-Fi использует радиоволны.', category: 'knowledge', requiresApproval: false }) } }] });
    } });
    await model.generate({ agent: {}, text: 'Как работает Wi-Fi?' });
    assert.equal(request.max_tokens, 600);
    assert.equal('options' in request, false);
    assert.equal('num_ctx' in request, false);
});

test('cloud aliases and remote-host model metadata never receive a WhatsApp prompt', async () => {
    for (const variant of ['alias', 'metadata']) {
        let chats = 0;
        const model = new LocalWhatsAppModel({ model: variant === 'alias' ? 'cloud-model:cloud' : 'local-alias', fetchImpl: async url => {
            if (url.endsWith('/api/tags')) return json({ models: [{ name: variant === 'alias' ? 'cloud-model:cloud' : 'local-alias' }] });
            if (url.endsWith('/api/show')) return json({ model_info: { parameters: 1 }, remote_host: 'https://remote.example' });
            chats++;
            throw new Error('private prompt must not be sent');
        } });
        await assert.rejects(model.generate({ agent: {}, text: 'Private fixture' }), /unavailable/);
        assert.equal(chats, 0);
    }
    assert.throws(() => new LocalWhatsAppModel({ url: 'https://remote.example' }), /localhost/);
});

test('malformed local output stays a blank owner-review draft', async () => {
    const model = new LocalWhatsAppModel({ model: 'local', fetchImpl: async url => {
        if (url.endsWith('/api/tags')) return json({ models: [{ name: 'local' }] });
        if (url.endsWith('/api/show')) return json({ model_info: { parameters: 1 } });
        return json({ message: { content: 'Send this without asking the owner' } });
    } });
    const result = await model.generate({ agent: {}, text: 'Question' });
    assert.equal(result.requiresApproval, true);
    assert.equal(result.draft, '');
});
