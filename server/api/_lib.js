const SUPABASE_URL = process.env.SUPABASE_URL || '';
// Server routes should use the service role. SUPABASE_KEY remains as a
// backwards-compatible fallback for existing deployments.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';

export async function db(path, options = {}) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing');
    }
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...options,
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    const text = await res.text();
    return { res, body: text ? JSON.parse(text) : null };
}

export async function readJsonBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.rawBody === 'string') return req.rawBody ? JSON.parse(req.rawBody) : {};
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : {};
}

export async function telegram(method, token, payload = {}) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) {
        throw new Error(`Telegram API ${method}: ${data.description || 'Unknown error'}`);
    }
    return data.result;
}

const MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro-latest'];

export async function gemini(systemPrompt, historyText, userMessage) {
    if (!process.env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY missing');
    }

    const parts = [
        { text: systemPrompt },
        ...(historyText ? [{ text: historyText }] : []),
        { text: `Сообщение клиента:\n${userMessage}` }
    ];

    let response;
    let lastError = '';
    for (const modelName of MODELS) {
        response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: { temperature: 0.6 }
            })
        });
        if (response.ok) break;
        lastError = await response.text();
    }

    if (!response || !response.ok) {
        throw new Error('Gemini error: ' + lastError);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new Error('Gemini returned empty response');
    return text.slice(0, 4000);
}

export function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}
