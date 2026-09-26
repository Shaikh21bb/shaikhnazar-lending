import { randomUUID } from 'node:crypto';
import { db } from '../_lib.js';
import { getLocalSalesContext } from '../_agent/sales.js';
import { hasProviderKey, safeOpenRouterModel } from './provider.js';

export const LOCAL_MODELS = ['qwen3.5:9b-mlx', 'qwen3:1.7b', 'llama3.1:8b'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const defaultModel = 'qwen3.5:9b-mlx';
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function sanitizeRuntime(input = {}) {
    return {
        mode: 'local',
        enabled: input.enabled === true,
        model: LOCAL_MODELS.includes(input.model) ? input.model : defaultModel,
        models: Array.isArray(input.models) ? input.models.filter(name => LOCAL_MODELS.includes(name)) : [],
        ollama: input.ollama === true,
        workflow: input.workflow === true,
        testing: input.testing === true,
        received: Math.max(0, Math.min(Number(input.received) || 0, 1e9)),
        replies: Math.max(0, Math.min(Number(input.replies) || 0, 1e9)),
        lastInboundAt: timestamp(input.lastInboundAt),
        lastReplyAt: timestamp(input.lastReplyAt),
        lastResult: String(input.lastResult || '').slice(0, 80),
        lastError: String(input.lastError || '').slice(0, 300)
    };
}

export async function loadLocalState(agentId) {
    const result = await db(`whatsapp_bridge_sessions?select=state,qr_image,last_seen_at,last_error,config,runtime&agent_id=eq.${encodeURIComponent(agentId)}&limit=1`);
    if (!result.res.ok) throw new Error('Local agent status unavailable');
    return result.body?.[0] || null;
}

export function localModel(row) {
    return LOCAL_MODELS.includes(row?.config?.model) ? row.config.model : defaultModel;
}

export function selectedProvider(row) {
    return row?.config?.provider === 'openrouter' ? 'openrouter' : 'ollama';
}

export function selectedModel(row) {
    return selectedProvider(row) === 'openrouter'
        ? (safeOpenRouterModel(row?.config?.cloudModel) ? row.config.cloudModel : 'openrouter/free')
        : localModel(row);
}

export async function dashboardLocalStatus(agent) {
    const [row, context] = await Promise.all([loadLocalState(agent.id), getLocalSalesContext(agent, { preview: true })]);
    const fresh = Boolean(row && Date.now() - Date.parse(row.last_seen_at) < 45000);
    const runtime = sanitizeRuntime(row?.runtime);
    const provider = selectedProvider(row);
    const keyConfigured = provider === 'openrouter' ? await hasProviderKey(agent.id) : false;
    const model = selectedModel(row);
    const aiEnabled = agent.status === 'active' && agent.ai_enabled !== false;
    const trainingReady = Boolean(context.knowledge?.trim());
    const checks = {
        mac: fresh && row?.runtime?.mode === 'local',
        whatsapp: fresh && row.state === 'connected',
        ollama: provider === 'openrouter' ? keyConfigured : fresh && runtime.ollama && runtime.models.includes(model),
        workflow: provider === 'openrouter' ? true : fresh && runtime.workflow,
        training: trainingReady,
        replies: aiEnabled && runtime.enabled
    };
    return {
        state: fresh ? row.state : 'offline',
        qrImage: fresh && row.state === 'qr' ? row.qr_image : null,
        lastSeenAt: row?.last_seen_at || null,
        error: row?.last_error || null,
        provider, model, keyConfigured, runtime, checks, aiEnabled,
        ready: Object.values(checks).every(Boolean),
        trainingCharacters: context.knowledge?.length || 0
    };
}

export async function configureLocalAgent(agent, body) {
    const row = await loadLocalState(agent.id);
    const config = { ...(row?.config || {}) };
    const updates = {};
    if (body.provider !== undefined) {
        if (!['ollama', 'openrouter'].includes(body.provider)) throw failure('Неверный провайдер модели.');
        config.provider = body.provider;
    }
    if (body.model !== undefined) {
        if (selectedProvider({ config }) === 'openrouter') {
            if (!safeOpenRouterModel(body.model)) throw failure('Выберите модель OpenRouter.');
            config.cloudModel = body.model;
        } else {
            if (!LOCAL_MODELS.includes(body.model)) throw failure('Выберите одну из установленных моделей.');
            config.model = body.model;
        }
    }
    if (body.projectId !== undefined) {
        if (body.projectId !== null && !UUID.test(body.projectId)) throw failure('Неверный проект обучения.');
        updates.project_id = body.projectId;
    }
    if (body.language !== undefined) {
        if (!['ru', 'kk'].includes(body.language)) throw failure('Неверный язык.');
        updates.language = body.language;
    }
    if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') throw failure('Неверное состояние AI.');
        if (body.enabled) {
            const context = await getLocalSalesContext({ ...agent, ...updates }, { preview: true });
            if (!context.knowledge?.trim()) throw failure('Сначала добавьте материалы в «Обучить».');
        }
        updates.ai_enabled = body.enabled;
        updates.status = body.enabled ? 'active' : 'paused';
        config.autoReplies = body.enabled;
        config.enableRevision = randomUUID();
    }
    if (Object.keys(updates).length) {
        const result = await db(`agents?id=eq.${agent.id}`, { method: 'PATCH', body: JSON.stringify(updates) });
        if (!result.res.ok) throw new Error('Agent settings save failed');
    }
    // PATCH keeps heartbeat/runtime updates independent from owner controls.
    const ensured = await db('whatsapp_bridge_sessions?on_conflict=agent_id', {
        method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify({ agent_id: agent.id })
    });
    if (!ensured.res.ok) throw new Error('Local controls unavailable');
    const saved = await db(`whatsapp_bridge_sessions?agent_id=eq.${agent.id}`, { method: 'PATCH', body: JSON.stringify({ config }) });
    if (!saved.res.ok) throw new Error('Local controls save failed');
    return { ok: true, provider: selectedProvider({ config }), model: selectedModel({ config }) };
}

