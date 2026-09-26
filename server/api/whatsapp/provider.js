import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { db } from '../_lib.js';

const endpoint = 'https://openrouter.ai/api/v1';
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const modelPattern = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:+-]*$/i;

export function safeOpenRouterModel(value) {
    return typeof value === 'string' && value.length <= 120 && modelPattern.test(value);
}

function encryptionKey(agentId) {
    const secret = process.env.AUTH_SECRET || '';
    if (secret.length < 32) throw failure('Сервер не готов к безопасному хранению API-ключей.', 503);
    return Buffer.from(hkdfSync('sha256', secret, agentId, 'shaikh/openrouter-key/v1', 32));
}

export function encryptProviderKey(agentId, plain) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey(agentId), iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}

export function decryptProviderKey(agentId, box) {
    const parts = String(box || '').split('.');
    if (parts.length !== 3) throw failure('Сохранённый API-ключ повреждён. Добавьте его заново.', 503);
    try {
        const decipher = createDecipheriv('aes-256-gcm', encryptionKey(agentId), Buffer.from(parts[0], 'base64url'));
        decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8');
    } catch {
        throw failure('Не удалось прочитать API-ключ. Добавьте его заново.', 503);
    }
}

export async function hasProviderKey(agentId) {
    const { res, body } = await db(`agent_provider_keys?select=agent_id&agent_id=eq.${agentId}&provider=eq.openrouter&limit=1`);
    if (!res.ok) throw new Error('Provider key status unavailable');
    return Boolean(body?.[0]);
}

async function loadProviderKey(agentId) {
    const { res, body } = await db(`agent_provider_keys?select=secret_box&agent_id=eq.${agentId}&provider=eq.openrouter&limit=1`);
    if (!res.ok) throw new Error('Provider key unavailable');
    if (!body?.[0]) throw failure('Добавьте API-ключ OpenRouter в настройках агента.', 409);
    return decryptProviderKey(agentId, body[0].secret_box);
}

export async function saveProviderKey(agentId, rawKey, fetcher = fetch) {
    const key = String(rawKey || '').trim();
    if (!/^sk-or-[A-Za-z0-9_-]{16,}$/.test(key) || key.length > 512) throw failure('Введите действительный API-ключ OpenRouter.');
    let response;
    try {
        response = await fetcher(`${endpoint}/key`, {
            headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(12000)
        });
    } catch { throw failure('OpenRouter сейчас недоступен. Попробуйте позже.', 503); }
    if (!response.ok) throw failure(response.status === 401 ? 'OpenRouter отклонил ключ.' : 'Не удалось проверить ключ в OpenRouter.', response.status === 401 ? 400 : 503);
    const { res } = await db('agent_provider_keys?on_conflict=agent_id,provider', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ agent_id: agentId, provider: 'openrouter', secret_box: encryptProviderKey(agentId, key), updated_at: new Date().toISOString() })
    });
    if (!res.ok) throw new Error('Provider key save failed');
    return { ok: true, keyConfigured: true };
}

export async function deleteProviderKey(agentId) {
    const { res } = await db(`agent_provider_keys?agent_id=eq.${agentId}&provider=eq.openrouter`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Provider key removal failed');
    return { ok: true, keyConfigured: false };
}

export async function openRouterModels(fetcher = fetch) {
    let response;
    try { response = await fetcher(`${endpoint}/models`, { signal: AbortSignal.timeout(10000) }); }
    catch { return [{ id: 'openrouter/free', name: 'Бесплатная модель · авто', free: true }]; }
    if (!response.ok) return [{ id: 'openrouter/free', name: 'Бесплатная модель · авто', free: true }];
    const data = await response.json();
    const list = Array.isArray(data?.data) ? data.data : [];
    const models = list.filter(item => safeOpenRouterModel(item.id) && item.architecture?.output_modalities?.includes('text'))
        .map(item => ({ id: item.id, name: String(item.name || item.id).slice(0, 100),
            free: Number(item.pricing?.prompt) === 0 && Number(item.pricing?.completion) === 0,
            inputPerMillion: Number(item.pricing?.prompt) * 1e6,
            outputPerMillion: Number(item.pricing?.completion) * 1e6 }))
        .filter(item => Number.isFinite(item.inputPerMillion) && Number.isFinite(item.outputPerMillion));
    const byId = new Map(models.map(item => [item.id, item]));
    // A concise, changing-with-the-catalogue set of ordinary chat models.
    // Batch, image/audio, safety and coding models do not belong in a Sales Agent picker.
    const preferred = [
        'inclusionai/ling-3.0-flash-fin:free',
        'nvidia/nemotron-3.5-lightning:free',
        'google/gemma-4-26b-a4b-it:free',
        'qwen/qwen3.8-27b:free',
        'google/gemini-2.5-flash-lite',
        'qwen/qwen3.5-flash-02-23',
        'deepseek/deepseek-v4-flash',
        'openai/gpt-6-luna'
    ];
    const chosen = preferred.map(id => byId.get(id)).filter(Boolean);
    const used = new Set(chosen.map(item => item.id));
    const general = item => !/(batch|audio|image|vision|\bvl\b|omni|safety|code|router|lyria|medical|sante|inkling)/i.test(`${item.id} ${item.name}`);
    const freeExtras = models.filter(item => item.free && !used.has(item.id) && general(item)).slice(0, 3);
    const paidExtras = models.filter(item => !item.free && !used.has(item.id) && general(item))
        .sort((a, b) => a.inputPerMillion - b.inputPerMillion).slice(0, 2);
    return [{ id: 'openrouter/free', name: 'Бесплатная модель · авто', free: true }, ...chosen, ...freeExtras, ...paidExtras];
}

export async function generateOpenRouter(agentId, model, messages, fetcher = fetch) {
    if (!safeOpenRouterModel(model)) throw failure('Неверная модель.', 400);
    if (!Array.isArray(messages) || messages.length < 2 || messages.length > 22 ||
        messages[0]?.role !== 'system' || messages.at(-1)?.role !== 'user' ||
        messages.some(item => !['system', 'user', 'assistant'].includes(item?.role) || typeof item.content !== 'string' || item.content.length > 32000)) {
        throw failure('Неверный формат диалога.', 400);
    }
    const key = await loadProviderKey(agentId);
    let response;
    try {
        response = await fetcher(`${endpoint}/chat/completions`, {
            method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
                'HTTP-Referer': 'https://shaikh.digital', 'X-Title': 'SHAIKH Sales Agent' },
            body: JSON.stringify({ model, messages, stream: false, max_tokens: 220, temperature: 0.3 }),
            signal: AbortSignal.timeout(45000)
        });
    } catch { throw failure('OpenRouter не ответил за 45 секунд. Попробуйте другую модель.', 504); }
    if (!response.ok) {
        const messages = { 401: 'OpenRouter отклонил API-ключ. Замените его в настройках.',
            402: 'На ключе OpenRouter не хватает средств для этой модели.',
            429: 'Лимит модели OpenRouter исчерпан. Попробуйте другую модель.',
            404: 'Модель больше недоступна. Выберите другую.' };
        throw failure(messages[response.status] || 'OpenRouter временно не отвечает. Попробуйте другую модель.', response.status === 429 ? 429 : 502);
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    const answer = typeof content === 'string' ? content.trim() : '';
    if (!answer) throw failure('Модель вернула пустой ответ. Выберите другую.', 502);
    return answer.slice(0, 4000);
}
