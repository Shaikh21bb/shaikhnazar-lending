import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = JSON.parse(await readFile(new URL('../n8n/sales-agent-workflow.json', import.meta.url), 'utf8'));
const nodes = new Map(workflow.nodes.map(node => [node.name, node]));

function runCode(name, json) {
    const code = nodes.get(name).parameters.jsCode;
    return new Function('$input', code)({ first: () => ({ json }) })[0].json;
}

test('n8n diagram has a connected path from webhook to the WhatsApp bridge response', () => {
    let name = '1. WhatsApp: входящий webhook';
    const visited = new Set();
    while (name) {
        assert.ok(nodes.has(name), `Missing node: ${name}`);
        assert.ok(!visited.has(name), `Cycle at ${name}`);
        visited.add(name);
        name = workflow.connections[name]?.main?.[0]?.[0]?.node;
    }
    assert.equal([...visited].at(-1), '7. Ответ WhatsApp-мосту');
    assert.equal(nodes.get('1. WhatsApp: входящий webhook').parameters.responseMode, 'responseNode');
    assert.equal(nodes.get('7. Ответ WhatsApp-мосту').parameters.respondWith, 'firstIncomingItem');
    assert.equal(nodes.get('3. Выбор модели и доп. правила').parameters.fields.values[0].stringValue, '={{ $json.model }}');
});

test('training gate requires company materials before calling Ollama', () => {
    const body = {
        context: { enabled: true, knowledge: 'Продаём консультацию.' },
        model: 'qwen3.5:9b-mlx',
        messages: [
            { role: 'system', content: 'База знаний: Продаём консультацию.' },
            { role: 'user', content: 'Здравствуйте' }
        ]
    };
    assert.equal(runCode('2. Материалы сайта и история', { body }).messages.length, 2);
    assert.throws(() => runCode('2. Материалы сайта и история', { body: { ...body, context: { enabled: true, knowledge: '' } } }), /Обучение/);
    assert.throws(() => runCode('2. Материалы сайта и история', { body: { ...body, context: { enabled: false, knowledge: 'Продаём консультацию.' } } }), /AI выключен/);
});

test('model selection and extra rules affect the actual Ollama request', () => {
    const input = {
        modelChoice: 'llama3.1:8b',
        extraRules: 'Сначала уточните потребность.',
        messages: [{ role: 'system', content: 'База знаний' }, { role: 'user', content: 'Привет' }],
        options: { temperature: 0.1 }
    };
    const request = runCode('4. Подготовить запрос', input);
    assert.equal(request.model, 'llama3.1:8b');
    assert.match(request.messages[0].content, /Сначала уточните потребность/);
    assert.equal(request.messages[1].content, 'Привет');
    assert.throws(() => runCode('4. Подготовить запрос', { ...input, modelChoice: 'untrusted-model' }), /установленных моделей/);
});

test('n8n response contains only the safe reply expected by the local bridge', () => {
    const result = runCode('6. Проверить ответ', { message: { content: '<think>hidden</think>Здравствуйте!' } });
    assert.deepEqual(result, { message: { content: 'Здравствуйте!' } });
    assert.throws(() => runCode('6. Проверить ответ', { message: { content: '' } }), /не вернула/);
});
