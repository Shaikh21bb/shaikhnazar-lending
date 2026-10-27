import { db } from '../_lib.js';
import { decryptCredential } from '../_credentials.js';
import { assessDraft, delegatePrompt, explicitOwnerReply, simpleGreeting } from '../../../lib/whatsapp-policy.mjs';

const failure = (message, status) => Object.assign(new Error(message), { status });

// Only WhatsApp messages reach this function. It never reads personal_records,
// encrypted thoughts or any Obsidian content. No model supplied by a client is used.
export async function generateWorkspaceWhatsApp(rootAgentId, workspaceAgent, input, fetcher = fetch) {
    const text = String(input || '').trim();
    if (!text || text.length > 8000) throw failure('Сообщение слишком длинное.', 400);
    if (workspaceAgent.type !== 'whatsapp' || !workspaceAgent.enabled) throw failure('WhatsApp-агент выключен.', 409);
    const greeting = explicitOwnerReply(text, workspaceAgent) || simpleGreeting(text);
    if (greeting) return { draft: greeting, requiresApproval: false, reason: 'simple', provider: 'local-rule' };
    const result = await db(`personal_agent_secrets?select=secret_box&agent_id=eq.${encodeURIComponent(rootAgentId)}&provider=eq.openrouter&limit=1`);
    if (!result.res.ok) throw failure('Подключение модели временно недоступно.', 503);
    if (!result.body?.[0]) return { draft: '', requiresApproval: true, reason: 'model_unavailable', provider: 'none' };
    const key = decryptCredential(rootAgentId, 'openrouter', result.body[0].secret_box);
    let response;
    try {
        response = await fetcher('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://shaikh.digital', 'X-Title': 'SHAIKH WhatsApp Delegate' },
            body: JSON.stringify({
                model: 'openrouter/free',
                // This router only falls back between free models. Never add
                // a models[] fallback array or a paid provider here.
                messages: [{ role: 'system', content: delegatePrompt(workspaceAgent) }, { role: 'user', content: text }],
                temperature: 0.2, max_tokens: 600, stream: false
            }), signal: AbortSignal.timeout(35_000)
        });
    } catch { return { draft: '', requiresApproval: true, reason: 'model_unavailable', provider: 'none' }; }
    if (!response.ok) return { draft: '', requiresApproval: true, reason: response.status === 429 ? 'free_limit' : 'model_unavailable', provider: 'none' };
    const data = await response.json();
    return { ...assessDraft(text, data?.choices?.[0]?.message?.content), provider: 'openrouter/free' };
}
