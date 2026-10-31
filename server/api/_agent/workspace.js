import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { db, telegram } from '../_lib.js';
import { ensurePersonalAgent, personalTelegramToken } from './personal.js';
import { encryptEnvelope } from '../../../lib/private-envelope.mjs';
import { generateWorkspaceWhatsApp } from './workspace-whatsapp.js';
import { personalWhatsAppJid } from '../../../lib/whatsapp-policy.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const JOB_KINDS = new Set(['thought', 'telegram_thought', 'whatsapp_connect', 'whatsapp_disconnect']);
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const encode = value => encodeURIComponent(String(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const telegramConversationKey = (root, device) => hash(`${root.id}:${device.id}:${root.telegram_owner_user_id}`);
const clean = (value, max) => String(value ?? '').trim().slice(0, max);
const first = value => Array.isArray(value) ? value[0] : value;
const writeHeaders = { Prefer: 'return=representation' };
const APPROVAL_PAGE_SIZE = 250;
const APPROVAL_FIELDS = 'id,agent_id,recipient,original,draft,reason,status,expires_at,created_at,decided_at,delivered_at,activity_at';
export const WORKSPACE_SETTINGS = Object.freeze({ timezone: 'Asia/Almaty', quietStart: 22, quietEnd: 9, digestHour: 9 });

async function rest(path, options = {}) {
    const result = await db(path, options);
    if (!result.res.ok) {
        const error = failure('Личный кабинет временно недоступен. Повторите позже.', 503);
        error.code = result.body?.code || String(result.res.status);
        throw error;
    }
    return result.body;
}

async function rpc(name, body) {
    return rest(`rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });
}

function requireUuid(value) {
    if (!UUID.test(String(value || ''))) throw failure('Некорректный идентификатор.');
    return String(value);
}

export function validateWorkspacePublicKey(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.kty !== 'RSA' || value.e !== 'AQAB' || typeof value.n !== 'string'
        || !/^[A-Za-z0-9_-]{342,684}$/.test(value.n)
        || ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].some(key => key in value)) {
        throw failure('Нужен открытый ключ RSA не короче 2048 бит.');
    }
    return { kty: 'RSA', e: 'AQAB', n: value.n, alg: 'RSA-OAEP-256', ext: true, key_ops: ['encrypt'] };
}

function base64Bytes(value, min, max) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
    const bytes = Buffer.from(value, 'base64');
    return bytes.length >= min && bytes.length <= max;
}

export function validateWorkspaceEnvelope(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['v', 'wrappedKey', 'iv', 'ciphertext'].includes(key))
        || value.v !== 1 || !base64Bytes(value.wrappedKey, 256, 512)
        || !base64Bytes(value.iv, 12, 12) || !base64Bytes(value.ciphertext, 16, 524288)) {
        throw failure('Не удалось проверить зашифрованное сообщение. Отправьте его ещё раз.');
    }
    return { v: 1, wrappedKey: value.wrappedKey, iv: value.iv, ciphertext: value.ciphertext };
}

function publicDevice(device) {
    if (!device || device.revoked_at) return null;
    return {
        id: device.id, name: device.name, public_key: device.public_key,
        status: device.status, model: device.model,
        last_seen_at: device.last_seen_at, created_at: device.created_at
    };
}

function publicAgent(agent) {
    return {
        id: agent.id, name: agent.name, type: agent.type, rules: agent.rules,
        examples: agent.examples, enabled: agent.enabled,
        created_at: agent.created_at, updated_at: agent.updated_at
    };
}

function publicJob(job) {
    return {
        id: job.id, kind: job.kind, status: job.status, result_envelope: job.result_envelope,
        error_code: job.error_code, created_at: job.created_at, updated_at: job.updated_at
    };
}

async function workspaceDevice(rootId) {
    return first(await rest(`workspace_devices?select=*&root_id=eq.${encode(rootId)}&revoked_at=is.null&limit=1`)) || null;
}

async function listAgents(rootId) {
    return await rest(`workspace_agents?select=*&root_id=eq.${encode(rootId)}&order=created_at.asc&limit=24`) || [];
}

async function ensureDefaultAgent(rootId, agents) {
    if (agents.some(agent => agent.type === 'personal')) return agents;
    const result = await db('workspace_agents', {
        method: 'POST', headers: writeHeaders,
        body: JSON.stringify({ root_id: rootId, name: 'Личный агент', type: 'personal', enabled: true })
    });
    if (result.res.ok) return [...agents, ...result.body];
    if (result.res.status === 409) return listAgents(rootId);
    throw failure('Не удалось подготовить личного агента.', 503);
}

function approvalOffset(value) {
    const scalar = Array.isArray(value) ? value[0] : value;
    if (scalar === undefined || scalar === null || scalar === '') return 0;
    const offset = Number(scalar);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - APPROVAL_PAGE_SIZE) {
        throw failure('Некорректная страница согласований.');
    }
    return offset;
}

export async function workspaceOverview(session, options = {}) {
    const offset = approvalOffset(options.approvalOffset);
    const root = await ensurePersonalAgent(session);
    const now = new Date().toISOString();
    const results = await Promise.all([
        workspaceDevice(root.id), listAgents(root.id),
        rest(`workspace_jobs?select=id,kind,status,result_envelope,error_code,created_at,updated_at&root_id=eq.${encode(root.id)}&order=created_at.desc&limit=60`),
        rest(`workspace_reminders?select=id,due_at,status,sent_at&root_id=eq.${encode(root.id)}&status=not.in.(complete,cancelled)&order=due_at.asc&limit=100`),
        // Active decisions must not disappear behind newer completed history.
        rest(`workspace_approvals?select=${APPROVAL_FIELDS}&root_id=eq.${encode(root.id)}&status=eq.pending&expires_at=gt.${encode(now)}&order=created_at.asc,id.asc&offset=${offset}&limit=${APPROVAL_PAGE_SIZE + 1}`),
        rest(`workspace_approvals?select=${APPROVAL_FIELDS}&root_id=eq.${encode(root.id)}&or=${encode(`(status.neq.pending,expires_at.lte.${now})`)}&order=activity_at.desc,id.desc&limit=60`)
    ]);
    const pending = results[4] || [];
    return {
        device: publicDevice(results[0]), agents: (await ensureDefaultAgent(root.id, results[1])).map(publicAgent),
        jobs: (results[2] || []).map(publicJob), reminders: results[3] || [], approvals: pending.slice(0, APPROVAL_PAGE_SIZE),
        approvalPage: { offset, limit: APPROVAL_PAGE_SIZE, hasMore: pending.length > APPROVAL_PAGE_SIZE },
        approvalHistory: (results[5] || []).map(approval => ['pending', 'approved'].includes(approval.status) && Date.parse(approval.expires_at) <= Date.parse(now)
            ? { ...approval, status: 'expired' } : approval),
        settings: WORKSPACE_SETTINGS, telegram: { connected: Boolean(root.telegram_owner_chat_id) }
    };
}

function whatsappActivationConflict() {
    return failure('Для этого номера уже включён другой WhatsApp-агент. Сначала остановите его в разделе «Агенты».', 409);
}

function agentInput(value, current = null) {
    const name = clean(value?.name ?? current?.name, 80);
    const type = current?.type || value?.type;
    if (!name || !['personal', 'whatsapp'].includes(type)) throw failure('Укажите имя и тип агента.');
    if (value?.rules && String(value.rules).length > 6000) throw failure('Правила: не больше 6000 символов.');
    if (value?.examples && String(value.examples).length > 12000) throw failure('Примеры: не больше 12000 символов.');
    return {
        name, type, rules: clean(value?.rules ?? current?.rules, 6000),
        examples: clean(value?.examples ?? current?.examples, 12000),
        enabled: typeof value?.enabled === 'boolean' ? value.enabled : current?.enabled || false
    };
}

async function insertJob(root, device, body) {
    if (!device) throw failure('Сначала подключите MacBook в разделе «Мой Mac».', 409);
    const kind = body.kind || 'thought';
    if (!JOB_KINDS.has(kind)) throw failure('Неизвестный тип задания.');
    const requestId = body.request_id || body.requestId;
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(requestId)) throw failure('Нужен уникальный идентификатор отправки.');
    const envelope = validateWorkspaceEnvelope(body.envelope);
    const result = await rest('workspace_jobs?on_conflict=root_id,request_id', {
        method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify({ root_id: root.id, device_id: device.id, kind, request_id: requestId, envelope })
    });
    const job = first(result) || first(await rest(`workspace_jobs?select=id,kind,status,result_envelope,error_code,created_at,updated_at&root_id=eq.${encode(root.id)}&request_id=eq.${encode(requestId)}&limit=1`));
    return { job: publicJob(job) };
}

export async function workspaceMutation(session, body) {
    const root = await ensurePersonalAgent(session);
    switch (body.action) {
    case 'create_pairing': {
        const code = randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
        await rest('workspace_pairings?on_conflict=root_id', {
            method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify({ root_id: root.id, code_hash: hash(code), expires_at: expiresAt })
        });
        return { code, expires_at: expiresAt };
    }
    case 'create_agent': {
        const agents = await listAgents(root.id);
        if (agents.length >= 12) throw failure('Для первой версии доступно до 12 агентов.');
        const input = agentInput(body.agent || body);
        if (input.type === 'personal' && agents.some(agent => agent.type === 'personal')) throw failure('Личный агент уже создан.');
        const created = first(await rest('workspace_agents', {
            method: 'POST', headers: writeHeaders,
            body: JSON.stringify({ ...input, root_id: root.id, enabled: input.type === 'personal' ? input.enabled : false })
        }));
        return { agent: publicAgent(created) };
    }
    case 'update_agent': {
        const id = requireUuid(body.id || body.agent?.id);
        const current = first(await rest(`workspace_agents?select=*&id=eq.${encode(id)}&root_id=eq.${encode(root.id)}&limit=1`));
        if (!current) throw failure('Агент не найден.', 404);
        const input = agentInput(body.agent || body, current);
        if (input.type === 'whatsapp' && input.enabled) {
            const other = first(await rest(`workspace_agents?select=id&root_id=eq.${encode(root.id)}&type=eq.whatsapp&enabled=eq.true&id=neq.${encode(id)}&limit=1`));
            if (other) throw whatsappActivationConflict();
        }
        let updated;
        try {
            updated = first(await rest(`workspace_agents?id=eq.${encode(id)}&root_id=eq.${encode(root.id)}`, {
                method: 'PATCH', headers: writeHeaders,
                body: JSON.stringify({ ...input, updated_at: new Date().toISOString() })
            }));
        } catch (error) {
            // The partial unique index also protects simultaneous activations
            // that both passed the friendly preflight check.
            if (input.type === 'whatsapp' && input.enabled && error.code === '23505') throw whatsappActivationConflict();
            throw error;
        }
        if (!updated) throw failure('Агент не найден.', 404);
        return { agent: publicAgent(updated) };
    }
    case 'enqueue':
        return insertJob(root, await workspaceDevice(root.id), body);
    case 'approve':
    case 'reject': {
        const id = requireUuid(body.id);
        const update = { status: body.action === 'approve' ? 'approved' : 'rejected', decided_at: new Date().toISOString() };
        if (body.action === 'approve') {
            const current = first(await rest(`workspace_approvals?select=draft&id=eq.${encode(id)}&root_id=eq.${encode(root.id)}&status=eq.pending&expires_at=gt.${encode(new Date().toISOString())}&limit=1`));
            if (!current) throw failure('Этот ответ уже обработан или срок согласования истёк.', 409);
            const finalDraft = body.draft === undefined ? current.draft : String(body.draft);
            if (!String(finalDraft).trim() || String(finalDraft).length > 4000) throw failure('Перед отправкой напишите ответ: от 1 до 4000 символов.');
            update.draft = String(finalDraft).trim();
        }
        const decision = first(await rest(`workspace_approvals?id=eq.${encode(id)}&root_id=eq.${encode(root.id)}&status=eq.pending&expires_at=gt.${encode(new Date().toISOString())}`, {
            method: 'PATCH', headers: writeHeaders, body: JSON.stringify(update)
        }));
        if (!decision) throw failure('Этот ответ уже обработан или срок согласования истёк.', 409);
        return { approval: decision };
    }
    case 'complete_reminder':
    case 'cancel_reminder': {
        const reminder = first(await rest(`workspace_reminders?id=eq.${encode(requireUuid(body.id))}&root_id=eq.${encode(root.id)}&status=not.in.(complete,cancelled)`, {
            method: 'PATCH', headers: writeHeaders,
            body: JSON.stringify({ status: body.action === 'complete_reminder' ? 'complete' : 'cancelled' })
        }));
        if (!reminder) throw failure('Напоминание не найдено.', 404);
        return { reminder };
    }
    case 'revoke_device': {
        await rest(`workspace_devices?root_id=eq.${encode(root.id)}`, { method: 'PATCH', body: JSON.stringify({ revoked_at: new Date().toISOString(), status: { state: 'offline', whatsapp: 'disconnected' } }) });
        await rest(`workspace_pairings?root_id=eq.${encode(root.id)}`, { method: 'DELETE' });
        return { revoked: true };
    }
    default:
        throw failure('Неизвестное действие.');
    }
}

async function accountForDevice(device) {
    const root = first(await rest(`personal_agents?select=id,account_id,telegram_owner_chat_id&id=eq.${encode(device.root_id)}&limit=1`));
    if (!root) throw failure('Подключение отозвано.', 401);
    const account = first(await rest(`managers_auth?select=id,login,role,disabled_at&id=eq.${encode(root.account_id)}&limit=1`));
    const legacyOwner = ['admin', 'shaikh'].includes(String(account?.login || '').toLowerCase());
    if (!account || account.disabled_at || (!legacyOwner && !['owner', 'client'].includes(account.role))) throw failure('Подключение отозвано.', 401);
    return root;
}

export async function authenticateWorkspaceDevice(req) {
    const header = String(req.headers?.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!TOKEN.test(token)) throw failure('Нужен токен локального устройства.', 401);
    const device = first(await rest(`workspace_devices?select=*&token_hash=eq.${hash(token)}&revoked_at=is.null&limit=1`));
    if (!device) throw failure('Подключение отозвано.', 401);
    const root = await accountForDevice(device);
    return { device, root };
}

export async function pairWorkspaceDevice(body) {
    if (!TOKEN.test(String(body.code || ''))) throw failure('Код подключения недействителен.', 401);
    const publicKey = validateWorkspacePublicKey(body.publicKey);
    const name = clean(body.name, 80) || 'Мой MacBook';
    const token = randomBytes(32).toString('base64url');
    const device = first(await rpc('workspace_pair_device', {
        p_code_hash: hash(body.code), p_token_hash: hash(token), p_public_key: publicKey, p_name: name
    }));
    if (!device) throw failure('Код истёк или уже использован. Создайте новый в кабинете.', 401);
    // A previously issued pairing code cannot revive a disabled account.
    try { await accountForDevice(device); }
    catch (error) {
        await rest(`workspace_devices?id=eq.${encode(device.id)}`, { method: 'PATCH', body: JSON.stringify({ revoked_at: new Date().toISOString() }) });
        throw error;
    }
    return { token, deviceId: device.id };
}

function safeRuntime(body, { partial = false } = {}) {
    const input = body.status && typeof body.status === 'object' && !Array.isArray(body.status) ? body.status : {};
    const states = ['ready', 'processing', 'error', 'offline', 'model_offline'];
    const whatsappStates = ['disconnected', 'qr', 'connected', 'paused'];
    const status = {};
    if (states.includes(input.state)) status.state = input.state;
    else if (!partial) status.state = input.modelReady === true ? 'ready' : 'model_offline';
    if (whatsappStates.includes(input.whatsapp)) status.whatsapp = input.whatsapp;
    else if (!partial) status.whatsapp = 'disconnected';
    for (const field of ['modelReady', 'telegramDialogue', 'telegramVoice']) {
        if (typeof input[field] === 'boolean') status[field] = input[field];
        else if (!partial) status[field] = false;
    }
    if (status.state === 'model_offline') status.modelReady = false;
    if (status.telegramDialogue === false || !partial && status.telegramDialogue !== true) status.telegramVoice = false;
    const rawModel = body.model ?? input.model;
    const model = typeof rawModel === 'string' && !rawModel.includes('://') && /^[A-Za-z0-9_./:@+-]{0,100}$/.test(rawModel) ? rawModel : partial ? null : '';
    return { status, model, last_seen_at: new Date().toISOString() };
}

function safeReminders(input) {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > 50) throw failure('Слишком много напоминаний.');
    return input.map(reminder => {
        if (!reminder || Object.keys(reminder).some(key => !['id', 'due_at'].includes(key))) throw failure('Напоминание может содержать только время и идентификатор.');
        const due = new Date(reminder.due_at);
        if (!Number.isFinite(due.getTime()) || due.getTime() < Date.now() - 24 * 60 * 60_000
            || due.getTime() > Date.now() + 5 * 366 * 24 * 60 * 60_000) throw failure('Проверьте дату напоминания.');
        return { id: reminder.id ? requireUuid(reminder.id) : randomUUID(), due_at: due.toISOString() };
    });
}

async function notifyJob(root, device, body) {
    const kind = body.kind;
    if (!['clarification', 'processed'].includes(kind)) throw failure('Неизвестное уведомление.');
    const jobId = requireUuid(body.jobId);
    if (!root.telegram_owner_chat_id) return { notified: false };
    const token = await personalTelegramToken(root);
    if (!token) return { notified: false };
    const claimed = first(await rest(`workspace_jobs?id=eq.${encode(jobId)}&device_id=eq.${encode(device.id)}&root_id=eq.${encode(root.id)}&notified_at=is.null`, {
        method: 'PATCH', headers: writeHeaders, body: JSON.stringify({ notified_at: new Date().toISOString() })
    }));
    if (!claimed) return { notified: false };
    const text = kind === 'clarification'
        ? `Для задачи нужно уточнить дату и время. Ответьте сообщением:\n/when ${jobId} дата и время\nСодержание задачи доступно только на вашем Mac.`
        : 'Мысль обработана на вашем Mac. Заметка и связи доступны в Obsidian.';
    await telegram('sendMessage', token, { chat_id: root.telegram_owner_chat_id, text });
    return { notified: true };
}

export async function workspaceDeviceMutation(context, body) {
    const { device, root } = context;
    switch (body.action) {
    case 'telegram_credentials': {
        if (!device || device.root_id !== root.id || device.revoked_at) throw failure('Подключение Mac отозвано.', 401);
        const currentDevice = await workspaceDevice(root.id);
        if (!currentDevice || currentDevice.id !== device.id) throw failure('Подключение Mac отозвано.', 401);
        if (currentDevice.status?.telegramDialogue !== true) throw failure('Диалог Telegram не включён на этом Mac. Обновите локальный агент и включите диалог в его настройках.', 409);
        const current = first(await rest(`personal_agents?select=id,telegram_connected,telegram_owner_chat_id,telegram_owner_user_id&id=eq.${encode(root.id)}&telegram_connected=eq.true&limit=1`));
        if (!current?.telegram_connected || !current.telegram_owner_chat_id || !current.telegram_owner_user_id) {
            throw failure('Сначала привяжите личный Telegram к этому кабинету.', 409);
        }
        const personal = first(await rest(`workspace_agents?select=id&root_id=eq.${encode(root.id)}&type=eq.personal&enabled=eq.true&limit=1`));
        if (!personal) throw failure('Личный агент выключен.', 409);
        if (body.jobId !== undefined) {
            const job = first(await rest(`workspace_jobs?select=id&id=eq.${encode(requireUuid(body.jobId))}&root_id=eq.${encode(root.id)}&device_id=eq.${encode(device.id)}&kind=eq.telegram_thought&limit=1`));
            if (!job) throw failure('Сообщение Telegram не найдено для этого Mac.', 404);
        }
        const token = await personalTelegramToken(current);
        if (!token) throw failure('Подключите Telegram-бота заново.', 409);
        return { telegramEnvelope: await encryptEnvelope(currentDevice.public_key, {
            token, chatId: String(current.telegram_owner_chat_id), ownerUserId: String(current.telegram_owner_user_id),
            conversationKey: telegramConversationKey(current, currentDevice)
        }) };
    }
    case 'runtime': {
        const patch = safeRuntime(body, { partial: true });
        const applied = await rpc('workspace_patch_runtime', {
            p_device_id: device.id, p_root_id: root.id, p_status: patch.status, p_model: patch.model
        });
        if (!applied) throw failure('Подключение Mac отозвано.', 401);
        return { ok: true };
    }
    case 'poll': {
        await rest(`workspace_devices?id=eq.${encode(device.id)}&revoked_at=is.null`, { method: 'PATCH', body: JSON.stringify(safeRuntime(body)) });
        const [jobs, agents, decisions] = await Promise.all([
            rpc('workspace_claim_jobs', { p_device_id: device.id, p_root_id: root.id }), listAgents(root.id),
            body.status?.whatsapp === 'connected' ? rpc('workspace_claim_decisions', { p_device_id: device.id, p_root_id: root.id }) : Promise.resolve([])
        ]);
        return { jobs: (jobs || []).map(job => ({ id: job.id, kind: job.kind, envelope: job.envelope, lease_token: job.lease_token, created_at: job.created_at })), agents: agents.map(publicAgent), decisions: decisions || [], settings: WORKSPACE_SETTINGS };
    }
    case 'complete': {
        const status = body.status === 'failed' ? 'failed' : 'complete';
        const result = body.resultEnvelope ? validateWorkspaceEnvelope(body.resultEnvelope) : null;
        const errorCode = status === 'failed' ? (body.errorCode === 'model_unavailable' ? 'model_unavailable' : 'local_error') : null;
        const applied = await rpc('workspace_complete_job', {
            p_device_id: device.id, p_root_id: root.id, p_job_id: requireUuid(body.jobId),
            p_lease_token: requireUuid(body.leaseToken), p_result: result,
            p_status: status, p_error_code: errorCode, p_reminders: safeReminders(body.reminders)
        });
        if (!applied) throw failure('Задание уже обработано или получено другим запуском Mac.', 409);
        return { ok: true };
    }
    case 'sync_reminders': {
        const jobId = requireUuid(body.jobId);
        const job = first(await rest(`workspace_jobs?select=id&id=eq.${encode(jobId)}&root_id=eq.${encode(root.id)}&device_id=eq.${encode(device.id)}&status=eq.complete&limit=1`));
        if (!job) throw failure('Завершённое задание не найдено.', 404);
        if (body.resultEnvelope !== undefined) await rest(`workspace_jobs?id=eq.${encode(jobId)}&root_id=eq.${encode(root.id)}&device_id=eq.${encode(device.id)}&status=eq.complete`, {
            method: 'PATCH', body: JSON.stringify({ result_envelope: validateWorkspaceEnvelope(body.resultEnvelope), updated_at: new Date().toISOString() })
        });
        const reminders = safeReminders(body.reminders);
        if (reminders.length) await rest('workspace_reminders?on_conflict=id', {
            method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' },
            body: JSON.stringify(reminders.map(reminder => ({ ...reminder, root_id: root.id, job_id: jobId })))
        });
        return { ok: true };
    }
    case 'notify':
        return notifyJob(root, device, body);
    case 'generate_whatsapp': {
        const agentId = requireUuid(body.agentId);
        const agent = first(await rest(`workspace_agents?select=*&id=eq.${encode(agentId)}&root_id=eq.${encode(root.id)}&type=eq.whatsapp&enabled=eq.true&limit=1`));
        if (!agent) throw failure('Рабочий агент выключен или не найден.', 409);
        return generateWorkspaceWhatsApp(root.id, agent, body.text, fetch, body.history);
    }
    case 'whatsapp_context': {
        const agentId = requireUuid(body.agentId);
        const recipient = clean(body.recipient, 100);
        if (!personalWhatsAppJid(recipient)) throw failure('Доступны только личные чаты.');
        const agent = first(await rest(`workspace_agents?select=id&id=eq.${encode(agentId)}&root_id=eq.${encode(root.id)}&type=eq.whatsapp&enabled=eq.true&limit=1`));
        if (!agent) throw failure('Рабочий агент выключен или не найден.', 409);
        const pending = first(await rest(`workspace_approvals?select=reason,external_id,expires_at&root_id=eq.${encode(root.id)}&device_id=eq.${encode(device.id)}&agent_id=eq.${encode(agentId)}&recipient=eq.${encode(recipient)}&status=in.(pending,approved,dispatching)&expires_at=gt.${encode(new Date().toISOString())}&order=created_at.desc&limit=1`));
        return pending ? { pending: true, reason: pending.reason, externalId: pending.external_id, expiresAt: pending.expires_at } : { pending: false };
    }
    case 'approval': {
        const agentId = requireUuid(body.agentId);
        const agent = first(await rest(`workspace_agents?select=id&id=eq.${encode(agentId)}&root_id=eq.${encode(root.id)}&type=eq.whatsapp&enabled=eq.true&limit=1`));
        if (!agent) throw failure('Рабочий агент выключен или не найден.', 409);
        const recipient = clean(body.recipient, 100);
        const original = clean(body.original, 8000);
        const draft = clean(body.draft, 4000);
        const reason = clean(body.reason, 200);
        const externalId = clean(body.externalId || body.external_id || body.externalMessageId || body.requestId, 128);
        if (!/^[0-9]{5,30}@(s\.whatsapp\.net|lid)$/.test(recipient) || !reason
            || !/^[A-Za-z0-9_.:-]{1,128}$/.test(externalId)) throw failure('Не удалось проверить ответ для согласования.');
        const rows = await rest('workspace_approvals?on_conflict=device_id,external_id', {
            method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
            body: JSON.stringify({ root_id: root.id, device_id: device.id, agent_id: agentId, recipient, original, draft, reason, external_id: externalId })
        });
        const approval = first(rows) || first(await rest(`workspace_approvals?select=id,status&device_id=eq.${encode(device.id)}&external_id=eq.${encode(externalId)}&limit=1`));
        return { approval: { id: approval.id, status: approval.status } };
    }
    case 'delivered': {
        if (!['sent', 'failed', 'uncertain'].includes(body.status)) throw failure('Некорректный результат отправки.');
        const updated = first(await rest(`workspace_approvals?id=eq.${encode(requireUuid(body.approvalId))}&root_id=eq.${encode(root.id)}&device_id=eq.${encode(device.id)}&status=eq.dispatching`, {
            method: 'PATCH', headers: writeHeaders,
            body: JSON.stringify({ status: body.status, delivered_at: new Date().toISOString() })
        }));
        return { ok: Boolean(updated) };
    }
    default:
        throw failure('Неизвестное действие устройства.');
    }
}

function telegramVoiceInput(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.file_id !== 'string' || typeof value.file_unique_id !== 'string'
        || !/^[A-Za-z0-9_-]{1,512}$/.test(value.file_id || '')
        || !/^[A-Za-z0-9_-]{1,128}$/.test(value.file_unique_id || '')
        || !Number.isSafeInteger(value.duration) || value.duration < 1 || value.duration > 600) {
        throw failure('Не удалось проверить голосовое сообщение. Отправьте новое голосовое длительностью до 10 минут.');
    }
    if (value.file_size !== undefined && value.file_size !== null
        && (!Number.isSafeInteger(value.file_size) || value.file_size < 1 || value.file_size > 19 * 1024 * 1024)) {
        throw failure('Голосовое должно занимать не больше 19 МБ. Отправьте более короткую запись.');
    }
    const mimeType = value.mime_type === undefined || value.mime_type === null ? null : String(value.mime_type).toLowerCase();
    if (mimeType !== null && !/^(?:audio\/[a-z0-9.+-]{1,60}|application\/ogg)$/.test(mimeType)) {
        throw failure('Не удалось проверить формат голосового сообщения. Отправьте его как голосовое в Telegram.');
    }
    return {
        fileId: value.file_id, uniqueId: value.file_unique_id, duration: value.duration,
        size: value.file_size ?? null, mimeType,
    };
}

export async function enqueueTelegramThought(root, text, options = {}) {
    const device = await workspaceDevice(root.id);
    if (!device) return { queued: false, reason: 'missing-device' };
    const raw = String(text || '').trim();
    const voice = options.voice === undefined ? null : telegramVoiceInput(options.voice);
    if ((!raw && !voice) || raw.length > 20000) throw failure('Сообщение должно содержать от 1 до 20 000 символов.');
    const messageId = Number(options.telegramMessageId ?? options.externalMessageId);
    if (!Number.isSafeInteger(messageId) || messageId < 1) throw failure('Не удалось проверить идентификатор сообщения Telegram.');
    const conversationKey = telegramConversationKey(root, device);
    const dialogueEnabled = device.status?.telegramDialogue === true;
    const clarification = raw.match(/^\/when(?:@\w+)?\s+([a-f0-9-]{36})\s+([\s\S]+)$/i);
    const command = raw.match(/^\/(ask|note|new|when)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
    let payload = { intent: dialogueEnabled ? 'dialogue' : 'thought', text: raw, source: 'telegram', telegramMessageId: messageId, conversationKey };
    if (voice) {
        if (!dialogueEnabled || device.status?.telegramVoice !== true) throw failure('Распознавание голосовых пока не включено на вашем Mac. Настройте локальное распознавание или отправьте сообщение текстом.', 409);
        payload = { ...payload, intent: 'dialogue', text: '', voice };
    } else if (clarification) {
        const relatedJobId = requireUuid(clarification[1]);
        const related = first(await rest(`workspace_jobs?select=id&id=eq.${encode(relatedJobId)}&root_id=eq.${encode(root.id)}&device_id=eq.${encode(device.id)}&limit=1`));
        if (!related) throw failure('Задача для уточнения не найдена.', 404);
        payload = { ...payload, intent: 'clarify', relatedJobId, text: clarification[2] };
    } else if (command) {
        const name = command[1].toLowerCase();
        const content = String(command[2] || '').trim();
        if (!dialogueEnabled && ['ask', 'new'].includes(name)) throw failure('Диалог Telegram не включён на этом Mac. Обновите локальный агент и включите диалог в его настройках.', 409);
        if (name === 'new') {
            if (content) throw failure('Чтобы начать новый диалог, отправьте /new без дополнительного текста.');
            payload = { ...payload, text: '', mode: 'reset' };
        } else if (name === 'when') {
            throw failure('Укажите задачу и срок: /when идентификатор дата и время.');
        } else {
            if (!content) throw failure(name === 'ask' ? 'Добавьте вопрос после /ask.' : 'Добавьте мысль после /note.');
            payload = { ...payload, text: content, ...(name === 'ask' ? { mode: 'ask' } : { intent: 'thought' }) };
        }
    }
    const envelope = await encryptEnvelope(device.public_key, payload);
    const external = `tg_${hash(`${conversationKey}:${root.telegram_bot_id || ''}:${messageId}`)}`;
    const result = await insertJob(root, device, { kind: 'telegram_thought', request_id: external, envelope });
    return { queued: true, jobId: result.job.id, intent: payload.intent, dialogueEnabled, ...(voice ? { voice: true } : {}), ...(payload.mode ? { mode: payload.mode } : {}) };
}

export function isWorkspaceQuietTime(now = new Date()) {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: WORKSPACE_SETTINGS.timezone, hour: '2-digit', hourCycle: 'h23' }).format(now));
    return hour >= WORKSPACE_SETTINGS.quietStart || hour < WORKSPACE_SETTINGS.quietEnd;
}

export async function deliverWorkspaceReminders({ now = new Date() } = {}) {
    if (isWorkspaceQuietTime(now)) return { sent: 0, deferred: true };
    const reminders = await rest(`workspace_reminders?select=id,root_id&status=eq.pending&due_at=lte.${encode(now.toISOString())}&order=due_at.asc&limit=100`);
    let sent = 0;
    let failed = 0;
    for (const reminder of reminders || []) {
        const root = first(await rest(`personal_agents?select=id,account_id,telegram_owner_chat_id&id=eq.${encode(reminder.root_id)}&limit=1`));
        if (!root?.telegram_owner_chat_id) continue;
        const account = first(await rest(`managers_auth?select=id,role,login,disabled_at&id=eq.${encode(root.account_id)}&limit=1`));
        if (!account || account.disabled_at || (!['owner', 'client'].includes(account.role) && !['admin', 'shaikh'].includes(String(account.login).toLowerCase()))) continue;
        const token = await personalTelegramToken(root);
        if (!token) continue;
        const claimed = first(await rest(`workspace_reminders?id=eq.${encode(reminder.id)}&status=eq.pending`, {
            method: 'PATCH', headers: writeHeaders, body: JSON.stringify({ status: 'dispatching' })
        }));
        if (!claimed) continue;
        try {
            await telegram('sendMessage', token, {
                chat_id: root.telegram_owner_chat_id,
                text: 'Напоминание: у вас есть запланированная задача. Подробности доступны на вашем Mac и в личном кабинете.',
                reply_markup: { inline_keyboard: [[{ text: 'Открыть кабинет', url: 'https://shaikh.digital/workspace' }]] }
            });
            await rest(`workspace_reminders?id=eq.${encode(reminder.id)}&status=eq.dispatching`, {
                method: 'PATCH', body: JSON.stringify({ status: 'sent', sent_at: now.toISOString() })
            });
            sent += 1;
        } catch {
            await rest(`workspace_reminders?id=eq.${encode(reminder.id)}&status=eq.dispatching`, { method: 'PATCH', body: JSON.stringify({ status: 'failed' }) });
            failed += 1;
        }
    }
    const digests = await deliverWorkspaceDigests(now);
    return { sent, failed, digests };
}

async function deliverWorkspaceDigests(now) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: WORKSPACE_SETTINGS.timezone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    // Almaty observes UTC+05:00. Date comparison remains a neutral schedule value.
    const start = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00+05:00`).toISOString();
    const criterion = encode(`(last_digest_at.is.null,last_digest_at.lt.${start})`);
    const devices = await rest(`workspace_devices?select=id,root_id&revoked_at=is.null&or=${criterion}&limit=100`);
    let sent = 0;
    for (const device of devices || []) {
        let root;
        try { root = await accountForDevice(device); } catch { continue; }
        if (!root.telegram_owner_chat_id) continue;
        const token = await personalTelegramToken(root);
        if (!token) continue;
        const claimed = first(await rest(`workspace_devices?id=eq.${encode(device.id)}&revoked_at=is.null&or=${criterion}`, {
            method: 'PATCH', headers: writeHeaders, body: JSON.stringify({ last_digest_at: now.toISOString() })
        }));
        if (!claimed) continue;
        try {
            await telegram('sendMessage', token, {
                chat_id: root.telegram_owner_chat_id,
                text: 'Время ежедневного обзора: проверьте задачи, мысли и напоминания. Содержание вашей базы остаётся на Mac.',
                reply_markup: { inline_keyboard: [[{ text: 'Открыть кабинет', url: 'https://shaikh.digital/workspace' }]] }
            });
            sent += 1;
        } catch {
            // An ambiguous Telegram failure is not retried automatically, avoiding duplicate daily messages.
        }
    }
    return sent;
}
