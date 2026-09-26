const OPENAI_URL = 'https://api.openai.com/v1/responses';

function outputText(response) {
    if (response.output_text) return response.output_text.trim();
    return (response.output || [])
        .filter(item => item.type === 'message')
        .flatMap(item => item.content || [])
        .filter(item => item.type === 'output_text')
        .map(item => item.text || '')
        .join('\n')
        .trim();
}

function asMessages(history, userMessage) {
    const messages = (history || []).map(item => ({
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: String(item.text || '').slice(0, 4000)
    }));
    messages.push({ role: 'user', content: String(userMessage || '').slice(0, 4000) });
    return messages;
}

async function openaiRequest(body) {
    const response = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`OpenAI API ${response.status}: ${data.error?.message || 'request failed'}`);
    }
    return data;
}

async function runOpenAI({ systemPrompt, history, userMessage, tools, callTool }) {
    let input = asMessages(history, userMessage);
    const model = process.env.OPENAI_MODEL || process.env.LLM_MODEL || 'gpt-6-luna';
    const apiTools = (tools || []).map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: true
    }));

    for (let turn = 0; turn < 4; turn++) {
        const request = {
            model,
            instructions: systemPrompt,
            input,
            reasoning: { effort: process.env.OPENAI_REASONING_EFFORT || 'low' },
            max_output_tokens: 700
        };
        if (apiTools.length) {
            request.tools = apiTools;
            request.tool_choice = 'auto';
        }
        const response = await openaiRequest(request);
        const calls = (response.output || []).filter(item => item.type === 'function_call');
        if (!calls.length) {
            const text = outputText(response);
            if (!text) throw new Error('OpenAI returned an empty response');
            return text.slice(0, 4000);
        }

        input = input.concat(response.output || []);
        for (const call of calls) {
            let args = {};
            try { args = JSON.parse(call.arguments || '{}'); } catch (_) { /* handled by tool */ }
            let result;
            try {
                result = await callTool(call.name, args);
            } catch (error) {
                result = { ok: false, error: error.message };
            }
            input.push({
                type: 'function_call_output',
                call_id: call.call_id,
                output: JSON.stringify(result)
            });
        }
    }
    throw new Error('OpenAI tool loop exceeded the limit');
}

function geminiRole(role) {
    return role === 'assistant' ? 'model' : 'user';
}

async function runGemini({ systemPrompt, history, userMessage, tools, callTool }) {
    const model = process.env.GEMINI_MODEL || process.env.LLM_MODEL || 'gemini-2.0-flash';
    let contents = (history || []).map(item => ({
        role: geminiRole(item.role),
        parts: [{ text: String(item.text || '').slice(0, 4000) }]
    }));
    contents.push({ role: 'user', parts: [{ text: String(userMessage || '').slice(0, 4000) }] });
    const functionDeclarations = (tools || []).map(tool => {
        const { additionalProperties: _ignored, ...parameters } = tool.parameters;
        return {
            name: tool.name,
            description: tool.description,
            parameters
        };
    });

    for (let turn = 0; turn < 4; turn++) {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: systemPrompt }] },
                    contents,
                    tools: functionDeclarations.length ? [{ functionDeclarations }] : undefined,
                    generationConfig: { temperature: 0.35, maxOutputTokens: 700 }
                })
            }
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(`Gemini API ${response.status}: ${data.error?.message || 'request failed'}`);
        }
        const content = data.candidates?.[0]?.content;
        const parts = content?.parts || [];
        const calls = parts.filter(part => part.functionCall);
        if (!calls.length) {
            const text = parts.map(part => part.text || '').join('\n').trim();
            if (!text) throw new Error('Gemini returned an empty response');
            return text.slice(0, 4000);
        }

        contents.push(content);
        const results = [];
        for (const part of calls) {
            const call = part.functionCall;
            let result;
            try {
                result = await callTool(call.name, call.args || {});
            } catch (error) {
                result = { ok: false, error: error.message };
            }
            results.push({ functionResponse: { name: call.name, response: result } });
        }
        contents.push({ role: 'user', parts: results });
    }
    throw new Error('Gemini tool loop exceeded the limit');
}

export function activeLlmProvider() {
    const configured = String(process.env.LLM_PROVIDER || '').toLowerCase();
    if (configured) return configured;
    if (process.env.OPENAI_API_KEY) return 'openai';
    if (process.env.GEMINI_API_KEY) return 'gemini';
    return '';
}

export async function generateAgentReply(context) {
    const provider = activeLlmProvider();
    if (provider === 'openai') {
        if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
        return runOpenAI(context);
    }
    if (provider === 'gemini') {
        if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
        return runGemini(context);
    }
    throw new Error('Configure OPENAI_API_KEY or GEMINI_API_KEY on the server');
}
