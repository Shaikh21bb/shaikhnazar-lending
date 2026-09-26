import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAgentReply } from '../server/api/_agent/llm.js';

test('OpenAI Responses tool calls are executed and returned to the model', async () => {
    const previousFetch = global.fetch;
    const previousProvider = process.env.LLM_PROVIDER;
    const previousKey = process.env.OPENAI_API_KEY;
    const previousModel = process.env.OPENAI_MODEL;
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_MODEL = 'test-model';

    const requests = [];
    global.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        if (requests.length === 1) {
            return new Response(JSON.stringify({
                output: [{
                    type: 'function_call',
                    id: 'fc_1',
                    call_id: 'call_1',
                    name: 'create_followup',
                    arguments: '{"due_at":"2026-10-01T10:00:00+05:00"}'
                }]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'Договорились, напишу вам в срок.' }] }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const calls = [];
    try {
        const reply = await generateAgentReply({
            systemPrompt: 'You are a sales agent.',
            history: [],
            userMessage: 'Напишите позже',
            tools: [{
                name: 'create_followup',
                description: 'Create a follow-up',
                parameters: {
                    type: 'object',
                    properties: { due_at: { type: 'string' } },
                    required: ['due_at'],
                    additionalProperties: false
                }
            }],
            callTool: async (name, args) => {
                calls.push({ name, args });
                return { ok: true, task_id: 'task-1' };
            }
        });
        assert.equal(reply, 'Договорились, напишу вам в срок.');
        assert.deepEqual(calls, [{
            name: 'create_followup',
            args: { due_at: '2026-10-01T10:00:00+05:00' }
        }]);
        assert.equal(requests.length, 2);
        assert.equal(requests[1].input.at(-1).type, 'function_call_output');
        assert.equal(requests[1].input.at(-1).call_id, 'call_1');
    } finally {
        global.fetch = previousFetch;
        if (previousProvider === undefined) delete process.env.LLM_PROVIDER;
        else process.env.LLM_PROVIDER = previousProvider;
        if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previousKey;
        if (previousModel === undefined) delete process.env.OPENAI_MODEL;
        else process.env.OPENAI_MODEL = previousModel;
    }
});
