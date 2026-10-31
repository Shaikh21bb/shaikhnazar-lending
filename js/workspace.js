import { generateEnvelopeKeyPair, encryptEnvelope, decryptEnvelope } from '../lib/private-envelope.mjs';

const API = '/api/hub/workspace';
const REPLY_KEY_STORAGE = 'shaikh-private-reply-key-v1';
const SELF_CHECK_STORAGE = 'shaikh-whatsapp-self-check-v1';
const VIEWS = new Set(['thoughts', 'reminders', 'agents', 'chats', 'mac']);
const POLL_MS = 6000;
const state = { data: null, keys: null, decrypted: new Map(), approvalDrafts: new Map(), approvalActions: new Set(), approvalDecisions: new Map(), approvalOffset: 0, historyVisible: 20, historyFingerprint: '', pendingThought: null, view: 'thoughts', loading: false, sending: false, clarification: null, pairing: null, qrJobId: null, qrAgentId: null, qrFingerprint: '', selfCheck: null, selfCheckBusy: false, selfCheckFingerprint: '', user: null };
const $ = id => document.getElementById(id);
let toastTimer;
let pollingTimer;
let previousDialogFocus;
let inboxController;

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function safeDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function formatDate(value, options = {}) {
    const date = safeDate(value);
    return date ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty', day: 'numeric', month: 'short', ...options }).format(date) : '—';
}

function formatTime(value) {
    return formatDate(value, { day: undefined, month: undefined, hour: '2-digit', minute: '2-digit' });
}

function deviceIsOnline() {
    const device = state.data?.device;
    const seen = safeDate(device?.last_seen_at);
    const runtimeState = typeof device?.status === 'object' ? device.status?.state : device?.status;
    return Boolean(device && seen && Date.now() - seen.getTime() < 90000 && !['offline', 'stopped', 'disconnected', 'revoked'].includes(runtimeState));
}

function toast(message) {
    clearTimeout(toastTimer);
    $('workspace-toast').textContent = message;
    $('workspace-toast').hidden = false;
    toastTimer = setTimeout(() => { $('workspace-toast').hidden = true; }, 5500);
}

function showError(error) {
    $('workspace-alert').textContent = error?.message || 'Не удалось загрузить данные. Попробуйте обновить страницу.';
    $('workspace-alert').hidden = false;
}

