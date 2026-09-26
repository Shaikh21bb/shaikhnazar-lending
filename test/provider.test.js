import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://database.example';
process.env.SUPABASE_KEY = 'test-service-key';
process.env.AUTH_SECRET = 'a-long-independent-secret-for-provider-tests';
const { encryptProviderKey, decryptProviderKey, saveProviderKey, generateOpenRouter, openRouterModels } = await import('../server/api/whatsapp/provider.js');
const agentId = '00000000-0000-0000-0000-000000000001';
const otherId = '00000000-0000-0000-0000-000000000002';
const key = 'sk-or-v1-abcdefghijklmnop';

test('provider key is encrypted per agent and tampering is rejected', () => {
    const box = encryptProviderKey(agentId, key);
    assert.ok(!box.includes(key));
    assert.equal(decryptProviderKey(agentId, box), key);
    assert.throws(() => decryptProviderKey(otherId, box), /Не удалось прочитать/);
    assert.throws(() => decryptProviderKey(agentId, box.slice(0, -1) + 'X'), /Не удалось прочитать/);
});

test('key validation and cloud generation keep the key server-side', async () => {
    const original = globalThis.fetch;
    let box;
    let completion;
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).includes('/agent_provider_keys?') && options.method === 'POST') {
            box = JSON.parse(options.body).secret_box;
            return new Response('', { status: 201 });
        }
        if (String(url).includes('/agent_provider_keys?')) return new Response(JSON.stringify([{ secret_box: box }]));
        throw new Error(`Unexpected database URL: ${url}`);
    };
    const providerFetch = async (url, options) => {
        if (String(url).endsWith('/key')) return new Response(JSON.stringify({ data: { label: 'test' } }));
        completion = { url, options };
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Здравствуйте! Чем помочь?' } }] }));
    };
    try {
        await assert.rejects(saveProviderKey(agentId, 'not-an-api-key', providerFetch), /действительный API-ключ/);
        assert.deepEqual(await saveProviderKey(agentId, key, providerFetch), { ok: true, keyConfigured: true });
        assert.ok(!box.includes(key));
        const answer = await generateOpenRouter(agentId, 'openrouter/free', [
            { role: 'system', content: 'Answer briefly' }, { role: 'user', content: 'Привет' }
        ], providerFetch);
        assert.equal(answer, 'Здравствуйте! Чем помочь?');
        assert.equal(completion.options.headers.Authorization, `Bearer ${key}`);
        assert.equal(JSON.parse(completion.options.body).model, 'openrouter/free');
        assert.equal(JSON.parse(completion.options.body).max_tokens, 220);
    } finally { globalThis.fetch = original; }
});

test('model catalog labels free and paid choices without provider credentials', async () => {
    const catalog = await openRouterModels(async () => new Response(JSON.stringify({ data: [
        { id: 'vendor/free:free', name: 'Free', architecture: { output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } },
        { id: 'vendor/fast', name: 'Fast', architecture: { output_modalities: ['text'] }, pricing: { prompt: '0.000001', completion: '0.000002' } }
    ] })));
    assert.equal(catalog[0].id, 'openrouter/free');
    assert.equal(catalog[1].free, true);
    assert.equal(catalog[2].free, false);
    assert.equal(catalog[2].inputPerMillion, 1);
});