export async function createLocalTest(agent, body) {
    const text = String(body.text || '').trim().slice(0, 4000);
    if (!text) throw failure('Напишите тестовое сообщение.');
    const status = await dashboardLocalStatus(agent);
    if (!status.checks.mac || !status.checks.ollama || !status.checks.workflow) throw failure(status.provider === 'openrouter'
        ? 'Запустите WhatsApp-сервер на Mac и добавьте действительный API-ключ OpenRouter.'
        : 'Запустите локальный сервер на Mac и дождитесь готовности модели.', 409);
    if (!status.checks.training) throw failure('Добавьте материалы в «Обучить».', 409);
    const history = Array.isArray(body.history) ? body.history
        .filter(item => ['user', 'assistant'].includes(item?.role) && typeof item.content === 'string')
        .slice(-8).map(item => ({ role: item.role, content: item.content.slice(0, 2000) })) : [];
    const now = new Date().toISOString();
    const cleanup = await db(`local_agent_tests?agent_id=eq.${agent.id}&expires_at=lt.${encodeURIComponent(now)}`, { method: 'DELETE' });
    if (!cleanup.res.ok) throw new Error('Test cleanup failed');
    const result = await db('local_agent_tests', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ agent_id: agent.id, input: { text, history, provider: status.provider }, model: status.model,
            expires_at: new Date(Date.now() + 180000).toISOString() })
    });
    if (result.res.status === 409) throw failure('Предыдущий тест ещё выполняется. Дождитесь ответа.', 409);
    if (!result.res.ok) throw new Error('Could not create local test');
    return { id: result.body[0].id, state: 'pending' };
}

export async function localTestResult(agentId, id) {
    if (!UUID.test(id)) throw failure('Неверный тест.');
    const result = await db(`local_agent_tests?select=state,answer,error,model,expires_at&agent_id=eq.${agentId}&id=eq.${id}&limit=1`);
    if (!result.res.ok) throw new Error('Test status unavailable');
    const row = result.body?.[0];
    if (!row) throw failure('Тест не найден или уже истёк.', 404);
    if (Date.parse(row.expires_at) < Date.now()) return { state: 'expired', error: 'Время ожидания истекло. Проверьте локальный сервер.' };
    return row;
}

export async function claimLocalTest(agent) {
    const now = new Date().toISOString();
    const result = await db(`local_agent_tests?select=id,input,model&agent_id=eq.${agent.id}&state=eq.pending&expires_at=gt.${encodeURIComponent(now)}&order=created_at.asc&limit=1`);
    if (!result.res.ok) throw new Error('Test queue unavailable');
    const job = result.body?.[0];
    if (!job) return null;
    const claim = await db(`local_agent_tests?id=eq.${job.id}&state=eq.pending`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ state: 'processing' })
    });
    if (!claim.res.ok) throw new Error('Test claim failed');
    if (!claim.body?.length) return null;
    const context = await getLocalSalesContext(agent, { preview: true });
    return { ...job, context: { ...context, provider: job.input?.provider === 'openrouter' ? 'openrouter' : 'ollama', model: job.model } };
}

export async function finishLocalTest(agentId, body) {
    if (!UUID.test(String(body.id))) throw failure('Invalid test ID');
    const answer = String(body.answer || '').trim().slice(0, 2000);
    const result = await db(`local_agent_tests?id=eq.${body.id}&agent_id=eq.${agentId}&state=eq.processing`, {
        method: 'PATCH', body: JSON.stringify({
            state: answer ? 'completed' : 'failed', answer: answer || null,
            error: answer ? null : String(body.error || 'Локальная модель не ответила.').slice(0, 300)
        })
    });
    if (!result.res.ok) throw new Error('Test result save failed');
    return { ok: true };
}