async function api(body) {
    const url = !body && state.approvalOffset ? `${API}?approvalOffset=${state.approvalOffset}` : API;
    const response = await fetch(url, {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
        inboxController?.destroy();
        location.assign('/login.html?next=workspace.html');
        throw new Error('Войдите в аккаунт, чтобы продолжить.');
    }
    if (!response.ok) throw new Error(data.error || (response.status === 403 ? 'Для этого пространства нужен доступ владельца.' : 'Сервер временно недоступен. Попробуйте ещё раз.'));
    return data;
}

async function replyKeys() {
    if (state.keys) return state.keys;
    try {
        const saved = JSON.parse(sessionStorage.getItem(REPLY_KEY_STORAGE) || 'null');
        if (saved?.publicKey?.kty === 'RSA' && saved?.privateKey?.d) state.keys = saved;
    } catch { /* Storage may be disabled. Keys then live only in this tab. */ }
    if (!state.keys) {
        state.keys = await generateEnvelopeKeyPair();
        try { sessionStorage.setItem(REPLY_KEY_STORAGE, JSON.stringify(state.keys)); } catch { /* In-memory keys still protect this session. */ }
    }
    return state.keys;
}

function devicePublicKey() {
    const key = state.data?.device?.public_key;
    if (typeof key === 'string') {
        try { return JSON.parse(key); } catch { return null; }
    }
    return key || null;
}

async function enqueueEncrypted(kind, payload, { retry = false } = {}) {
    const publicKey = devicePublicKey();
    if (!publicKey) throw new Error('Сначала привяжите Mac. Только он сможет расшифровать ваши мысли.');
    const payloadKey = `${kind}:${JSON.stringify(payload)}`;
    if (retry && state.pendingThought?.key === payloadKey) {
        const result = await api(state.pendingThought.request);
        state.pendingThought = null;
        return result;
    }
    const keys = await replyKeys();
    const requestId = crypto.randomUUID();
    const envelope = await encryptEnvelope(publicKey, { ...payload, replyPublicKey: keys.publicKey, requestId });
    const request = { action: 'enqueue', kind, envelope, request_id: requestId };
    if (retry) state.pendingThought = { key: payloadKey, request };
    const result = await api(request);
    if (retry) state.pendingThought = null;
    return result;
}

function selfCheckAccount() {
    return state.user?.sub || state.user?.id || state.user?.login || '';
}

function persistSelfCheck() {
    if (!state.selfCheck || !selfCheckAccount()) return;
    try { sessionStorage.setItem(SELF_CHECK_STORAGE, JSON.stringify({ ...state.selfCheck, account: selfCheckAccount() })); }
    catch { /* The current tab still retains the same encrypted request for retry. */ }
}

function restoreSelfCheck() {
    try {
        const saved = JSON.parse(sessionStorage.getItem(SELF_CHECK_STORAGE) || 'null');
        if (!saved || saved.account !== selfCheckAccount() || typeof saved.agentId !== 'string') return;
        const jobId = typeof saved.jobId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(saved.jobId) ? saved.jobId : null;
        const request = saved.request;
        const retryable = request?.action === 'enqueue' && request.kind === 'whatsapp_connect'
            && /^[A-Za-z0-9_-]{16,128}$/.test(request.request_id || '')
            && request.envelope?.v === 1 && typeof request.envelope.ciphertext === 'string';
        if (jobId || retryable) state.selfCheck = { agentId: saved.agentId, jobId, request: jobId ? null : request };
    } catch { /* Ignore damaged or unavailable browser storage. */ }
}

function currentSelfCheckResult() {
    return state.selfCheck?.jobId ? state.decrypted.get(state.selfCheck.jobId)?.result?.selfCheck : null;
}

function currentSelfCheckApproval() {
    const id = currentSelfCheckResult()?.approvalId;
    if (typeof id !== 'string') return null;
    const remote = (state.data?.approvalHistory || []).find(item => item.id === id)
        || (state.data?.approvals || []).find(item => item.id === id);
    const current = remote && !['pending', 'awaiting_approval'].includes(remote.status)
        ? remote : state.approvalDecisions.get(id) || remote;
    if (!current) return null;
    const expired = ['pending', 'awaiting_approval', 'approved'].includes(current.status)
        && safeDate(current.expires_at)?.getTime() <= Date.now();
    return expired ? { ...current, status: 'expired' } : current;
}

async function startSelfCheck(agentId) {
    if (state.selfCheckBusy || state.selfCheck?.jobId) return;
    const agent = (state.data?.agents || []).find(item => item.id === agentId);
    if (!agent || !whatsAppAgentStatus(agent).connected) { toast('Для самопроверки подключите включённого WhatsApp-агента на Mac.'); return; }
    if (state.selfCheck && state.selfCheck.agentId !== agentId) { toast('Сначала завершите уже созданную самопроверку.'); return; }
    state.selfCheckBusy = true;
    state.selfCheck ||= { agentId, jobId: null, request: null };
    state.selfCheck.error = '';
    renderAgents(); renderSelfCheck();
    $('self-check-panel').scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    $('self-check-title').focus({ preventScroll: true });
    try {
        if (!state.selfCheck.request) {
            const publicKey = devicePublicKey();
            if (!publicKey) throw new Error('Сначала привяжите Mac в разделе «Мой Mac».');
            const keys = await replyKeys();
            const requestId = crypto.randomUUID();
            const envelope = await encryptEnvelope(publicKey, { intent: 'whatsapp_self_check', agentId,
                replyPublicKey: keys.publicKey, requestId });
            state.selfCheck.request = { action: 'enqueue', kind: 'whatsapp_connect', envelope, request_id: requestId };
            persistSelfCheck();
        }
        const response = await api(state.selfCheck.request);
        const id = response.job?.id || response.id;
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Номер проверки пока не получен. Повторите тот же запрос ниже.');
        state.selfCheck.jobId = id;
        state.selfCheck.request = null;
        persistSelfCheck();
        toast('Самопроверка поставлена в очередь Mac. Тестовые сообщения предназначены только вашему собственному чату.');
        await refresh();
    } catch (error) { state.selfCheck.error = error?.message || 'Не удалось передать запрос самопроверки.'; }
    finally { state.selfCheckBusy = false; renderAgents(); renderSelfCheck(); }
}

function renderSelfCheck() {
    if (!state.selfCheck) {
        const known = (state.data?.jobs || []).find(job => state.decrypted.get(job.id)?.result?.selfCheck);
        if (known) {
            const result = state.decrypted.get(known.id).result.selfCheck;
            state.selfCheck = { agentId: result.agentId || enabledWhatsAppAgents()[0]?.id || '', jobId: known.id, request: null };
            persistSelfCheck();
        }
    }
    const check = state.selfCheck;
    $('self-check-panel').hidden = !check;
    if (!check) return;
    const job = (state.data?.jobs || []).find(item => item.id === check.jobId);
    const result = currentSelfCheckResult();
    const review = currentSelfCheckApproval();
    let status = state.selfCheckBusy ? 'Передаю защищённый запрос вашему Mac…'
        : check.request ? 'Запрос пока не подтверждён сервером. Можно повторить тот же запрос без создания новой проверки.'
            : ['failed', 'error'].includes(job?.status) ? 'Mac не завершил самопроверку. Проверьте подключение и сам чат WhatsApp.'
                : ['complete', 'completed', 'done', 'succeeded'].includes(job?.status) && !result ? 'Проверка завершена на Mac. Зашифрованный результат недоступен в этом сеансе; проверьте тестовое согласование и свой чат.'
                    : !job && check.jobId ? 'Ожидаю статус созданной проверки. Если она была выполнена раньше, проверьте историю согласований и свой чат.'
                        : deviceIsOnline() ? 'Mac выполняет самопроверку: готовит AI-ответ и тестовое согласование.' : 'Проверка ждёт подключения Mac.';
    if (result) status = result.ordinaryStatus === 'sent' && (result.approvalSaved === true || review)
        ? 'Исходящий AI-ответ принят WhatsApp. Текущее состояние тестового вопроса показано ниже.'
        : 'Самопроверка требует внимания. Ниже — подтверждённые результаты каждого шага.';
    if (check.error) status = check.error;
    if ($('self-check-status').textContent !== status) $('self-check-status').textContent = status;
    const ordinary = result?.ordinaryStatus === 'sent' ? 'Принят WhatsApp. Доставка на телефон ещё не подтверждена.'
        : result?.ordinaryStatus === 'uncertain' ? 'Исход отправки неизвестен. Проверьте свой чат перед дальнейшими действиями.'
            : result?.ordinaryStatus === 'blocked' ? 'Автоматический ответ не отправлен: требуется проверка.' : 'Ожидает выполнения на Mac.';
    const reviewStates = {
        pending: 'На согласовании: требуется ваше решение.',
        awaiting_approval: 'На согласовании: требуется ваше решение.',
        approved: deviceIsOnline() ? 'Ответ согласован. Ожидает отправки на Mac.' : 'Ответ согласован и ждёт подключения Mac.',
        dispatching: 'Mac отправляет согласованный ответ. Дождитесь результата.',
        sent: 'Согласованный ответ принят WhatsApp. Доставка на телефон не подтверждена.',
        failed: 'Отправка не завершилась. Проверьте свой чат WhatsApp.',
        uncertain: 'Исход отправки неизвестен. Проверьте чат перед дальнейшими действиями.',
        rejected: 'Вы отклонили тестовый ответ. Он не будет отправлен.',
        expired: 'Срок тестового согласования истёк. Ответ не будет отправлен.'
    };
    const approval = review ? reviewStates[review.status] || 'Текущий статус тестового согласования уточняется. Проверьте историю.'
        : result?.approvalSaved === true ? 'Тестовое согласование создано. Текущий статус проверьте в очереди или истории.' : 'Ожидает сохранения на согласование.';
    const answer = typeof result?.ordinaryAnswer === 'string' ? result.ordinaryAnswer.slice(0, 2500) : '';
    const html = `<dl class="ws-self-check-facts"><div><dt>Обычный AI-ответ</dt><dd>${escapeHtml(ordinary)}</dd></div><div><dt>Важный вопрос</dt><dd>${escapeHtml(approval)}</dd></div><div><dt>Входящие от другого человека</dt><dd>Ещё не проверено.</dd></div><div><dt>Доставка на телефон</dt><dd>Ожидает вашей проверки в собственном чате WhatsApp.</dd></div></dl>${answer ? `<details><summary>Тестовый ответ AI</summary><blockquote>${escapeHtml(answer)}</blockquote></details>` : ''}`;
    if (html !== state.selfCheckFingerprint) { $('self-check-result').innerHTML = html; state.selfCheckFingerprint = html; }
    $('self-check-retry').hidden = !check.request || state.selfCheckBusy;
    $('self-check-approval').hidden = !(result?.approvalSaved || review) || typeof result?.approvalId !== 'string';
    $('self-check-approval').textContent = review && ['pending', 'awaiting_approval'].includes(review.status)
        ? 'Открыть тестовое согласование' : review ? 'Открыть результат согласования' : 'Найти тестовое согласование';
}

function focusSelfCheckApproval() {
    const id = currentSelfCheckResult()?.approvalId;
    if (typeof id !== 'string') return;
    const review = currentSelfCheckApproval();
    const input = review && ['pending', 'awaiting_approval'].includes(review.status) ? $(`approval-${id}`) : null;
    const details = [...document.querySelectorAll('[data-history-details]')].find(item => item.dataset.historyDetails === id);
    const target = input?.closest('[data-approval]') || details || $('approval-section');
    if (details) details.open = true;
    target?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    if (input) input.focus({ preventScroll: true });
    else if (details) details.querySelector('summary')?.focus({ preventScroll: true });
    else { $('approval-title').focus({ preventScroll: true }); toast('Найдите тестовый вопрос «Самопроверка SHAIKH» среди согласований или в истории отправки.'); }
}

function showView(view, updateHash = true) {
    if (!VIEWS.has(view)) view = 'thoughts';
    state.view = view;
    inboxController?.setActive(view === 'chats');
    document.querySelectorAll('.ws-view').forEach(section => { section.hidden = section.id !== `view-${view}`; });
    document.querySelectorAll('[data-view]').forEach(link => {
        const active = link.dataset.view === view;
        link.classList.toggle('is-active', active);
        if (link.matches('a')) {
            if (active) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        }
    });
    if (updateHash && location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    window.scrollTo({ top: 0, behavior: 'instant' });
}

function empty(icon, title, description) {
    return `<div class="ws-empty"><span aria-hidden="true">${escapeHtml(icon)}</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p></div>`;
}

function renderDevice() {
    const device = state.data?.device;
    const online = deviceIsOnline();
    const paired = Boolean(devicePublicKey());
    $('island-status').textContent = online ? 'Mac на связи' : paired ? 'Mac не в сети' : 'Подключить Mac';
    $('island-device').querySelector('.ws-dot').classList.toggle('is-online', online);
    $('thought-input').disabled = !paired || state.sending;
    $('thought-submit').disabled = !paired || state.sending;
    const notice = $('thought-device-notice');
    notice.querySelector('.ws-dot').classList.toggle('is-online', online);
    notice.querySelector('p').textContent = online
        ? 'Mac на связи. Мысль отправится в вашу локальную базу.'
        : paired ? 'Mac сейчас не в сети. Мысли ждут его в зашифрованной очереди.'
            : 'Подключите Mac, чтобы сохранить первую мысль в Obsidian.';
    notice.querySelector('button').hidden = online;
    $('device-name').textContent = device?.name || 'Mac ещё не подключён';
    $('device-detail').textContent = online
        ? 'Помощник на связи и принимает зашифрованные задания. База Obsidian остаётся на этом Mac.'
        : paired ? 'Помощник не присылает сигнал. Запустите его на Mac и оставьте компьютер включённым без сна.'
            : 'Привяжите этот компьютер, чтобы мысли попадали в вашу базу Obsidian.';
    $('device-state').textContent = online ? 'На связи' : paired ? 'Ожидает Mac' : 'Не подключён';
    $('device-state').classList.toggle('is-online', online);
    const model = device?.model || device?.status?.model || '';
    $('device-model').textContent = model ? `${model}${device?.status?.modelReady === false ? ' · ожидает запуска' : ''}` : 'Не запущена';
    if (online && device?.status?.modelReady === false) {
        $('device-detail').textContent = 'Mac на связи, локальная AI-модель ещё не запущена. Мысли сохраняются в Obsidian для последующего анализа.';
    }
    $('device-seen').textContent = device?.last_seen_at ? formatDate(device.last_seen_at, { hour: '2-digit', minute: '2-digit' }) : '—';
    $('pairing-button').textContent = paired ? 'Привязать Mac заново' : 'Подключить мой Mac';
}

function jobStatus(job) {
    if (['completed', 'complete', 'done', 'succeeded'].includes(job.status)) return 'Готово';
    if (['failed', 'error'].includes(job.status)) return 'Нужна проверка';
    if (['processing', 'claimed', 'running'].includes(job.status)) return 'Mac обрабатывает';
    return deviceIsOnline() ? 'В очереди' : 'Ждёт подключения Mac';
}

async function decryptResults() {
    let keys = state.keys;
    if (!keys) {
        try { keys = JSON.parse(sessionStorage.getItem(REPLY_KEY_STORAGE) || 'null'); } catch { keys = null; }
    }
    if (!keys?.privateKey) return;
    state.keys = keys;
    await Promise.all((state.data?.jobs || []).map(async job => {
        const envelope = job.result_envelope || job.resultEnvelope;
        if (!envelope) return;
        const fingerprint = envelope.ciphertext || JSON.stringify(envelope);
        if (state.decrypted.get(job.id)?.fingerprint === fingerprint) return;
        try {
            const result = await decryptEnvelope(keys.privateKey, envelope);
            state.decrypted.set(job.id, { result, fingerprint });
        } catch {
            // Results from another browser session remain encrypted and are never sent back for decryption.
            state.decrypted.set(job.id, { inaccessible: true, fingerprint });
        }
    }));
}

function renderThoughts() {
    const jobs = (state.data?.jobs || []).filter(job => !job.kind || ['thought', 'telegram_thought', 'clarify'].includes(job.kind));
    $('thought-results').setAttribute('aria-busy', 'false');
    if (!jobs.length) {
        $('thought-results').innerHTML = empty('✧', 'Здесь появятся ваши мысли', 'Начните с одной идеи. Агент сохранит её в Obsidian и вернёт результат сюда.');
        return;
    }
    $('thought-results').innerHTML = jobs.slice(0, 25).map(job => {
        const decrypted = state.decrypted.get(job.id);
        const result = decrypted?.result;
        const note = result?.note;
        const clarification = typeof result?.clarification === 'string' ? result.clarification : result?.clarification?.question;
        const status = jobStatus(job);
        const message = result?.message || (decrypted?.inaccessible ? 'Результат зашифрован для другого сеанса браузера. Готовую заметку можно открыть на вашем Mac.' : status === 'Готово' ? 'Задание завершено на Mac. Подробности доступны в вашей локальной базе.' : status === 'Нужна проверка' ? 'Откройте помощника на Mac, чтобы проверить локальную модель и доступ к базе.' : 'Текст находится в зашифрованной очереди. Обработка начнётся, когда ваш Mac будет готов.');
        const openUrl = typeof note?.openUrl === 'string' && note.openUrl.startsWith('obsidian://open?') ? note.openUrl : null;
        const tags = Array.isArray(note?.tags) ? note.tags.slice(0, 8) : [];
        const links = Array.isArray(note?.links) ? note.links.slice(0, 4) : [];
        return `<article class="ws-result"><div class="ws-result-top"><span class="ws-result-symbol" aria-hidden="true">${note ? '✓' : clarification ? '?' : '✦'}</span><strong>${escapeHtml(note?.title || 'Личная мысль')}</strong><time datetime="${escapeHtml(job.created_at || '')}">${escapeHtml(formatDate(job.created_at))}</time></div><p class="ws-status-line">${escapeHtml(status)}</p><p>${escapeHtml(message)}</p>${note?.path ? `<p>${escapeHtml(note.path)}</p>` : ''}${tags.length || links.length ? `<div class="ws-tags">${tags.map(tag => `<span>#${escapeHtml(String(tag).replace(/^#/, ''))}</span>`).join('')}${links.map(link => `<span>↗ ${escapeHtml(typeof link === 'string' ? link : link.title || '')}</span>`).join('')}</div>` : ''}${clarification ? `<p class="ws-clarification-question">${escapeHtml(clarification)}</p>` : ''}${clarification || openUrl ? `<div class="ws-result-actions">${clarification ? `<button class="ws-text-button" type="button" data-clarify="${escapeHtml(job.id)}">Уточнить дату и время →</button>` : ''}${openUrl ? `<a class="ws-text-button" href="${escapeHtml(openUrl)}">Открыть в Obsidian ↗</a>` : ''}</div>` : ''}</article>`;
    }).join('');
}

function renderReminders() {
    const reminders = (state.data?.reminders || []).filter(reminder => !['cancelled', 'canceled', 'complete', 'completed', 'done'].includes(reminder.status));
    const upcoming = reminders.filter(reminder => !['sent', 'delivered'].includes(reminder.status));
    $('reminder-badge').hidden = !upcoming.length;
    $('reminder-badge').textContent = String(upcoming.length);
    $('reminder-total').textContent = `${upcoming.length} в расписании`;
    $('reminders-list').innerHTML = reminders.length ? reminders.map(reminder => {
        const delivered = ['sent', 'delivered'].includes(reminder.status);
        return `<article class="ws-reminder"><time datetime="${escapeHtml(reminder.due_at || '')}">${escapeHtml(formatTime(reminder.due_at))}<small>${escapeHtml(formatDate(reminder.due_at))}</small></time><div class="ws-reminder-copy"><strong>Личное напоминание</strong><p>${delivered ? 'Нейтральное уведомление отправлено' : 'Подробности доступны в Obsidian на вашем Mac'}</p></div>${delivered ? '<span class="ws-state">Отправлено</span>' : `<button class="ws-icon-button" type="button" data-cancel-reminder="${escapeHtml(reminder.id)}" aria-label="Отменить это напоминание" title="Отменить напоминание">×</button>`}</article>`;
    }).join('') : empty('◷', 'Пока можно выдохнуть', 'Когда в мысли появится задача со сроком, агент создаст напоминание. Если даты нет, он спросит вас.');
}

function enabledWhatsAppAgents() {
    return (state.data?.agents || []).filter(agent => agent.type === 'whatsapp' && agent.enabled);
}

function whatsAppAgentStatus(agent) {
    if (!agent.enabled) return { label: 'Выключен', connected: false };
    const enabled = enabledWhatsAppAgents();
    if (enabled.length !== 1 || enabled[0].id !== agent.id) return { label: 'Выберите одного агента', connected: false };
    if (!deviceIsOnline()) return { label: 'Ждёт Mac', connected: false };
    const status = state.data?.device?.status?.whatsapp;
    if (status === 'connected') return { label: 'На связи', connected: true };
    if (status === 'paused') return { label: 'Приостановлен', connected: false };
    if (status === 'qr') return { label: 'Ожидает QR', connected: false };
    return { label: 'Не подключён', connected: false };
}

function renderAgents() {
    const agents = state.data?.agents || [];
    $('agents-list').innerHTML = agents.length ? agents.map(agent => {
        const whatsapp = agent.type === 'whatsapp';
        const status = whatsapp ? whatsAppAgentStatus(agent) : { label: agent.enabled ? 'Включён' : 'Выключен', connected: agent.enabled };
        const onlyEnabled = enabledWhatsAppAgents().length === 1;
        const actions = !whatsapp ? '<span class="ws-muted">Только локальная AI</span>' : agent.enabled
            ? `${!status.connected && onlyEnabled ? `<button class="ws-text-button" type="button" data-connect-whatsapp="${escapeHtml(agent.id)}">Подключить WhatsApp ↗</button>` : ''}<button class="ws-text-button" type="button" data-pause-whatsapp="${escapeHtml(agent.id)}">Остановить ответы</button>${status.connected ? `<button class="ws-secondary ws-self-check-button" type="button" data-self-check-whatsapp="${escapeHtml(agent.id)}" aria-describedby="self-check-intro"${state.selfCheckBusy || state.selfCheck?.jobId || state.selfCheck && state.selfCheck.agentId !== agent.id ? ' disabled' : ''}>${state.selfCheck?.jobId ? 'Самопроверка создана' : 'Проверить отправку себе'}</button>` : ''}`
            : '<span class="ws-muted">Включите в настройках</span>';
        return `<article class="ws-agent"><div class="ws-agent-head"><span class="ws-agent-avatar ${whatsapp ? 'is-whatsapp' : ''}" aria-hidden="true">${whatsapp ? '↗' : '✦'}</span><span class="ws-state ${status.connected ? 'is-online' : ''}">${escapeHtml(status.label)}</span></div><h2>${escapeHtml(agent.name)}</h2><p>${whatsapp ? 'Сам отвечает на общие вопросы и общается в личных чатах в вашем стиле. Личные решения передаёт вам и предупреждает собеседника.' : 'Собирает мысли в заметки и работает с вашей базой Obsidian локально.'}</p><div class="ws-agent-meta"><span>${whatsapp ? `WhatsApp · ${escapeHtml(status.label.toLocaleLowerCase('ru'))}` : 'Obsidian · на Mac'}</span><span>${agent.rules || agent.examples ? 'Ваши инструкции' : 'Правила ещё не заданы'}</span></div><div class="ws-agent-actions"><button class="ws-secondary" type="button" data-edit-agent="${escapeHtml(agent.id)}">Настроить</button>${actions}</div></article>`;
    }).join('') : empty('✦', 'Создайте своего первого агента', 'Задайте ему роль, правила общения и несколько ваших примеров ответов.');
}

function actionableApproval(approval) {
    const expiry = safeDate(approval.expires_at);
    return ['pending', 'awaiting_approval'].includes(approval.status) && (!expiry || expiry.getTime() > Date.now()) && !state.approvalDecisions.has(approval.id);
}

function approvalActivityAt(approval) {
    return [approval.activity_at, approval.created_at, approval.decided_at, approval.delivered_at]
        .map(value => ({ value, date: safeDate(value) })).filter(item => item.date)
        .sort((a, b) => b.date.getTime() - a.date.getTime())[0]?.value || null;
}

function approvalHistory() {
    const records = new Map();
    const history = Array.isArray(state.data?.approvalHistory) ? state.data.approvalHistory : (state.data?.approvals || []).filter(item => !actionableApproval(item));
    for (const item of [...history, ...state.approvalDecisions.values()]) {
        const status = ['pending', 'awaiting_approval', 'approved'].includes(item.status) && safeDate(item.expires_at)?.getTime() <= Date.now() ? 'expired' : item.status;
        if (!['pending', 'awaiting_approval'].includes(status)) records.set(item.id, { ...item, status });
    }
    return [...records.values()].sort((a, b) => (safeDate(approvalActivityAt(b))?.getTime() || 0) - (safeDate(approvalActivityAt(a))?.getTime() || 0));
}

function renderApprovalHistory() {
    const history = approvalHistory();
    const fingerprint = JSON.stringify({ history, visible: state.historyVisible, online: deviceIsOnline() });
    if (fingerprint === state.historyFingerprint) return;
    state.historyFingerprint = fingerprint;
    const expanded = new Set([...document.querySelectorAll('#approval-history-list details[open]')].map(item => item.dataset.historyDetails));
    const statuses = {
        approved: ['Ждёт отправки', deviceIsOnline() ? 'Ответ согласован. Ожидает обработки на Mac.' : 'Ответ согласован и ждёт подключения Mac.'],
        dispatching: ['Отправляется', 'Mac обрабатывает согласованную отправку. Подождите обновления статуса.'],
        sent: ['Передано WhatsApp', 'WhatsApp принял отправку. Это не подтверждает доставку на телефон или прочтение.'],
        failed: ['Не отправлено', 'Отправка не завершилась. Проверьте подключение и сам чат WhatsApp.'],
        uncertain: ['Исход неизвестен', 'Не удалось подтвердить результат отправки. Проверьте чат WhatsApp перед повторными действиями.'],
        rejected: ['Отклонено', 'Вы отклонили этот ответ. Агент его не отправит.'],
        expired: ['Срок истёк', 'Срок согласования истёк. Ответ по этому согласованию не будет отправлен.']
    };
    $('approval-history-total').textContent = history.length ? `Последние ${history.length}` : '';
    $('approval-history-list').innerHTML = history.length ? history.slice(0, state.historyVisible).map(item => {
        const [label, detail] = statuses[item.status] || ['Статус уточняется', 'Результат ещё не подтверждён. Проверьте чат WhatsApp.'];
        const timestamp = approvalActivityAt(item);
        return `<article class="ws-decision"><div class="ws-decision-head"><h3>${escapeHtml(recipientLabel(item))}</h3><span class="ws-state ${item.status === 'sent' ? 'is-online' : ''}">${escapeHtml(label)}</span></div><p>${escapeHtml(detail)}</p><time datetime="${escapeHtml(timestamp || '')}">${escapeHtml(formatDate(timestamp, { hour: '2-digit', minute: '2-digit' }))}</time><details data-history-details="${escapeHtml(item.id)}"${expanded.has(item.id) ? ' open' : ''}><summary>Сообщение и ответ</summary><dl><dt>Входящее сообщение</dt><dd>${escapeHtml(item.original || 'Текст недоступен')}</dd><dt>Ответ</dt><dd>${escapeHtml(item.draft || 'Ответ не был подготовлен')}</dd></dl></details></article>`;
    }).join('') : empty('↗', 'Здесь будет результат согласований', 'После вашего решения можно проверить, ожидает ли ответ отправки и что сообщил WhatsApp.');
    $('approval-history-more').hidden = history.length <= state.historyVisible;
}

function renderApprovals() {
    const focused = document.activeElement?.matches('#approvals-list textarea') ? document.activeElement : null;
    const focusedId = focused?.closest('[data-approval]')?.dataset.approval;
    const selection = focused ? { start: focused.selectionStart, end: focused.selectionEnd, scrollTop: focused.scrollTop } : null;
    if (focusedId) state.approvalDrafts.set(focusedId, focused.value);
    const approvals = (state.data?.approvals || []).filter(actionableApproval);
    const page = state.data?.approvalPage || { offset: 0, limit: 250, hasMore: false };
    const more = page.hasMore || page.offset > 0;
    $('approval-badge').hidden = !approvals.length && !more;
    $('approval-badge').textContent = `${approvals.length}${more ? '+' : ''}`;
    $('mobile-approval-dot').hidden = !approvals.length && !more;
    $('approval-total').textContent = page.offset || page.hasMore ? `${approvals.length} на странице · от ${page.offset + 1}` : approvals.length ? `${approvals.length} ждут решения` : '';
    $('approval-paging').hidden = !page.hasMore && !page.offset;
    $('approval-previous').disabled = !page.offset;
    $('approval-next').disabled = !page.hasMore;
    $('approvals-list').setAttribute('aria-busy', String(page.offset !== state.approvalOffset));
    const reasons = { money: 'Платёж или личное финансовое решение', meeting: 'Личная встреча или срок', commitment: 'Обещание или договорённость', conflict: 'Личный конфликт', sensitive: 'Личные данные', uncertain: 'Нужно уточнить важные сведения', model_unavailable: 'Модель сейчас недоступна', rate_limit: 'Лимит автоматических ответов' };
    const html = approvals.length ? approvals.map(approval => `<article class="ws-approval" data-approval="${escapeHtml(approval.id)}"><div class="ws-approval-head"><div><strong>${escapeHtml(recipientLabel(approval))}</strong><span>${escapeHtml(reasons[approval.reason] || 'Новый ответ — нужно ваше решение')}</span></div><span class="ws-state">На согласовании</span></div><blockquote>${escapeHtml(approval.original || 'Входящее сообщение')}</blockquote><label for="approval-${escapeHtml(approval.id)}">Ответ агента — можно отредактировать<textarea id="approval-${escapeHtml(approval.id)}" maxlength="4000" rows="3">${escapeHtml(state.approvalDrafts.get(approval.id) ?? approval.draft ?? '')}</textarea></label><div class="ws-approval-actions"><button class="ws-text-button" type="button" data-approval-action="reject" data-id="${escapeHtml(approval.id)}"${state.approvalActions.has(approval.id) ? ' disabled' : ''}>Не отправлять</button><button class="ws-primary" type="button" data-approval-action="approve" data-id="${escapeHtml(approval.id)}"${state.approvalActions.has(approval.id) ? ' disabled' : ''}>Согласовать ответ <span aria-hidden="true">↗</span></button></div></article>`).join('') : empty('✓', page.offset ? 'На этой странице больше нет согласований' : 'Согласований пока нет', page.offset ? 'Вернитесь на предыдущую страницу, чтобы проверить оставшиеся вопросы.' : 'На общие вопросы AI отвечает сам. Здесь появятся личные встречи, платежи, обещания и другие вопросы, требующие вашего решения.');
    if ($('approvals-list').innerHTML !== html) $('approvals-list').innerHTML = html;
    if (focusedId && approvals.some(item => item.id === focusedId)) {
        const input = $(`approval-${focusedId}`);
        input?.focus({ preventScroll: true });
        input?.setSelectionRange(selection.start, selection.end);
        if (input) input.scrollTop = selection.scrollTop;
    } else if (focusedId) {
        $('approval-title').focus({ preventScroll: true });
        toast('Согласование завершено или его срок истёк. Черновик не отправлен.');
    }
    renderApprovalHistory();
}

function recipientLabel(approval) {
    if (approval.recipient_name) return approval.recipient_name;
    const recipient = String(approval.recipient || '');
    const phone = recipient.match(/^([0-9]{5,20})@s\.whatsapp\.net$/);
    if (phone) return `+${phone[1]}`;
    return recipient.endsWith('@lid') ? 'Контакт WhatsApp' : recipient || 'Собеседник WhatsApp';
}

function renderQr() {
    if (!state.qrJobId || !$('qr-dialog').open) return;
    const job = (state.data?.jobs || []).find(item => item.id === state.qrJobId);
    const result = state.decrypted.get(state.qrJobId)?.result;
    const agent = (state.data?.agents || []).find(item => item.id === state.qrAgentId);
    const connected = Boolean(agent && whatsAppAgentStatus(agent).connected);
    const fingerprint = JSON.stringify({ status: job?.status, result, connected });
    if (fingerprint === state.qrFingerprint) return;
    state.qrFingerprint = fingerprint;
    const target = $('qr-content');
    target.replaceChildren();
    $('refresh-qr-button').hidden = connected;
    if (connected) {
        const message = document.createElement('p');
        message.textContent = 'WhatsApp подключён. AI сам отвечает на общие вопросы в личных чатах. Личные решения передаёт вам; после передачи предупреждает собеседника.';
        target.append(message);
        return;
    }
    const qr = result?.qr || result?.qrDataUrl;
    if (typeof qr === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(qr) && qr.length < 600000) {
        const image = document.createElement('img');
        image.src = qr;
        image.alt = 'QR-код для привязки WhatsApp — сканируйте с вашего телефона';
        target.append(image);
    }
    const message = document.createElement('p');
    message.textContent = result?.message || (deviceIsOnline() ? 'Mac готовит защищённое подключение…' : 'Сначала запустите помощника на Mac. Запрос ожидает его в очереди.');
    target.append(message);
    if (['completed', 'complete', 'done', 'failed', 'error'].includes(job?.status) && !result) {
        message.textContent = 'Результат недоступен в этом сеансе. Запросите новый QR-код или проверьте помощника на Mac.';
    }
}

async function refresh({ quiet = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    const requestedOffset = state.approvalOffset;
    try {
        const data = await api();
        state.data = data.workspace || data;
        for (const item of state.data.approvalHistory || []) state.approvalDecisions.delete(item.id);
        await decryptResults();
        renderSelfCheck();
        renderDevice(); renderThoughts(); renderReminders(); renderAgents();
        renderApprovals();
        renderQr();
        $('workspace-alert').hidden = true;
    } catch (error) {
        if (!quiet || !state.data) showError(error);
        if (state.data) renderDevice();
        if (!state.data) {
            $('thought-results').setAttribute('aria-busy', 'false');
            $('thought-results').innerHTML = empty('↻', 'Пространство пока не загрузилось', 'Попробуйте обновить данные. Ваши мысли не были отправлены.');
            $('island-status').textContent = 'Нет связи';
        }
    } finally {
        state.loading = false;
        if (requestedOffset !== state.approvalOffset) void refresh({ quiet: true });
    }
}

async function submitThought(event) {
    event.preventDefault();
    const text = $('thought-input').value.trim();
    if (!text || state.sending) return;
    state.sending = true;
    $('thought-input').disabled = true;
    $('thought-submit').disabled = true;
    $('thought-submit').querySelector('span').textContent = 'Шифрую и отправляю…';
    try {
        await enqueueEncrypted('thought', { text, intent: state.clarification ? 'clarify' : 'thought', ...(state.clarification ? { relatedJobId: state.clarification.jobId } : {}) }, { retry: true });
        $('thought-input').value = '';
        $('thought-count').textContent = '0 / 8 000';
        clearClarification();
        toast(deviceIsOnline() ? 'Мысль зашифрована и отправлена вашему Mac.' : 'Мысль в зашифрованной очереди. Mac обработает её после подключения.');
        await refresh();
    } catch (error) { toast(error.message); }
    finally {
        state.sending = false;
        $('thought-submit').querySelector('span').textContent = 'Сохранить мысль';
        renderDevice();
    }
}

function clearClarification() {
    state.clarification = null;
    $('clarification-context').hidden = true;
    $('thought-input').placeholder = 'Идея для проекта, план на завтра или мысль, которую хочется сохранить…';
}

function openDialog(dialog) {
    if (!dialog.open) {
        previousDialogFocus = document.activeElement;
        dialog.showModal();
    }
}

function closeDialog(dialog) {
    dialog.close();
    previousDialogFocus?.focus();
}

function openAgent(id) {
    const agent = (state.data?.agents || []).find(item => item.id === id);
    $('agent-form').reset();
    $('agent-id').value = agent?.id || '';
    $('agent-name').value = agent?.name || '';
    $('agent-type').value = agent?.type || 'whatsapp';
    $('agent-type').disabled = Boolean(agent);
    $('agent-type').querySelector('option[value="personal"]').disabled = !agent && (state.data?.agents || []).some(item => item.type === 'personal');
    $('agent-rules').value = agent?.rules || '';
    $('agent-examples').value = typeof agent?.examples === 'string' ? agent.examples : agent?.examples ? JSON.stringify(agent.examples) : '';
    $('agent-enabled').checked = agent?.enabled || false;
    $('agent-dialog-title').textContent = agent ? 'Настроить агента' : 'Создать агента';
    $('agent-form-feedback').textContent = '';
    updateAgentActivation();
    openDialog($('agent-dialog'));
    $('agent-name').focus();
}

function updateAgentActivation() {
    const id = $('agent-id').value;
    const whatsapp = $('agent-type').value === 'whatsapp';
    const other = enabledWhatsAppAgents().find(agent => agent.id !== id);
    const current = (state.data?.agents || []).find(agent => agent.id === id);
    const newlyCreated = whatsapp && !id;
    const blocked = whatsapp && !current?.enabled && Boolean(other);
    $('agent-enabled').disabled = newlyCreated || blocked;
    if (newlyCreated || blocked) $('agent-enabled').checked = false;
    $('agent-enabled-label').textContent = newlyCreated ? 'Создать выключенным' : 'Включить агента';
    $('agent-activation-hint').textContent = newlyCreated
        ? 'Новый WhatsApp-агент сохранится выключенным. Затем включите его в настройках. Для одного личного номера работает один агент.'
        : blocked ? `Сейчас включён «${other.name}». Сначала остановите его ответы, затем включите этого агента.`
            : whatsapp ? 'Для одного личного номера можно включить одного WhatsApp-агента. Подключение на Mac настраивается отдельно.' : 'Помощник работает с Obsidian только на вашем Mac.';
}

async function saveAgent(event) {
    event.preventDefault();
    const button = $('save-agent-button');
    button.disabled = true;
    const id = $('agent-id').value;
    const agent = { name: $('agent-name').value.trim(), type: $('agent-type').value, rules: $('agent-rules').value.trim(), examples: $('agent-examples').value.trim(), enabled: $('agent-enabled').checked };
    if (!id && agent.type === 'whatsapp') agent.enabled = false;
    try {
        const other = enabledWhatsAppAgents().find(item => item.id !== id);
        if (agent.type === 'whatsapp' && agent.enabled && other) throw new Error(`Сначала остановите ответы агента «${other.name}». На один личный номер можно включить одного WhatsApp-агента.`);
        await api({ action: id ? 'update_agent' : 'create_agent', ...(id ? { id } : {}), agent });
        closeDialog($('agent-dialog'));
        toast(id ? 'Настройки агента сохранены.' : agent.type === 'whatsapp' ? 'Агент создан выключенным. Включите его в настройках, когда будете готовы.' : 'Личный агент создан.');
        await refresh();
    } catch (error) { $('agent-form-feedback').textContent = error.message; }
    finally { button.disabled = false; }
}

async function createPairing() {
    $('pairing-button').disabled = true;
    try {
        const result = await api({ action: 'create_pairing' });
        const pairing = result.pairing || result;
        if (!/^[A-Za-z0-9_-]{8,160}$/.test(pairing.code || '')) throw new Error('Сервер не вернул корректный код привязки. Попробуйте ещё раз.');
        state.pairing = pairing;
        $('pairing-command').textContent = `node companion/start.mjs --pair ${pairing.code} --url ${location.origin}`;
        $('pairing-expiry').textContent = pairing.expires_at ? `До ${formatTime(pairing.expires_at)}` : 'Код одноразовый';
        $('pairing-panel').hidden = false;
        $('pairing-panel').scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    } catch (error) { toast(error.message); }
    finally { $('pairing-button').disabled = false; }
}

async function copyPairing() {
    const expiry = safeDate(state.pairing?.expires_at);
    if (expiry && expiry.getTime() < Date.now()) {
        toast('Код привязки истёк. Нажмите «Подключить мой Mac» ещё раз.');
        return;
    }
    try { await navigator.clipboard.writeText($('pairing-command').textContent); toast('Команда скопирована. Выполните её в папке проекта на Mac.'); }
    catch { toast('Выделите команду и скопируйте её вручную.'); }
}

async function connectWhatsApp(agentId, button) {
    const agent = (state.data?.agents || []).find(item => item.id === agentId);
    if (!agent?.enabled || enabledWhatsAppAgents().length !== 1) {
        toast('Сначала включите одного WhatsApp-агента в его настройках.');
        return;
    }
    button.disabled = true;
    state.qrAgentId = agentId;
    state.qrJobId = null;
    state.qrFingerprint = '';
    $('refresh-qr-button').hidden = false;
    $('qr-content').innerHTML = '<span class="ws-loading-dot" aria-hidden="true"></span><p>Отправляю запрос вашему Mac…</p>';
    openDialog($('qr-dialog'));
    try {
        const result = await enqueueEncrypted('whatsapp_connect', { intent: 'whatsapp_connect', agentId });
        state.qrJobId = result.job?.id || result.id;
        if (!state.qrJobId) throw new Error('Запрос создан, но сервер не вернул его номер. Обновите страницу.');
        await refresh();
    } catch (error) { $('qr-content').replaceChildren(); const message = document.createElement('p'); message.textContent = error.message; $('qr-content').append(message); }
    finally { button.disabled = false; }
}

async function pauseWhatsApp(agentId, button) {
    if (button.disabled) return;
    button.disabled = true;
    try {
        await api({ action: 'update_agent', id: agentId, agent: { enabled: false } });
        const agent = (state.data?.agents || []).find(item => item.id === agentId);
        if (agent) agent.enabled = false;
        renderAgents();
        toast('Агент выключен в кабинете. Mac остановит ответы при следующей связи. Включить его снова можно в настройках.');
        await refresh();
    } catch (error) { toast(error.message); button.disabled = false; }
}

async function handleApproval(action, id, button) {
    if (state.approvalActions.has(id)) return;
    const current = (state.data?.approvals || []).find(item => item.id === id);
    if (!current || !actionableApproval(current)) {
        toast('Этот ответ уже обработан или срок согласования истёк. Черновик не отправлен.');
        renderApprovals();
        return;
    }
    const article = button.closest('[data-approval]');
    const draft = article.querySelector('textarea').value.trim();
    if (action === 'approve' && !draft) { toast('Введите ответ перед согласованием.'); return; }
    state.approvalActions.add(id);
    article.querySelectorAll('button').forEach(item => { item.disabled = true; });
    try {
        const result = await api({ action, id, ...(action === 'approve' ? { draft } : {}) });
        state.approvalDecisions.set(id, { ...current, ...result.approval, status: result.approval?.status || (action === 'approve' ? 'approved' : 'rejected'), ...(action === 'approve' ? { draft } : {}) });
        state.approvalDrafts.delete(id);
        toast(action === 'approve' ? 'Ответ согласован. Mac отправит его, когда будет на связи.' : 'Ответ отклонён. Агент его не отправит.');
        renderApprovals();
        await refresh();
    } catch (error) {
        state.approvalDrafts.set(id, draft);
        toast(error.message);
    } finally {
        state.approvalActions.delete(id);
        renderApprovals();
    }
}

async function changeApprovalPage(direction) {
    const page = state.data?.approvalPage || { offset: 0, limit: 250, hasMore: false };
    if (state.approvalOffset !== page.offset || direction > 0 && !page.hasMore || direction < 0 && !page.offset) return;
    state.approvalOffset = Math.max(0, page.offset + direction * page.limit);
    $('approval-previous').disabled = true;
    $('approval-next').disabled = true;
    $('approvals-list').setAttribute('aria-busy', 'true');
    await refresh();
}

function bindEvents() {
    document.querySelectorAll('[data-view]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); showView(link.dataset.view); }));
    window.addEventListener('hashchange', () => showView(location.hash.slice(1), false));
    $('thought-form').addEventListener('submit', submitThought);
    $('thought-input').addEventListener('input', () => { $('thought-count').textContent = `${$('thought-input').value.length.toLocaleString('ru-RU')} / 8 000`; });
    $('clear-clarification').addEventListener('click', clearClarification);
    $('refresh-button').addEventListener('click', async () => { $('refresh-button').disabled = true; await refresh(); $('refresh-button').disabled = false; });
    $('thought-results').addEventListener('click', event => {
        const button = event.target.closest('[data-clarify]');
        if (!button) return;
        const result = state.decrypted.get(button.dataset.clarify)?.result;
        const question = typeof result?.clarification === 'string' ? result.clarification : result?.clarification?.question;
        state.clarification = { jobId: button.dataset.clarify, question };
        $('clarification-copy').textContent = question || 'Уточните дату и время для этой мысли';
        $('clarification-context').hidden = false;
        $('thought-input').placeholder = 'Например: завтра, 28 октября, в 15:00 по Алматы';
        $('thought-input').focus();
        $('thought-form').scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    $('new-agent-button').addEventListener('click', () => openAgent());
    $('close-agent-dialog').addEventListener('click', () => closeDialog($('agent-dialog')));
    $('close-qr-dialog').addEventListener('click', () => closeDialog($('qr-dialog')));
    $('refresh-qr-button').addEventListener('click', () => { if (state.qrAgentId) connectWhatsApp(state.qrAgentId, $('refresh-qr-button')); });
    [$('agent-dialog'), $('qr-dialog')].forEach(dialog => {
        dialog.addEventListener('cancel', () => { requestAnimationFrame(() => previousDialogFocus?.focus()); });
        dialog.addEventListener('click', event => {
            if (event.target !== dialog) return;
            const rect = dialog.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(dialog);
        });
    });
    $('agent-form').addEventListener('submit', saveAgent);
    $('agent-type').addEventListener('change', updateAgentActivation);
    $('pairing-button').addEventListener('click', createPairing);
    $('copy-pairing-button').addEventListener('click', copyPairing);
    $('agents-list').addEventListener('click', event => {
        const edit = event.target.closest('[data-edit-agent]');
        if (edit) { openAgent(edit.dataset.editAgent); return; }
        const connect = event.target.closest('[data-connect-whatsapp]');
        if (connect) connectWhatsApp(connect.dataset.connectWhatsapp, connect);
        const selfCheck = event.target.closest('[data-self-check-whatsapp]');
        if (selfCheck) startSelfCheck(selfCheck.dataset.selfCheckWhatsapp);
        const pause = event.target.closest('[data-pause-whatsapp]');
        if (pause) pauseWhatsApp(pause.dataset.pauseWhatsapp, pause);
    });
    $('approvals-list').addEventListener('click', event => {
        const button = event.target.closest('[data-approval-action]');
        if (button) handleApproval(button.dataset.approvalAction, button.dataset.id, button);
    });
    $('approvals-list').addEventListener('input', event => {
        if (!event.target.matches('textarea')) return;
        const article = event.target.closest('[data-approval]');
        if (article) state.approvalDrafts.set(article.dataset.approval, event.target.value);
    });
    $('approval-previous').addEventListener('click', () => changeApprovalPage(-1));
    $('approval-next').addEventListener('click', () => changeApprovalPage(1));
    $('approval-history-more').addEventListener('click', () => { state.historyVisible += 20; renderApprovalHistory(); });
    $('self-check-retry').addEventListener('click', () => { if (state.selfCheck?.agentId) startSelfCheck(state.selfCheck.agentId); });
    $('self-check-approval').addEventListener('click', focusSelfCheckApproval);
    $('reminders-list').addEventListener('click', async event => {
        const button = event.target.closest('[data-cancel-reminder]');
        if (!button) return;
        button.disabled = true;
        try { await api({ action: 'cancel_reminder', id: button.dataset.cancelReminder }); toast('Напоминание отменено.'); await refresh(); }
        catch (error) { toast(error.message); button.disabled = false; }
    });
    $('logout-button').addEventListener('click', async () => {
        $('logout-button').disabled = true;
        try {
            const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
            if (!response.ok) throw new Error('Не удалось выйти. Попробуйте ещё раз.');
            try { sessionStorage.removeItem(REPLY_KEY_STORAGE); sessionStorage.removeItem(SELF_CHECK_STORAGE); } catch { /* Storage may be disabled. */ }
            try { localStorage.removeItem('auth_token'); localStorage.removeItem('auth_email'); } catch { /* Storage may be disabled. */ }
            state.keys = null; state.decrypted.clear(); state.approvalDrafts.clear(); state.approvalDecisions.clear(); state.pendingThought = null; state.selfCheck = null;
            inboxController?.destroy();
            location.assign('/login.html');
        } catch (error) { toast(error.message); $('logout-button').disabled = false; }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh({ quiet: true }); });
    window.addEventListener('pagehide', () => { clearInterval(pollingTimer); inboxController?.destroy(); });
    window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
}

async function init() {
    bindEvents();
    showView(location.hash.slice(1), false);
    try {
        const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
        if (response.status === 401) { location.assign('/login.html?next=workspace.html'); return; }
        if (!response.ok) throw new Error('Не удалось проверить вход. Обновите страницу.');
        const data = await response.json();
        state.user = data.user;
        restoreSelfCheck();
        $('account-name').textContent = state.user?.name || state.user?.login || 'Мой кабинет';
        await refresh();
        try {
            const { mountWhatsAppInbox } = await import('./whatsapp-inbox.js?v=20261031d');
            inboxController = mountWhatsAppInbox({ accountId: selfCheckAccount(), notice: toast, onAuth: () => location.assign('/login.html?next=workspace.html'), onDecision: () => refresh({ quiet: true }) });
            inboxController.setActive(state.view === 'chats');
        } catch {
            $('inbox-error-copy').textContent = 'Не удалось открыть чаты. Обновите страницу и попробуйте ещё раз.';
            $('inbox-error').hidden = false;
            $('inbox-retry').onclick = () => location.reload();
        }
        pollingTimer = setInterval(() => { if (!document.hidden) refresh({ quiet: true }); }, POLL_MS);
    } catch (error) { showError(error); }
}

init();
