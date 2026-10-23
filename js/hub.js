import { MAX_FILE_BYTES, parseTransactionCsv } from './transaction-csv.js';

const API_ROOT = '/api/hub';
const VALID_VIEWS = new Set(['agent', 'notes', 'calendar', 'finance', 'connections']);
const RECORD_PAGE_SIZES = Object.freeze({ note: 80, event: 80, transaction: 120 });
const CHAT_DRAFT_STORAGE_KEY = 'shaikh-agent-hub-chat-draft-v1';
const CHAT_RUN_STORAGE_KEY = 'shaikh-agent-hub-chat-run-v1';
const TELEGRAM_POLL_INTERVAL = 5000;
const CSV_PREVIEW_LIMIT = 6;

function pagingState() {
    return { offset: 0, hasMore: false, loading: false, request: 0 };
}

function csvImportState() {
    return { fileName: '', rows: [], errors: [], error: '', submitError: '', parsing: false, submitting: false, result: null };
}

const state = {
    user: null,
    agent: null,
    messages: [],
    records: { note: [], event: [], transaction: [] },
    dashboardRecords: { note: [], event: [], transaction: [] },
    paging: { note: pagingState(), event: pagingState(), transaction: pagingState() },
    eventMode: 'upcoming',
    summary: {},
    models: [],
    connections: { openrouter: null, telegram: null, googleCalendar: null },
    errors: { overview: null, connections: null, googleCalendar: null, note: null, event: null, transaction: null },
    loaded: false,
    hiddenHistory: false,
    chatRun: null,
    csvImport: csvImportState(),
    googleCalendarReturn: '',
    googleCalendarReturnAnnounced: false,
    googleCalendarFeedback: null
};

const dom = {};
let lastFormTrigger = null;
let noteSearchTimer = 0;
let telegramPollTimer = 0;
let telegramCountdownTimer = 0;
let telegramStatusPromise = null;
let lastForegroundRefresh = 0;

const AGENT_PRESETS = {
    personal: 'Будь моим личным помощником. Отвечай кратко, помогай держать фокус, сохраняй важные мысли и уточняй недостающие даты или суммы перед записью.',
    business: 'Помогай мне как предпринимателю: превращай идеи в следующие шаги, фиксируй договорённости, встречи и расходы. Отвечай конкретно и выделяй приоритет.',
    content: 'Помогай с контентом и задачами: собирай идеи, предлагай понятный план публикаций и сохраняй решения. Пиши живо, без канцелярита и лишней воды.',
    study: 'Помогай мне учиться: объясняй простыми словами, превращай материалы в план, вопросы и заметки. Проверяй понимание короткими уточнениями.'
};

class ApiError extends Error {
    constructor(message, status = 0) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}

function cacheDom() {
    [
        'system-status', 'refresh-button', 'logout-button', 'user-name', 'user-email', 'user-avatar',
        'global-alert', 'agent-name', 'agent-model', 'chat-feed', 'chat-form',
        'chat-input', 'chat-submit', 'chat-lock-cta', 'clear-chat-button', 'today-date', 'today-summary',
        'agent-live-dot', 'activation-panel', 'activation-title', 'activation-copy',
        'activation-progress', 'activation-steps', 'workflow-grid',
        'next-record', 'notes-search', 'notes-count', 'notes-list', 'note-form',
        'calendar-strip', 'calendar-list-title', 'event-filter', 'events-count', 'events-list', 'event-form', 'balance-value',
        'income-value', 'expense-value', 'transaction-filter', 'transactions-list',
        'transaction-form', 'transaction-csv-file', 'transaction-csv-picker', 'transaction-csv-template',
        'transaction-csv-status', 'transaction-csv-preview', 'transaction-csv-submit',
        'profile-form', 'profile-model', 'profile-language', 'openrouter-state',
        'openrouter-form', 'openrouter-model', 'openrouter-delete', 'telegram-state',
        'telegram-form', 'telegram-token-label', 'telegram-link-box', 'telegram-link-code',
        'telegram-link-status', 'telegram-copy', 'telegram-check', 'telegram-open-link',
        'telegram-disconnect', 'telegram-regenerate', 'telegram-connect', 'google-calendar-state',
        'google-calendar-copy', 'google-calendar-connect', 'google-calendar-sync',
        'google-calendar-disconnect', 'google-calendar-feedback', 'form-overlay', 'toast-region'
    ].forEach(id => { dom[toCamel(id)] = document.getElementById(id); });
}

function toCamel(value) {
    return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[character]));
}

function safeText(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function readSessionValue(key) {
    try {
        return sessionStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeSessionValue(key, value) {
    try {
        if (value === null || value === undefined || value === '') sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, value);
    } catch {
        // Private browsing and strict storage policies can disable sessionStorage.
    }
}

function saveChatDraft(value) {
    writeSessionValue(CHAT_DRAFT_STORAGE_KEY, String(value || '').slice(0, 4000));
}

function persistChatRun(run) {
    if (!run) {
        writeSessionValue(CHAT_RUN_STORAGE_KEY, null);
        return;
    }
    const stored = {
        message: String(run.message || '').slice(0, 4000),
        requestId: String(run.requestId || '').slice(0, 128),
        createdAt: run.createdAt || new Date().toISOString()
    };
    writeSessionValue(CHAT_RUN_STORAGE_KEY, JSON.stringify(stored));
}

function restoreChatSession() {
    const draft = readSessionValue(CHAT_DRAFT_STORAGE_KEY);
    if (draft) {
        dom.chatInput.value = draft.slice(0, 4000);
        resizeChatInput();
    }
    const rawRun = readSessionValue(CHAT_RUN_STORAGE_KEY);
    if (!rawRun) return;
    try {
        const stored = JSON.parse(rawRun);
        const message = safeText(stored?.message);
        const requestId = safeText(stored?.requestId);
        const createdAt = parseDate(stored?.createdAt)?.toISOString() || new Date().toISOString();
        if (!message || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new Error('Invalid chat run');
        state.chatRun = {
            message,
            requestId,
            createdAt,
            status: 'error',
            error: 'Отправка могла завершиться после закрытия страницы. Безопасно проверьте результат тем же запросом.'
        };
    } catch {
        persistChatRun(null);
    }
}

function getId(record) {
    return String(record?.id ?? record?._id ?? '');
}

async function api(path, options = {}) {
    const request = {
        method: options.method || 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
    };
    if (options.body !== undefined) {
        request.headers['Content-Type'] = 'application/json';
        request.body = JSON.stringify(options.body);
    }

    let response;
    try {
        response = await fetch(`${API_ROOT}${path}`, request);
    } catch {
        throw new ApiError('Нет связи с сервером. Проверьте интернет и попробуйте снова.');
    }

    const contentType = response.headers.get('content-type') || '';
    let payload = {};
    if (response.status !== 204) {
        try {
            if (contentType.includes('application/json')) {
                payload = await response.json();
            } else {
                const text = (await response.text()).trim();
                payload = { error: text && !text.startsWith('<') ? text.slice(0, 300) : '' };
            }
        } catch {
            payload = {};
        }
    }

    if (!response.ok) {
        const message = response.status === 401
            ? 'Войдите в клиентский аккаунт, чтобы открыть Agent Hub.'
            : (payload.error || payload.message || 'Не удалось выполнить запрос. Попробуйте ещё раз.');
        throw new ApiError(message, response.status);
    }
    return payload;
}

function setSystemStatus(type, label) {
    dom.systemStatus.classList.toggle('is-ready', type === 'ready');
    dom.systemStatus.classList.toggle('is-error', type === 'error');
    dom.systemStatus.querySelector('span:last-child').textContent = label;
}

function showGlobalError(error) {
    const message = escapeHtml(error?.message || 'Не удалось загрузить Agent Hub.');
    dom.globalAlert.hidden = false;
    dom.globalAlert.innerHTML = error?.status === 401
        ? `${message} <a href="login.html">Перейти ко входу</a>`
        : `${message} <button class="text-button" type="button" data-retry-all>Повторить</button>`;
    setSystemStatus('error', error?.status === 401 ? 'Нужен вход' : 'Ошибка связи');
}

function clearGlobalError() {
    dom.globalAlert.hidden = true;
    dom.globalAlert.textContent = '';
}

function toast(message, type = 'success') {
    const node = document.createElement('div');
    node.className = `toast${type === 'error' ? ' is-error' : ''}`;
    node.textContent = message;
    dom.toastRegion.appendChild(node);
    window.setTimeout(() => node.remove(), 3800);
}

function setButtonLoading(button, loading, loadingLabel = 'Сохраняю…') {
    if (!button) return;
    if (loading) {
        button.dataset.previousMarkup = button.innerHTML;
        button.textContent = loadingLabel;
        button.disabled = true;
    } else {
        if (button.dataset.previousMarkup) button.innerHTML = button.dataset.previousMarkup;
        button.disabled = false;
        delete button.dataset.previousMarkup;
    }
}

function setFeedback(form, message = '', type = '') {
    const feedback = form?.querySelector('.form-feedback');
    if (!feedback) return;
    feedback.textContent = message;
    feedback.classList.toggle('is-error', type === 'error');
    feedback.classList.toggle('is-success', type === 'success');
}

function readArray(payload, kind) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.records)) return payload.records;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.[kind])) return payload[kind];
    if (Array.isArray(payload?.[`${kind}s`])) return payload[`${kind}s`];
    return [];
}

function normalizeOverviewRecords(records) {
    if (Array.isArray(records)) {
        return {
            note: records.filter(record => record.kind === 'note'),
            event: records.filter(record => record.kind === 'event'),
            transaction: records.filter(record => record.kind === 'transaction')
        };
    }
    if (!records || typeof records !== 'object') return null;
    return {
        note: readArray(records, 'note'),
        event: readArray(records, 'event'),
        transaction: readArray(records, 'transaction')
    };
}

function mergeTelegramConnection(previous, next) {
    if (!next) return next;
    const samePendingBot = !Boolean(next.ownerLinked ?? next.owner_linked)
        && safeText(previous?.username) === safeText(next.username)
        && safeText(previous?.linkCode || previous?.link_code);
    if (!samePendingBot) return next;
    return {
        ...next,
        linkCode: previous.linkCode || previous.link_code,
        linkExpiresAt: previous.linkExpiresAt || previous.link_expires_at,
        deepLink: previous.deepLink || previous.deep_link
    };
}

async function loadOverview({ replaceRecords = true } = {}) {
    const payload = await api('/overview');
    state.user = payload.user || null;
    state.agent = payload.agent || null;
    if (state.agent?.ai) {
        state.connections.openrouter = {
            connected: Boolean(state.agent.ai.keyConfigured),
            model: state.agent.model || ''
        };
    }
    if (state.agent?.telegram) {
        state.connections.telegram = mergeTelegramConnection(state.connections.telegram, state.agent.telegram);
    }
    state.messages = Array.isArray(payload.messages) ? payload.messages : [];
    state.summary = payload.summary || {};
    const overviewRecords = normalizeOverviewRecords(payload.records);
    if (overviewRecords) {
        state.dashboardRecords = {
            note: [...overviewRecords.note],
            event: [...overviewRecords.event],
            transaction: [...overviewRecords.transaction]
        };
        if (replaceRecords) {
            state.records = {
                note: [...overviewRecords.note],
                event: [...overviewRecords.event],
                transaction: [...overviewRecords.transaction]
            };
            Object.keys(RECORD_PAGE_SIZES).forEach(kind => {
                const size = RECORD_PAGE_SIZES[kind];
                state.paging[kind] = {
                    ...pagingState(),
                    offset: overviewRecords[kind].length,
                    hasMore: overviewRecords[kind].length === size
                };
            });
            state.eventMode = 'upcoming';
            if (dom.eventFilter) dom.eventFilter.value = 'upcoming';
        }
    }
    state.errors.overview = null;
    ['note', 'event', 'transaction'].forEach(kind => { state.errors[kind] = null; });
    renderIdentity();
    renderAgent();
}

function mergeRecords(existing, incoming) {
    const seen = new Set(existing.map(getId).filter(Boolean));
    return [...existing, ...incoming.filter(record => {
        const id = getId(record);
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
    })];
}

async function loadRecords(kind, { render = true, append = false, search, mode } = {}) {
    if (!RECORD_PAGE_SIZES[kind]) throw new Error('Неизвестный раздел данных.');
    const page = state.paging[kind];
    const request = ++page.request;
    const limit = RECORD_PAGE_SIZES[kind];
    const offset = append ? page.offset : 0;
    const query = new URLSearchParams({ kind, limit: String(limit), offset: String(offset) });
    const searchTerm = kind === 'note'
        ? String(search ?? dom.notesSearch?.value ?? '').trim()
        : '';
    if (searchTerm) query.set('search', searchTerm);
    const eventMode = kind === 'event'
        ? (mode === 'past' || (!mode && state.eventMode === 'past') ? 'past' : 'upcoming')
        : '';
    if (eventMode) query.set(eventMode, '1');

    page.loading = true;
    if (render) renderRecords(kind);
    try {
        const payload = await api(`/records?${query.toString()}`);
        const records = readArray(payload, kind);
        if (page !== state.paging[kind] || request !== page.request) return state.records[kind];
        if (kind === 'event' && eventMode !== state.eventMode) return state.records[kind];
        if (kind === 'note' && searchTerm !== String(dom.notesSearch?.value ?? '').trim()) return state.records[kind];
        state.records[kind] = append ? mergeRecords(state.records[kind], records) : records;
        page.offset = append ? offset + records.length : records.length;
        page.hasMore = records.length === limit;
        page.loading = false;
        state.errors[kind] = null;
        if (render) renderRecords(kind);
        return state.records[kind];
    } catch (error) {
        if (page !== state.paging[kind] || request !== page.request) return state.records[kind];
        if (request === page.request) {
            page.loading = false;
            if (render) renderRecords(kind);
        }
        throw error;
    }
}

async function loadConnections() {
    const payload = await api('/connections?models=1');
    state.models = Array.isArray(payload.models) ? payload.models : [];
    const connections = payload.connections || {};
    if (payload.openrouter !== undefined || connections.openrouter !== undefined) {
        state.connections.openrouter = payload.openrouter ?? connections.openrouter;
    }
    if (payload.telegram !== undefined || connections.telegram !== undefined) {
        state.connections.telegram = payload.telegram ?? connections.telegram;
    }
    if (payload.agent && !state.agent) state.agent = payload.agent;
    renderConnections();
}

async function loadGoogleCalendarStatus({ render = true } = {}) {
    try {
        state.connections.googleCalendar = await api('/google-calendar');
        state.errors.googleCalendar = null;
        if (render) renderGoogleCalendarConnection();
        return state.connections.googleCalendar;
    } catch (error) {
        state.errors.googleCalendar = error;
        if (render) renderGoogleCalendarConnection();
        throw error;
    }
}

async function loadAll({ announce = false } = {}) {
    setSystemStatus('loading', 'Синхронизация…');
    dom.refreshButton.disabled = true;
    if (announce) state.googleCalendarFeedback = null;
    window.clearTimeout(noteSearchTimer);
    dom.notesSearch.value = '';
    clearGlobalError();

    const tasks = [loadOverview(), loadConnections(), loadGoogleCalendarStatus()];
    const results = await Promise.allSettled(tasks);
    const rejected = results.filter(result => result.status === 'rejected');

    state.errors.overview = results[0].status === 'rejected' ? results[0].reason : null;
    state.errors.connections = results[1].status === 'rejected' ? results[1].reason : null;
    state.errors.googleCalendar = results[2].status === 'rejected' ? results[2].reason : null;
    ['note', 'event', 'transaction'].forEach(kind => { state.errors[kind] = state.errors.overview; });

    if (results[0].status === 'rejected') {
        showGlobalError(results[0].reason);
    } else {
        state.loaded = true;
    }

    renderIdentity();
    renderAgent();

    renderNotes();
    renderCalendar();
    renderFinance();
    if (results[1].status === 'rejected') renderConnectionsError(results[1].reason);
    else renderConnections();
    renderGoogleCalendarConnection();

    if (!rejected.length) {
        setSystemStatus('ready', 'Всё синхронизировано');
        if (announce) toast('Данные обновлены');
    } else if (results[0].status !== 'rejected') {
        setSystemStatus('error', 'Часть данных недоступна');
        if (announce) toast('Некоторые разделы не обновились', 'error');
    }
    dom.refreshButton.disabled = false;
    announceGoogleCalendarReturn();
}

function renderIdentity() {
    const user = state.user || {};
    const displayName = safeText(user.name || user.displayName || user.login, 'Мой аккаунт');
    const email = safeText(user.email || user.login, 'Клиент SHAIKH');
    dom.userName.textContent = displayName;
    dom.userEmail.textContent = email;
    dom.userAvatar.textContent = initials(displayName);
}

function initials(value) {
    const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
    return (parts.slice(0, 2).map(part => part[0]).join('') || 'S').toUpperCase();
}

function renderAgent() {
    const agent = state.agent || {};
    const aiReady = connectionIsOn(state.connections.openrouter) || Boolean(agent.ai?.keyConfigured ?? agent.ai?.configured);
    const chatNeedsResolution = Boolean(state.chatRun);
    dom.agentName.textContent = safeText(agent.name, 'SHAIKH Agent');
    dom.agentModel.textContent = aiReady ? (modelName(agent.model) || 'AI подключён') : 'Нужно подключить AI';
    dom.agentLiveDot.classList.toggle('is-off', !aiReady);
    dom.chatForm.classList.toggle('is-locked', !aiReady);
    dom.chatLockCta.hidden = aiReady;
    dom.chatInput.disabled = !aiReady || chatNeedsResolution;
    dom.chatSubmit.disabled = !aiReady || chatNeedsResolution;
    dom.chatInput.placeholder = aiReady
        ? 'Например: запиши расход 8 500 ₸ на рекламу…'
        : 'Сначала подключите OpenRouter — это займёт около минуты';
    renderActivation();
    renderMessages();
    renderToday();
}

function activationState() {
    const agent = state.agent || {};
    const instructions = safeText(agent.instructions || agent.systemPrompt || agent.system_prompt);
    const profileReady = Boolean(instructions || (safeText(agent.name) && safeText(agent.name) !== 'SHAIKH Agent'));
    const aiReady = connectionIsOn(state.connections.openrouter) || Boolean(agent.ai?.keyConfigured ?? agent.ai?.configured);
    const firstResultReady = state.dashboardRecords.note.length + state.dashboardRecords.event.length + state.dashboardRecords.transaction.length > 0
        || state.messages.some(message => message.role === 'assistant' && Array.isArray(message.actions) && message.actions.length);
    return { profileReady, aiReady, firstResultReady };
}

function renderActivation() {
    const status = activationState();
    const steps = [
        { done: status.profileReady, label: 'Выберите роль', copy: status.profileReady ? 'Агент настроен' : 'Имя и стиль работы', target: 'profile-form' },
        { done: status.aiReady, label: 'Подключите AI', copy: status.aiReady ? 'OpenRouter готов' : 'Ваш ключ — ваши расходы', target: 'openrouter-card' },
        { done: status.firstResultReady, label: 'Запустите сценарий', copy: status.firstResultReady ? 'Первый результат готов' : 'Выберите карточку ниже', target: 'workflow-grid' }
    ];
    const completed = steps.filter(step => step.done).length;
    dom.activationProgress.textContent = `${completed}/3`;
    dom.activationPanel.classList.toggle('is-complete', completed === steps.length);
    dom.activationTitle.textContent = completed === steps.length ? 'Агент готов к работе' : 'Запустите первого помощника';
    dom.activationCopy.textContent = completed === steps.length
        ? 'Выберите готовый сценарий или поставьте задачу своими словами.'
        : 'Три коротких шага — и агент начнёт выполнять задачи, а не просто отвечать.';
    dom.activationSteps.innerHTML = steps.map((step, index) => `
        <button class="activation-step${step.done ? ' is-done' : ''}" type="button" data-setup-target="${escapeHtml(step.target)}">
            <span class="activation-step__number">${step.done ? '✓' : index + 1}</span>
            <span><strong>${escapeHtml(step.label)}</strong><small>${escapeHtml(step.copy)}</small></span>
        </button>`).join('');
}

function renderMessages() {
    const messages = state.hiddenHistory ? [] : state.messages;
    const run = state.chatRun;
    const runMessageVisible = run && messages.some(message => (
        message.clientRequestId === run.requestId
        || (message.role === 'user'
            && message.channel !== 'telegram'
            && safeText(message.content || message.text) === run.message
            && Math.abs((parseDate(message.createdAt || message.created_at)?.getTime() || 0) - (parseDate(run.createdAt)?.getTime() || 0)) < 15 * 60 * 1000)
    ));
    const visibleMessages = run && !runMessageVisible
        ? [...messages, { role: 'user', channel: 'web', content: run.message, createdAt: run.createdAt, clientRequestId: run.requestId }]
        : messages;
    dom.chatFeed.setAttribute('aria-busy', String(run?.status === 'pending'));
    if (!visibleMessages.length && !run) {
        const name = safeText(state.user?.name || state.user?.displayName, 'друг');
        const aiReady = activationState().aiReady;
        dom.chatFeed.innerHTML = `
            <div class="chat-message">
                <span class="message-avatar">AI</span>
                <div class="message-body">
                    <div class="message-bubble">${aiReady
                        ? `Привет, ${escapeHtml(name)}! Я готов помочь с заметками, планами и личными финансами. Выберите сценарий выше или напишите задачу своими словами.`
                        : `Привет, ${escapeHtml(name)}! Подключите OpenRouter в шаге выше — после этого я смогу выполнять задачи и работать с вашими данными.`}</div>
                    <div class="message-meta"><time>Сейчас</time><span class="message-channel">Сайт</span></div>
                </div>
            </div>`;
        return;
    }
    dom.chatFeed.innerHTML = visibleMessages.map(messageTemplate).join('') + (run ? chatRunTemplate(run) : '');
    dom.chatFeed.scrollTop = dom.chatFeed.scrollHeight;
}

function messageTemplate(message) {
    const role = message.role === 'user' ? 'user' : 'assistant';
    const content = safeText(message.content || message.text || message.reply);
    const actions = Array.isArray(message.actions) ? message.actions : [];
    const actionHtml = actions.length
        ? `<div class="message-actions">${actions.map(action => {
            const kind = actionKind(action);
            const target = ({ note: 'notes', event: 'calendar', transaction: 'finance' })[kind] || '';
            return target
                ? `<button class="action-chip" type="button" data-result-view="${target}">✓ ${escapeHtml(actionLabel(action))} · открыть</button>`
                : `<span class="action-chip">✓ ${escapeHtml(actionLabel(action))}</span>`;
        }).join('')}</div>`
        : '';
    const channel = message.channel === 'telegram' ? 'Telegram' : 'Сайт';
    return `
        <div class="chat-message${role === 'user' ? ' is-user' : ''}">
            <span class="message-avatar">${role === 'user' ? escapeHtml(initials(state.user?.name || 'Вы')) : 'AI'}</span>
            <div class="message-body">
                <div class="message-bubble">${escapeHtml(content)}</div>
                ${actionHtml}
                <div class="message-meta"><time>${escapeHtml(formatTime(message.createdAt || message.created_at))}</time><span class="message-channel">${channel}</span></div>
            </div>
        </div>`;
}

function actionLabel(action) {
    if (typeof action === 'string') return action;
    const toolLabel = {
        save_note: 'Заметка сохранена',
        list_notes: 'Заметки найдены',
        schedule_event: 'Событие добавлено',
        list_events: 'Планы показаны',
        record_transaction: 'Операция записана',
        finance_summary: 'Финансы рассчитаны'
    }[action.tool];
    if (toolLabel) return toolLabel;
    return action.label || action.title || action.message || ({
        note: 'Заметка сохранена', event: 'Событие добавлено', transaction: 'Операция записана'
    }[actionKind(action)] || 'Действие выполнено');
}

function actionKind(action) {
    if (!action || typeof action !== 'object') return '';
    if (['note', 'event', 'transaction'].includes(action.kind || action.type)) return action.kind || action.type;
    return ({
        save_note: 'note',
        list_notes: 'note',
        schedule_event: 'event',
        list_events: 'event',
        record_transaction: 'transaction',
        finance_summary: 'transaction'
    })[action.tool] || '';
}

function chatRunTemplate(run) {
    if (run.status === 'error') {
        return `<div class="chat-run-error" role="alert">
            <span class="chat-run-error__icon" aria-hidden="true">!</span>
            <div class="chat-run-error__copy">
                <strong>Результат не подтверждён</strong>
                <p>${escapeHtml(run.error || 'Связь прервалась. Запрос можно безопасно повторить.')}</p>
                <div class="chat-run-error__actions">
                    <button class="secondary-button" type="button" data-chat-retry>Повторить безопасно</button>
                    <button class="text-button" type="button" data-chat-edit>Изменить текст</button>
                </div>
            </div>
        </div>`;
    }
    return `<div class="chat-message is-pending" id="pending-agent-message">
        <span class="message-avatar">AI</span><div class="message-body"><div class="message-bubble"><div class="run-progress">
            <span class="run-step is-done">Запрос принят</span><span class="run-divider">→</span>
            <span class="run-step is-active">Агент работает</span><span class="run-divider">→</span>
            <span class="run-step">Подтверждение</span>
        </div></div></div>
    </div>`;
}

async function submitChat(event) {
    event.preventDefault();
    if (!activationState().aiReady) {
        openSetupTarget('openrouter-card');
        toast('Сначала подключите OpenRouter', 'error');
        return;
    }
    const message = dom.chatInput.value.trim();
    if (!message || dom.chatSubmit.disabled) return;
    if (state.chatRun) {
        toast(state.chatRun.status === 'pending'
            ? 'Дождитесь результата текущего запроса'
            : 'Сначала повторите запрос или верните его в поле для изменения', 'error');
        return;
    }
    const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const run = { message, requestId, createdAt: new Date().toISOString(), status: 'pending', error: '' };
    state.hiddenHistory = false;
    state.chatRun = run;
    persistChatRun(run);
    dom.chatInput.value = '';
    saveChatDraft('');
    resizeChatInput();
    state.messages.push({ role: 'user', channel: 'web', content: message, createdAt: run.createdAt, clientRequestId: requestId });
    renderMessages();
    await sendChatRun(run);
}

async function retryChatRun() {
    const run = state.chatRun;
    if (!run || run.status === 'pending') return;
    state.hiddenHistory = false;
    await sendChatRun(run);
}

function editChatRun() {
    const run = state.chatRun;
    if (!run) return;
    state.messages = state.messages.filter(message => message.clientRequestId !== run.requestId);
    dom.chatInput.value = run.message;
    saveChatDraft(run.message);
    state.chatRun = null;
    persistChatRun(null);
    resizeChatInput();
    renderAgent();
    dom.chatInput.focus();
    dom.chatInput.setSelectionRange(dom.chatInput.value.length, dom.chatInput.value.length);
}

async function sendChatRun(run) {
    if (!run || state.chatRun?.requestId !== run.requestId) return;
    state.chatRun = { ...run, status: 'pending', error: '' };
    persistChatRun(state.chatRun);
    renderMessages();
    dom.chatInput.disabled = true;
    setButtonLoading(dom.chatSubmit, true, '…');

    try {
        const payload = await api('/chat', { method: 'POST', body: { message: run.message, requestId: run.requestId } });
        if (state.chatRun?.requestId !== run.requestId) return;
        if (payload.busy) throw new ApiError('Запрос ещё обрабатывается. Подождите несколько секунд и повторите проверку.', 409);
        if (payload.duplicate && !payload.reply) {
            await loadOverview();
            state.chatRun = null;
            persistChatRun(null);
            renderNotes();
            renderCalendar();
            renderFinance();
            renderMessages();
            toast('Результат синхронизирован');
            return;
        }
        const actions = Array.isArray(payload.actions) ? payload.actions : [];
        state.messages.push({
            role: 'assistant',
            content: payload.reply || 'Готово.',
            channel: 'web',
            actions,
            createdAt: new Date().toISOString()
        });
        state.chatRun = null;
        persistChatRun(null);
        renderMessages();
        actions.forEach(action => {
            if (!action?.record) return;
            const kind = actionKind(action);
            if (!state.records[kind]) return;
            storeRecord(kind, action.record);
            storeDashboardRecord(kind, action.record);
            if (kind === 'event' && !eventMatchesMode(action.record, state.eventMode)) {
                state.records.event = state.records.event.filter(item => getId(item) !== getId(action.record));
            }
        });
        const touchedKinds = new Set(actions.map(actionKind));
        if (touchedKinds.has('transaction')) {
            await loadOverview({ replaceRecords: false });
            renderNotes();
            renderCalendar();
            renderFinance();
        } else {
            await Promise.all([...touchedKinds].filter(kind => state.records[kind]).map(kind => loadRecords(kind, {
                mode: kind === 'event' ? state.eventMode : undefined
            })));
            renderToday();
            renderActivation();
        }
    } catch (error) {
        if (state.chatRun?.requestId !== run.requestId) return;
        state.chatRun = { ...run, status: 'error', error: error.message };
        persistChatRun(state.chatRun);
        renderMessages();
        toast(error.message, 'error');
    } finally {
        setButtonLoading(dom.chatSubmit, false);
        const chatNeedsResolution = Boolean(state.chatRun);
        dom.chatInput.disabled = !activationState().aiReady || chatNeedsResolution;
        dom.chatSubmit.disabled = !activationState().aiReady || chatNeedsResolution;
        if (location.hash === '#agent' && !dom.chatInput.disabled && state.chatRun?.status !== 'error') dom.chatInput.focus();
    }
}

function renderToday() {
    const now = new Date();
    dom.todayDate.textContent = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' }).format(now);
    const todayKey = dateKey(now);
    const todayEvents = state.dashboardRecords.event.filter(record => dateKey(eventDate(record)) === todayKey);
    const todayTransactions = state.dashboardRecords.transaction.filter(record => dateKey(transactionDate(record)) === todayKey);
    const expenseToday = todayTransactions.filter(record => transactionType(record) === 'expense').reduce((sum, record) => sum + numberValue(record.amount), 0);
    const notesCount = numberValue(state.summary.notesToday ?? state.summary.notes_today) || state.dashboardRecords.note.filter(record => dateKey(record.createdAt || record.created_at) === todayKey).length;
    dom.todaySummary.innerHTML = [
        metricTemplate(iconCalendar(), 'События', 'сегодня', todayEvents.length),
        metricTemplate(iconNote(), 'Новые заметки', 'сегодня', notesCount),
        metricTemplate(iconWallet(), 'Расходы', 'сегодня', formatMoney(expenseToday, true))
    ].join('');

    const next = state.dashboardRecords.event
        .filter(record => eventDate(record)?.getTime() >= now.getTime() - 60000)
        .sort((a, b) => eventDate(a) - eventDate(b))[0];
    dom.nextRecord.innerHTML = next
        ? `<div class="next-record"><strong>${escapeHtml(recordTitle(next, 'Событие'))}</strong><span>${escapeHtml(formatEventDate(eventDate(next)))}</span></div>`
        : emptyCompact('Ближайших событий пока нет.');
}

function metricTemplate(icon, label, sublabel, value) {
    return `<div class="today-metric"><span class="today-metric__icon">${icon}</span><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(sublabel)}</small></span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderRecords(kind) {
    if (kind === 'note') renderNotes();
    if (kind === 'event') renderCalendar();
    if (kind === 'transaction') renderFinance();
    renderToday();
}

function loadMoreControl(kind) {
    const page = state.paging[kind];
    if (!page?.hasMore) return '';
    const label = page.loading ? 'Загружаю…' : 'Показать ещё';
    return `<div class="load-more-row"><button class="secondary-button" type="button" data-load-more="${kind}"${page.loading ? ' disabled' : ''}>${label}</button></div>`;
}

function renderNotes() {
    if (state.errors.note) {
        dom.notesCount.textContent = 'Ошибка загрузки';
        dom.notesList.setAttribute('aria-busy', 'false');
        dom.notesList.innerHTML = errorState(state.errors.note.message);
        return;
    }
    const query = (dom.notesSearch?.value || '').trim().toLowerCase();
    const notes = state.records.note
        .filter(note => !query || `${recordTitle(note)} ${recordBody(note)}`.toLowerCase().includes(query))
        .sort((a, b) => recordDate(b) - recordDate(a));
    dom.notesCount.textContent = `${notes.length}${state.paging.note.hasMore ? '+' : ''} ${plural(notes.length, ['заметка', 'заметки', 'заметок'])}`;
    dom.notesList.setAttribute('aria-busy', 'false');
    if (!notes.length) {
        dom.notesList.innerHTML = emptyState(
            iconNote(),
            query ? 'Ничего не найдено' : 'Заметок пока нет',
            query ? 'Попробуйте другой запрос.' : 'Сохраните первую мысль с агентом или вручную.',
            query ? {} : { prompt: 'Сохрани заметку: ', form: 'note-form-wrap' }
        );
        return;
    }
    dom.notesList.innerHTML = notes.map(note => `<article class="record-card">
            <div class="record-card__meta"><span>${escapeHtml(formatShortDate(recordDate(note)))}</span><span>Заметка</span></div>
            <h3>${escapeHtml(recordTitle(note, 'Без заголовка'))}</h3>
            <p>${escapeHtml(recordBody(note, 'Пустая заметка'))}</p>
            ${cardActions('note', getId(note))}
        </article>`).join('') + loadMoreControl('note');
}

function renderCalendar() {
    const isPast = state.eventMode === 'past';
    dom.calendarStrip.hidden = isPast;
    dom.calendarListTitle.textContent = isPast ? 'Прошедшие события' : 'Ближайшие события';
    renderCalendarStrip();
    if (state.errors.event) {
        dom.eventsCount.textContent = 'Ошибка загрузки';
        dom.eventsList.setAttribute('aria-busy', 'false');
        dom.eventsList.innerHTML = errorState(state.errors.event.message);
        return;
    }
    const events = [...state.records.event].sort((a, b) => isPast ? eventDate(b) - eventDate(a) : eventDate(a) - eventDate(b));
    dom.eventsCount.textContent = `${events.length}${state.paging.event.hasMore ? '+' : ''} ${plural(events.length, ['событие', 'события', 'событий'])}`;
    dom.eventsList.setAttribute('aria-busy', 'false');
    if (!events.length) {
        dom.eventsList.innerHTML = isPast
            ? emptyState(iconCalendar(), 'Прошедших событий нет', 'Здесь появится история завершённых встреч и задач.')
            : emptyState(iconCalendar(), 'Планов пока нет', 'Добавьте первое событие с агентом или вручную.', { prompt: 'Запланируй событие: ', form: 'event-form-wrap' });
        return;
    }
    dom.eventsList.innerHTML = events.map(record => {
        const date = eventDate(record);
        return `<article class="timeline-item">
            <time class="timeline-time">${escapeHtml(date ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date) : 'Без даты')}</time>
            <span class="timeline-dot" aria-hidden="true"></span>
            <div class="timeline-copy"><strong>${escapeHtml(recordTitle(record, 'Событие'))}</strong><small>${escapeHtml(recordBody(record, 'Без описания'))}</small></div>
            ${cardActions('event', getId(record))}
        </article>`;
    }).join('') + loadMoreControl('event');
}

function renderCalendarStrip() {
    const today = startOfDay(new Date());
    dom.calendarStrip.innerHTML = Array.from({ length: 7 }, (_, index) => {
        const date = new Date(today);
        date.setDate(today.getDate() + index);
        const hasEvent = state.records.event.some(record => dateKey(eventDate(record)) === dateKey(date));
        return `<div class="day-chip${index === 0 ? ' is-today' : ''}${hasEvent ? ' has-event' : ''}"><small>${escapeHtml(new Intl.DateTimeFormat('ru-RU', { weekday: 'short' }).format(date))}</small><strong>${date.getDate()}</strong><span></span></div>`;
    }).join('');
}

function renderFinance() {
    renderTransactionCsvImport();
    const transactions = [...state.records.transaction].sort((a, b) => transactionDate(b) - transactionDate(a));
    const currentMonth = monthKey(new Date());
    const monthly = transactions.filter(record => monthKey(transactionDate(record)) === currentMonth);
    const monthIncome = monthly.filter(record => transactionType(record) === 'income').reduce((sum, record) => sum + numberValue(record.amount), 0);
    const monthExpense = monthly.filter(record => transactionType(record) === 'expense').reduce((sum, record) => sum + numberValue(record.amount), 0);
    const balance = transactions.reduce((sum, record) => sum + (transactionType(record) === 'income' ? numberValue(record.amount) : -numberValue(record.amount)), 0);
    dom.balanceValue.textContent = formatMoney(state.summary.balance ?? balance);
    dom.incomeValue.textContent = `+ ${formatMoney(state.summary.monthIncome ?? state.summary.month_income ?? monthIncome)}`;
    dom.expenseValue.textContent = `− ${formatMoney(state.summary.monthExpense ?? state.summary.month_expense ?? monthExpense)}`;
    if (state.errors.transaction) {
        dom.transactionsList.setAttribute('aria-busy', 'false');
        dom.transactionsList.innerHTML = errorState(state.errors.transaction.message);
        return;
    }
    renderTransactions(transactions);
}

function renderTransactions(source = state.records.transaction) {
    const filter = dom.transactionFilter.value;
    const transactions = source.filter(record => filter === 'all' || transactionType(record) === filter);
    dom.transactionsList.setAttribute('aria-busy', 'false');
    if (!transactions.length) {
        dom.transactionsList.innerHTML = emptyState(
            iconWallet(),
            filter === 'all' ? 'Операций пока нет' : 'Нет операций этого типа',
            'Запишите сумму с агентом или вручную.',
            filter === 'all' ? { prompt: 'Запиши расход: ', form: 'transaction-form-wrap' } : {}
        ) + loadMoreControl('transaction');
        return;
    }
    dom.transactionsList.innerHTML = transactions.map(record => {
        const type = transactionType(record);
        const sign = type === 'income' ? '+' : '−';
        return `<article class="transaction-item${type === 'income' ? ' is-income' : ''}">
            <span class="transaction-icon">${type === 'income' ? '↙' : '↗'}</span>
            <div class="transaction-copy"><strong>${escapeHtml(safeText(record.category, type === 'income' ? 'Доход' : 'Расход'))}</strong><small>${escapeHtml(`${formatShortDate(transactionDate(record))}${recordBody(record) ? ` · ${recordBody(record)}` : ''}`)}</small></div>
            <strong class="transaction-amount">${sign} ${escapeHtml(formatMoney(record.amount))}</strong>
            ${cardActions('transaction', getId(record))}
        </article>`;
    }).join('') + loadMoreControl('transaction');
}

function csvPreviewTable(rows) {
    const preview = rows.slice(0, CSV_PREVIEW_LIMIT);
    return `<div class="csv-preview-table" tabindex="0" role="region" aria-label="Предпросмотр операций">
        <table>
            <caption class="sr-only">Первые ${preview.length} операций из CSV</caption>
            <thead><tr><th>Дата</th><th>Описание</th><th>Тип</th><th>Сумма</th></tr></thead>
            <tbody>${preview.map(row => `<tr>
                <td>${escapeHtml(inputDate(row.occurredAt))}</td>
                <td><strong>${escapeHtml(row.title)}</strong><small>${escapeHtml(row.category)}</small></td>
                <td><span class="csv-type is-${row.transactionType === 'income' ? 'income' : 'expense'}">${row.transactionType === 'income' ? 'Доход' : 'Расход'}</span></td>
                <td>${escapeHtml(formatMoneyPrecise(row.amount))}</td>
            </tr>`).join('')}</tbody>
        </table>
        ${rows.length > preview.length ? `<p class="csv-preview-more">И ещё ${rows.length - preview.length} ${plural(rows.length - preview.length, ['операция', 'операции', 'операций'])}.</p>` : ''}
    </div>`;
}

function renderTransactionCsvImport() {
    const current = state.csvImport;
    if (!dom.transactionCsvPreview) return;
    const busy = current.parsing || current.submitting;
    const canSubmit = current.rows.length > 0 && current.errors.length === 0 && !current.error && !current.result && !busy;
    dom.transactionCsvFile.disabled = busy;
    dom.transactionCsvPicker.disabled = busy;
    dom.transactionCsvSubmit.disabled = !canSubmit;
    dom.transactionCsvSubmit.textContent = current.submitting
        ? 'Импортирую…'
        : (current.rows.length ? `Импортировать ${current.rows.length}` : 'Импортировать');
    dom.transactionCsvStatus.classList.toggle('is-error', Boolean(current.error || current.errors.length || current.submitError));
    dom.transactionCsvStatus.classList.toggle('is-success', Boolean(current.result));

    if (current.parsing) {
        dom.transactionCsvStatus.textContent = `Проверяю ${current.fileName || 'CSV-файл'}…`;
        dom.transactionCsvPreview.innerHTML = '<div class="csv-preview-empty"><span class="loader"></span><span>Читаю файл локально</span></div>';
        return;
    }
    if (current.error) {
        dom.transactionCsvStatus.textContent = current.error;
        dom.transactionCsvPreview.innerHTML = '<div class="csv-preview-empty is-error">Файл не отправлялся на сервер.</div>';
        return;
    }
    if (current.result) {
        const imported = numberValue(current.result.imported);
        const duplicates = numberValue(current.result.duplicates);
        dom.transactionCsvStatus.textContent = imported
            ? `Импорт завершён: добавлено ${imported} ${plural(imported, ['операция', 'операции', 'операций'])}.`
            : 'Новых операций не добавлено.';
        dom.transactionCsvPreview.innerHTML = `<div class="csv-import-result">
            <strong>${imported ? 'Готово' : 'Файл уже был учтён'}</strong>
            <span>Добавлено: ${imported}${duplicates ? ` · повторов пропущено: ${duplicates}` : ''}</span>
        </div>`;
        return;
    }
    if (!current.fileName) {
        dom.transactionCsvStatus.textContent = 'Нужны столбцы: дата, описание, сумма и тип доход/расход.';
        dom.transactionCsvPreview.innerHTML = '<div class="csv-preview-empty">Выберите CSV — здесь появится локальный предпросмотр до отправки.</div>';
        return;
    }

    const validCopy = `${current.fileName}: распознано ${current.rows.length} из ${current.rows.length + current.errors.length} строк.`;
    dom.transactionCsvStatus.textContent = current.errors.length
        ? `${validCopy} Исправьте ошибки — пока файл не будет отправлен.`
        : `${validCopy} Проверьте операции и подтвердите импорт.`;
    const errorList = current.errors.length
        ? `<div class="csv-error-box" role="alert"><strong>Строки с ошибками</strong><ul>${current.errors.slice(0, 8).map(error => `<li>Строка ${error.line}: ${escapeHtml(error.message)}</li>`).join('')}</ul>${current.errors.length > 8 ? `<p>И ещё ${current.errors.length - 8}.</p>` : ''}</div>`
        : '';
    const submitError = current.submitError
        ? `<div class="csv-error-box" role="alert"><strong>Импорт не завершён</strong><p>${escapeHtml(current.submitError)} Строки сохранены в предпросмотре — можно повторить.</p></div>`
        : '';
    dom.transactionCsvPreview.innerHTML = `${submitError}${errorList}${current.rows.length ? csvPreviewTable(current.rows) : ''}`;
}

async function selectTransactionCsv(event) {
    const file = event.currentTarget.files?.[0];
    if (!file) {
        state.csvImport = csvImportState();
        renderTransactionCsvImport();
        return;
    }
    state.csvImport = { ...csvImportState(), fileName: file.name, parsing: true };
    renderTransactionCsvImport();
    try {
        if (file.size > MAX_FILE_BYTES) throw new Error('CSV-файл больше 1 МБ. Выберите файл поменьше.');
        const parsed = parseTransactionCsv(await file.text());
        state.csvImport = {
            ...csvImportState(),
            fileName: file.name,
            rows: parsed.rows,
            errors: parsed.errors
        };
    } catch (error) {
        state.csvImport = { ...csvImportState(), fileName: file.name, error: error.message || 'Не удалось прочитать CSV-файл.' };
    }
    renderTransactionCsvImport();
}

function downloadTransactionCsvTemplate() {
    const template = [
        'Дата;Описание;Сумма;Тип;Категория;Комментарий',
        '23.10.2026;Кофе;1250;Расход;Еда;Встреча с клиентом',
        '23.10.2026;Оплата проекта;100000;Доход;Работа;'
    ].join('\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${template}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'shaikh-finance-template.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function submitTransactionCsvImport() {
    const current = state.csvImport;
    if (!current.rows.length || current.errors.length || current.error || current.submitting || current.result) return;
    const rows = current.rows.map(row => ({ ...row }));
    state.csvImport = { ...current, submitting: true, submitError: '' };
    renderTransactionCsvImport();
    let payload;
    try {
        payload = await api('/import', { method: 'POST', body: { action: 'transaction_csv', rows } });
    } catch (error) {
        state.csvImport = { ...state.csvImport, submitting: false, submitError: error.message };
        renderTransactionCsvImport();
        toast(error.message, 'error');
        return;
    }

    state.csvImport = { ...state.csvImport, rows: [], submitting: false, result: payload };
    renderTransactionCsvImport();
    const imported = numberValue(payload.imported);
    const duplicates = numberValue(payload.duplicates);
    toast(imported
        ? `Добавлено ${imported} ${plural(imported, ['операция', 'операции', 'операций'])}`
        : (duplicates ? 'Повторы найдены и безопасно пропущены' : 'Импорт завершён'));
    try {
        await loadOverview();
        renderFinance();
    } catch {
        toast('Импорт завершён, но обзор не обновился. Нажмите «Обновить данные».', 'error');
    }
}

function cardActions(kind, id) {
    if (!id) return '';
    return `<div class="card-actions"><button class="card-action" type="button" data-record-edit="${kind}" data-record-id="${escapeHtml(id)}">Изменить</button><button class="card-action is-danger" type="button" data-record-delete="${kind}" data-record-id="${escapeHtml(id)}">Удалить</button></div>`;
}

function emptyState(icon, title, copy, actions = {}) {
    const controls = actions.prompt || actions.form
        ? `<div class="empty-state__actions">
            ${actions.prompt ? `<button type="button" data-empty-workflow="${escapeHtml(actions.prompt)}">Сделать с агентом</button>` : ''}
            ${actions.form ? `<button type="button" data-empty-manual="${escapeHtml(actions.form)}">Добавить вручную</button>` : ''}
        </div>`
        : '';
    return `<div class="empty-state"><div><span class="empty-state__icon">${icon}</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(copy)}</p>${controls}</div></div>`;
}

function emptyCompact(message) {
    return `<div class="next-record"><strong>${escapeHtml(message)}</strong><span>Можно добавить через чат или календарь.</span></div>`;
}

function errorState(message) {
    return `<div class="error-state"><span>${escapeHtml(message)}</span></div>`;
}

function updateTransactionSummary(previous, next) {
    const transactions = state.records.transaction;
    const currentMonth = monthKey(new Date());
    const existingBalance = transactions.reduce((sum, item) => sum + (transactionType(item) === 'income' ? numberValue(item.amount) : -numberValue(item.amount)), 0);
    const existingMonthly = transactions.filter(item => monthKey(transactionDate(item)) === currentMonth);
    const existingIncome = existingMonthly.filter(item => transactionType(item) === 'income').reduce((sum, item) => sum + numberValue(item.amount), 0);
    const existingExpense = existingMonthly.filter(item => transactionType(item) === 'expense').reduce((sum, item) => sum + numberValue(item.amount), 0);
    let balance = numberValue(state.summary.balance ?? existingBalance);
    let monthIncome = numberValue(state.summary.monthIncome ?? state.summary.month_income ?? existingIncome);
    let monthExpense = numberValue(state.summary.monthExpense ?? state.summary.month_expense ?? existingExpense);

    const apply = (record, direction) => {
        if (!record) return;
        const amount = numberValue(record.amount) * direction;
        if (transactionType(record) === 'income') balance += amount;
        else balance -= amount;
        if (monthKey(transactionDate(record)) !== currentMonth) return;
        if (transactionType(record) === 'income') monthIncome += amount;
        else monthExpense += amount;
    };
    apply(previous, -1);
    apply(next, 1);
    state.summary = { ...state.summary, balance, monthIncome, monthExpense };
}

function storeRecord(kind, record) {
    if (!record) return;
    const id = getId(record);
    const index = state.records[kind].findIndex(item => getId(item) === id);
    if (index >= 0) state.records[kind][index] = record;
    else state.records[kind].unshift(record);
}

function eventMatchesMode(record, mode) {
    const timestamp = eventDate(record)?.getTime();
    if (!Number.isFinite(timestamp)) return mode !== 'past';
    return mode === 'past' ? timestamp < Date.now() : timestamp >= Date.now();
}

function storeDashboardRecord(kind, record) {
    if (!record || !state.dashboardRecords[kind]) return;
    const id = getId(record);
    const records = state.dashboardRecords[kind].filter(item => !id || getId(item) !== id);
    if (kind !== 'event' || eventMatchesMode(record, 'upcoming')) records.push(record);
    records.sort((a, b) => {
        if (kind === 'event') return eventDate(a) - eventDate(b);
        if (kind === 'transaction') return transactionDate(b) - transactionDate(a);
        return recordDate(b) - recordDate(a);
    });
    state.dashboardRecords[kind] = records.slice(0, RECORD_PAGE_SIZES[kind]);
}

async function submitRecord(event, kind) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    const formData = new FormData(form);
    const id = safeText(formData.get('id'));
    let record;

    if (kind === 'note') {
        record = {
            kind,
            title: safeText(formData.get('title')),
            body: safeText(formData.get('content'))
        };
    } else if (kind === 'event') {
        const date = safeText(formData.get('date'));
        const time = safeText(formData.get('time'));
        record = {
            kind,
            title: safeText(formData.get('title')),
            body: safeText(formData.get('content')),
            eventAt: new Date(`${date}T${time}`).toISOString()
        };
    } else {
        const date = safeText(formData.get('date'));
        const category = safeText(formData.get('category'));
        record = {
            kind,
            title: category,
            transactionType: formData.get('type') === 'income' ? 'income' : 'expense',
            amount: numberValue(formData.get('amount')),
            currency: 'KZT',
            category,
            body: safeText(formData.get('content')),
            occurredAt: new Date(`${date}T12:00:00`).toISOString()
        };
    }
    if (id) record.id = id;
    const previous = id ? state.records[kind].find(item => getId(item) === id) : null;

    setButtonLoading(submit, true);
    setFeedback(form);
    try {
        const payload = await api('/records', { method: 'POST', body: { action: id ? 'update' : 'create', record } });
        const savedRecord = payload.record || record;
        if (kind === 'transaction') updateTransactionSummary(previous, savedRecord);
        storeRecord(kind, savedRecord);
        storeDashboardRecord(kind, savedRecord);
        if (kind === 'event' && !eventMatchesMode(savedRecord, state.eventMode)) {
            state.records.event = state.records.event.filter(item => getId(item) !== getId(savedRecord));
        }
        resetRecordForm(form);
        renderRecords(kind);
        renderActivation();
        closeMobileForm(form.closest('.record-form-wrap'));
        toast(id ? 'Изменения сохранены' : 'Запись добавлена');
    } catch (error) {
        setFeedback(form, error.message, 'error');
    } finally {
        setButtonLoading(submit, false);
    }
}

function editRecord(kind, id) {
    const record = state.records[kind].find(item => getId(item) === id);
    if (!record) return;
    const form = ({ note: dom.noteForm, event: dom.eventForm, transaction: dom.transactionForm })[kind];
    form.elements.id.value = id;
    if (kind === 'note') {
        form.elements.title.value = recordTitle(record);
        form.elements.content.value = recordBody(record);
    } else if (kind === 'event') {
        const date = eventDate(record) || new Date();
        form.elements.title.value = recordTitle(record);
        form.elements.content.value = recordBody(record);
        form.elements.date.value = inputDate(date);
        form.elements.time.value = inputTime(date);
    } else {
        const date = transactionDate(record) || new Date();
        form.elements.type.value = transactionType(record);
        form.elements.amount.value = numberValue(record.amount) || '';
        form.elements.category.value = safeText(record.category);
        form.elements.date.value = inputDate(date);
        form.elements.content.value = recordBody(record);
    }
    form.querySelector('h2');
    const heading = form.closest('.record-form-wrap')?.querySelector('.form-heading h2');
    if (heading) heading.textContent = 'Изменить запись';
    openMobileForm(form.closest('.record-form-wrap'));
    form.querySelector('input:not([type="hidden"]), textarea')?.focus();
}

async function deleteRecord(kind, id) {
    if (!window.confirm('Удалить эту запись из раздела?')) return;
    try {
        await api('/records', { method: 'POST', body: { action: 'delete', id } });
        const previous = state.records[kind].find(record => getId(record) === id);
        if (kind === 'transaction') updateTransactionSummary(previous, null);
        state.records[kind] = state.records[kind].filter(record => getId(record) !== id);
        state.dashboardRecords[kind] = state.dashboardRecords[kind].filter(record => getId(record) !== id);
        state.paging[kind].offset = Math.max(0, state.paging[kind].offset - 1);
        renderRecords(kind);
        renderActivation();
        toast('Запись удалена');
    } catch (error) {
        toast(error.message, 'error');
    }
}

function resetRecordForm(form) {
    form.reset();
    if (form.elements.id) form.elements.id.value = '';
    setFeedback(form);
    const wrap = form.closest('.record-form-wrap');
    const heading = wrap?.querySelector('.form-heading h2');
    if (heading) heading.textContent = ({
        'note-form': 'Новая заметка',
        'event-form': 'Новое событие',
        'transaction-form': 'Новая операция'
    })[form.id] || heading.textContent;
    setFormDefaults(form);
}

function setFormDefaults(form) {
    if (form?.id === 'event-form') {
        const nextHour = new Date();
        nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
        form.elements.date.value = inputDate(nextHour);
        form.elements.time.value = inputTime(nextHour);
    }
    if (form?.id === 'transaction-form') form.elements.date.value = inputDate(new Date());
}

function renderConnections() {
    populateModels();
    const agent = state.agent || {};
    dom.profileForm.elements.name.value = safeText(agent.name);
    const instructions = safeText(agent.instructions || agent.systemPrompt || agent.system_prompt);
    dom.profileForm.elements.instructions.value = instructions;
    dom.profileLanguage.value = ['ru', 'kk'].includes(agent.language) ? agent.language : 'ru';
    if (agent.model) dom.profileForm.elements.model.value = agent.model;
    document.querySelectorAll('[data-agent-preset]').forEach(button => {
        const selected = AGENT_PRESETS[button.dataset.agentPreset] === instructions;
        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-pressed', String(selected));
    });

    const openrouter = state.connections.openrouter;
    const openrouterConnected = connectionIsOn(openrouter);
    setConnectionState(dom.openrouterState, openrouterConnected ? 'Подключён' : 'Не подключён', openrouterConnected ? 'on' : 'off');
    dom.openrouterDelete.hidden = !openrouterConnected;
    if (openrouter?.model) dom.openrouterModel.value = openrouter.model;

    renderTelegramConnection();
    renderGoogleCalendarConnection();
}

function renderConnectionsError(error) {
    setConnectionState(dom.openrouterState, 'Недоступно', 'error');
    setConnectionState(dom.telegramState, 'Недоступно', 'error');
    setFeedback(dom.openrouterForm, error.message, 'error');
    setFeedback(dom.telegramForm, error.message, 'error');
}

function populateModels() {
    const models = state.models.length ? state.models : [
        { id: 'openrouter/free', name: 'Бесплатная модель · авто' }
    ];
    const options = models.map(model => {
        const id = typeof model === 'string' ? model : (model.id || model.slug || model.value);
        const name = typeof model === 'string' ? model : (model.name || model.label || id);
        return `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`;
    }).join('');
    const first = models[0];
    const fallbackModel = typeof first === 'string' ? first : (first?.id || first?.slug || first?.value || 'openrouter/free');
    const selectedProfile = dom.profileModel.value || state.agent?.model || fallbackModel;
    const selectedRouter = dom.openrouterModel.value || state.connections.openrouter?.model || fallbackModel;
    dom.profileModel.innerHTML = options;
    dom.openrouterModel.innerHTML = options;
    dom.profileModel.value = selectedProfile;
    dom.openrouterModel.value = selectedRouter;
}

function googleCalendarReturnFeedback() {
    const result = state.googleCalendarReturn;
    if (!result) return null;
    if (result === 'setup_required') {
        return { type: 'warning', message: 'Google Calendar ещё не настроен владельцем сайта. Подключение пользователя не запускалось.' };
    }
    if (result === 'error') {
        return { type: 'error', message: 'Google не подтвердил подключение. Доступ не сохранён — попробуйте ещё раз.' };
    }
    if (state.errors.googleCalendar) {
        return { type: 'error', message: 'Google вернул вас в Hub, но статус подключения пока не удалось проверить.' };
    }
    if (state.connections.googleCalendar?.connected) {
        return { type: 'success', message: 'Google Calendar подключён. Запустите синхронизацию, когда будете готовы.' };
    }
    if (state.connections.googleCalendar) {
        return { type: 'error', message: 'Возврат из Google завершён, но подключение не подтвердилось. Попробуйте подключить снова.' };
    }
    return { type: '', message: 'Проверяю подключение после возврата из Google…' };
}

function setGoogleCalendarFeedback(feedback) {
    const value = feedback || { message: '', type: '' };
    dom.googleCalendarFeedback.textContent = value.message || '';
    dom.googleCalendarFeedback.classList.toggle('is-error', value.type === 'error');
    dom.googleCalendarFeedback.classList.toggle('is-success', value.type === 'success');
    dom.googleCalendarFeedback.classList.toggle('is-warning', value.type === 'warning');
}

function renderGoogleCalendarConnection() {
    if (!dom.googleCalendarState) return;
    const status = state.connections.googleCalendar;
    const error = state.errors.googleCalendar;
    if (error) {
        setConnectionState(dom.googleCalendarState, 'Недоступно', 'error');
        dom.googleCalendarCopy.textContent = 'Не удалось проверить Google Calendar. Остальные разделы Hub продолжают работать.';
        dom.googleCalendarConnect.hidden = false;
        dom.googleCalendarConnect.disabled = true;
        dom.googleCalendarSync.hidden = true;
        dom.googleCalendarDisconnect.hidden = true;
        const prior = state.googleCalendarFeedback?.message ? ` ${state.googleCalendarFeedback.message}` : '';
        setGoogleCalendarFeedback(googleCalendarReturnFeedback() || { type: 'error', message: `${error.message}${prior}` });
        return;
    }
    if (!status) {
        setConnectionState(dom.googleCalendarState, 'Проверяю…', 'off');
        dom.googleCalendarCopy.textContent = 'Проверяю, доступно ли подключение Google Calendar.';
        dom.googleCalendarConnect.hidden = false;
        dom.googleCalendarConnect.disabled = true;
        dom.googleCalendarSync.hidden = true;
        dom.googleCalendarDisconnect.hidden = true;
        setGoogleCalendarFeedback(googleCalendarReturnFeedback());
        return;
    }

    const configured = Boolean(status.configured);
    const connected = Boolean(status.connected);
    const reconnectRequired = Boolean(status.reconnectRequired ?? status.reconnect_required);
    const updatedAt = parseDate(status.updatedAt || status.updated_at);
    const updatedCopy = updatedAt
        ? ` Последнее обновление подключения: ${new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(updatedAt)}.`
        : '';
    const label = connected ? 'Подключён' : (reconnectRequired ? 'Нужно переподключить' : (configured ? 'Не подключён' : 'Нужна настройка'));
    const type = connected ? 'on' : (reconnectRequired || !configured ? 'waiting' : 'off');
    setConnectionState(dom.googleCalendarState, label, type);
    dom.googleCalendarCopy.textContent = !configured
        ? 'Интеграция пока выключена: владельцу сайта нужно добавить Google OAuth Client ID и Client Secret.'
        : (connected
            ? `События можно синхронизировать в обе стороны вручную.${updatedCopy}`
            : (reconnectRequired
                ? 'Сохранённый доступ повреждён или отозван. Подключите календарь заново.'
                : 'Подключите основной календарь Google, затем запустите первую синхронизацию.'));
    dom.googleCalendarConnect.hidden = connected;
    dom.googleCalendarConnect.disabled = !configured;
    dom.googleCalendarConnect.textContent = reconnectRequired ? 'Подключить заново' : (configured ? 'Подключить Google' : 'Нужна настройка сайта');
    dom.googleCalendarSync.hidden = !connected;
    dom.googleCalendarSync.disabled = false;
    dom.googleCalendarDisconnect.hidden = !connected && !reconnectRequired;
    dom.googleCalendarDisconnect.disabled = false;
    const defaultFeedback = !configured
        ? { type: 'warning', message: 'Требуется настройка: подключение появится после добавления OAuth владельцем сайта.' }
        : null;
    setGoogleCalendarFeedback(state.googleCalendarFeedback || googleCalendarReturnFeedback() || defaultFeedback);
}

function consumeGoogleCalendarReturn() {
    const url = new URL(window.location.href);
    const result = url.searchParams.get('google');
    if (!['connected', 'error', 'setup_required'].includes(result)) return;
    state.googleCalendarReturn = result;
    url.searchParams.delete('google');
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function announceGoogleCalendarReturn() {
    if (!state.googleCalendarReturn || state.googleCalendarReturnAnnounced) return;
    state.googleCalendarReturnAnnounced = true;
    const feedback = googleCalendarReturnFeedback();
    if (feedback?.message) toast(feedback.message, feedback.type === 'success' ? 'success' : 'error');
}

function connectGoogleCalendar() {
    if (!state.connections.googleCalendar?.configured) {
        state.googleCalendarFeedback = { type: 'warning', message: 'Сначала владелец сайта должен настроить Google OAuth.' };
        renderGoogleCalendarConnection();
        return;
    }
    window.location.assign(`${API_ROOT}/google-calendar/start`);
}

function googleCalendarSyncFeedback(payload) {
    const push = payload?.push || {};
    const pull = payload?.pull || {};
    const parts = [
        `В Google отправлено: ${numberValue(push.synced)}`,
        `из Google добавлено: ${numberValue(pull.imported)}, обновлено: ${numberValue(pull.updated)}`
    ];
    if (numberValue(push.failed)) parts.push(`ошибок: ${numberValue(push.failed)}`);
    if (numberValue(push.remaining)) parts.push(`ещё ждут отправки: ${numberValue(push.remaining)}`);
    if (numberValue(pull.skippedLocalChanges)) parts.push(`локальных изменений сохранено: ${numberValue(pull.skippedLocalChanges)}`);
    if (pull.truncated) parts.push('получены первые 500 событий');
    return {
        type: payload?.ok ? 'success' : 'warning',
        message: `${parts.join(' · ')}.${numberValue(push.remaining) ? ' Повторите синхронизацию, чтобы продолжить.' : ''}`
    };
}

async function syncGoogleCalendar() {
    if (!state.connections.googleCalendar?.connected) return;
    setButtonLoading(dom.googleCalendarSync, true, 'Синхронизирую…');
    dom.googleCalendarDisconnect.disabled = true;
    state.googleCalendarFeedback = { type: '', message: 'Сверяю события Hub и Google Calendar…' };
    setGoogleCalendarFeedback(state.googleCalendarFeedback);
    let payload;
    try {
        payload = await api('/google-calendar', { method: 'POST', body: { action: 'sync' } });
    } catch (error) {
        if (error.status === 409) await loadGoogleCalendarStatus({ render: false }).catch(() => {});
        state.googleCalendarFeedback = { type: 'error', message: error.message };
        toast(error.message, 'error');
        renderGoogleCalendarConnection();
        return;
    } finally {
        setButtonLoading(dom.googleCalendarSync, false);
        dom.googleCalendarDisconnect.disabled = false;
    }

    state.googleCalendarFeedback = googleCalendarSyncFeedback(payload);
    renderGoogleCalendarConnection();
    toast(payload.ok ? 'Google Calendar синхронизирован' : 'Синхронизация завершилась частично', payload.ok ? 'success' : 'error');
    const [overviewResult, statusResult] = await Promise.allSettled([
        loadOverview(),
        loadGoogleCalendarStatus({ render: false })
    ]);
    if (overviewResult.status === 'fulfilled') {
        renderCalendar();
        renderFinance();
    } else {
        toast('Синхронизация завершилась, но обзор не обновился. Нажмите «Обновить данные».', 'error');
    }
    if (statusResult.status === 'rejected') toast('Не удалось обновить статус Google Calendar.', 'error');
    renderGoogleCalendarConnection();
}

async function disconnectGoogleCalendar() {
    if (!window.confirm('Отключить Google Calendar? События, уже сохранённые в Hub, останутся на месте.')) return;
    setButtonLoading(dom.googleCalendarDisconnect, true, 'Отключаю…');
    dom.googleCalendarSync.disabled = true;
    let payload;
    try {
        payload = await api('/google-calendar', { method: 'POST', body: { action: 'disconnect' } });
    } catch (error) {
        state.googleCalendarFeedback = { type: 'error', message: error.message };
        toast(error.message, 'error');
        renderGoogleCalendarConnection();
        return;
    } finally {
        setButtonLoading(dom.googleCalendarDisconnect, false);
        dom.googleCalendarSync.disabled = false;
    }
    state.connections.googleCalendar = {
        ...(state.connections.googleCalendar || {}),
        connected: false,
        reconnectRequired: false,
        updatedAt: null
    };
    state.googleCalendarReturn = '';
    state.googleCalendarFeedback = payload.remoteRevoked === false
        ? { type: 'warning', message: 'Подключение удалено из Hub, но Google не подтвердил отзыв токена. При необходимости проверьте доступы аккаунта Google.' }
        : { type: 'success', message: 'Google Calendar отключён. Сохранённые в Hub события не удалены.' };
    renderGoogleCalendarConnection();
    toast('Google Calendar отключён');
}

function renderTelegramConnection() {
    const telegram = state.connections.telegram;
    const connected = connectionIsOn(telegram);
    const ownerLinked = Boolean(telegram?.ownerLinked ?? telegram?.owner_linked);
    const waiting = connected && !ownerLinked;
    const linkCode = safeText(telegram?.linkCode || telegram?.link_code || telegram?.code);
    const linkUrl = safeText(telegram?.deepLink || telegram?.deep_link || telegram?.linkUrl || telegram?.link_url || telegram?.botUrl || telegram?.bot_url || telegram?.url);
    setConnectionState(dom.telegramState, ownerLinked ? 'Подключён' : (waiting ? 'Ожидает подтверждения' : 'Не подключён'), ownerLinked ? 'on' : (waiting ? 'waiting' : 'off'));
    dom.telegramTokenLabel.hidden = connected;
    dom.telegramDisconnect.hidden = !connected;
    dom.telegramRegenerate.hidden = !waiting;
    dom.telegramConnect.hidden = connected;
    dom.telegramLinkBox.hidden = !waiting;
    dom.telegramLinkCode.textContent = linkCode || '—';
    const expired = telegramLinkExpired(telegram);
    const safeLinkUrl = safeExternalUrl(linkUrl);
    dom.telegramCopy.disabled = !linkCode || expired;
    dom.telegramOpenLink.hidden = !safeLinkUrl || expired;
    if (safeLinkUrl && !expired) dom.telegramOpenLink.href = safeLinkUrl;
    dom.telegramCheck.hidden = !waiting;
    updateTelegramCountdown();
    scheduleTelegramPolling();
}

function telegramLinkExpired(telegram = state.connections.telegram) {
    const expiresAt = parseDate(telegram?.linkExpiresAt || telegram?.link_expires_at);
    return Boolean(expiresAt && expiresAt.getTime() <= Date.now());
}

function updateTelegramCountdown() {
    window.clearInterval(telegramCountdownTimer);
    telegramCountdownTimer = 0;
    const telegram = state.connections.telegram;
    const connected = connectionIsOn(telegram);
    const ownerLinked = Boolean(telegram?.ownerLinked ?? telegram?.owner_linked);
    if (!connected || ownerLinked || !dom.telegramLinkStatus) return;
    const code = safeText(telegram?.linkCode || telegram?.link_code || telegram?.code);
    const expiresAt = parseDate(telegram?.linkExpiresAt || telegram?.link_expires_at);
    const paint = () => {
        const remaining = expiresAt ? expiresAt.getTime() - Date.now() : 0;
        dom.telegramLinkStatus.classList.remove('is-expired');
        if (!code || !expiresAt) {
            dom.telegramLinkStatus.textContent = 'Код не показывается после обновления страницы. Создайте новый код и откройте бота.';
            dom.telegramCopy.disabled = true;
            dom.telegramOpenLink.hidden = true;
            return false;
        }
        if (remaining <= 0) {
            dom.telegramLinkStatus.textContent = 'Срок действия кода истёк. Создайте новый код привязки.';
            dom.telegramLinkStatus.classList.add('is-expired');
            dom.telegramCopy.disabled = true;
            dom.telegramOpenLink.hidden = true;
            return false;
        }
        const minutes = Math.floor(remaining / 60000);
        const seconds = Math.floor((remaining % 60000) / 1000);
        dom.telegramLinkStatus.classList.remove('is-expired');
        dom.telegramLinkStatus.textContent = `Откройте бота и отправьте код. Он действует ещё ${minutes}:${String(seconds).padStart(2, '0')}.`;
        return true;
    };
    if (paint()) telegramCountdownTimer = window.setInterval(() => {
        if (!paint()) window.clearInterval(telegramCountdownTimer);
    }, 1000);
}

function scheduleTelegramPolling() {
    window.clearTimeout(telegramPollTimer);
    telegramPollTimer = 0;
    const telegram = state.connections.telegram;
    const waiting = connectionIsOn(telegram) && !Boolean(telegram?.ownerLinked ?? telegram?.owner_linked);
    if (!waiting || document.visibilityState === 'hidden') return;
    telegramPollTimer = window.setTimeout(async () => {
        telegramPollTimer = 0;
        try {
            await refreshTelegramStatus();
        } catch {
            scheduleTelegramPolling();
        }
    }, TELEGRAM_POLL_INTERVAL);
}

async function refreshTelegramStatus({ refreshRecords = false } = {}) {
    if (!telegramStatusPromise) {
        telegramStatusPromise = (async () => {
            await loadOverview({ replaceRecords: false });
            renderTelegramConnection();
            if (refreshRecords) {
                const activeView = VALID_VIEWS.has(location.hash.slice(1)) ? location.hash.slice(1) : 'agent';
                const kind = ({ notes: 'note', calendar: 'event', finance: 'transaction' })[activeView];
                if (kind) await loadRecords(kind, {
                    search: kind === 'note' ? dom.notesSearch.value.trim() : '',
                    mode: kind === 'event' ? state.eventMode : undefined
                });
            }
            return state.connections.telegram;
        })().finally(() => { telegramStatusPromise = null; });
    }
    return telegramStatusPromise;
}

async function checkTelegramConnection() {
    setButtonLoading(dom.telegramCheck, true, 'Проверяю…');
    try {
        const telegram = await refreshTelegramStatus();
        if (telegram?.ownerLinked ?? telegram?.owner_linked) toast('Telegram подключён и готов к работе');
        else if (telegramLinkExpired(telegram)) toast('Код истёк — создайте новый', 'error');
        else toast('Пока ждём подтверждение в Telegram');
    } catch (error) {
        toast(error.message, 'error');
    } finally {
        setButtonLoading(dom.telegramCheck, false);
    }
}

async function copyTelegramCode() {
    const code = safeText(state.connections.telegram?.linkCode || state.connections.telegram?.link_code);
    if (!code || telegramLinkExpired()) return;
    try {
        await navigator.clipboard.writeText(code);
        toast('Код привязки скопирован');
    } catch {
        toast('Не удалось скопировать код. Выделите его вручную.', 'error');
    }
}

function refreshOnForeground() {
    if (!state.loaded || document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now - lastForegroundRefresh < 1500) return;
    lastForegroundRefresh = now;
    const refreshes = [refreshTelegramStatus({ refreshRecords: true })];
    if (location.hash === '#connections') refreshes.push(loadGoogleCalendarStatus());
    Promise.allSettled(refreshes);
}

function connectionIsOn(connection) {
    if (typeof connection === 'boolean') return connection;
    return Boolean(connection?.connected ?? connection?.enabled ?? connection?.configured ?? connection?.active);
}

function setConnectionState(element, label, type) {
    element.textContent = label;
    element.classList.toggle('is-on', type === 'on');
    element.classList.toggle('is-waiting', type === 'waiting');
    element.classList.toggle('is-error', type === 'error');
}

async function submitConnection(form, body, successMessage) {
    const submit = form.querySelector('[type="submit"]');
    setButtonLoading(submit, true, 'Подключаю…');
    setFeedback(form);
    try {
        const payload = await api('/connections', { method: 'POST', body });
        applyConnectionPayload(payload);
        renderConnections();
        setFeedback(form, successMessage, 'success');
        toast(successMessage);
        return payload;
    } catch (error) {
        setFeedback(form, error.message, 'error');
        return null;
    } finally {
        setButtonLoading(submit, false);
    }
}

function applyConnectionPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.agent) {
        state.agent = { ...(state.agent || {}), ...payload.agent };
        if (payload.agent.ai) {
            state.connections.openrouter = {
                connected: Boolean(payload.agent.ai.keyConfigured),
                model: payload.agent.model || ''
            };
        }
        if (payload.agent.telegram) state.connections.telegram = mergeTelegramConnection(state.connections.telegram, payload.agent.telegram);
    }
    if (payload.models) state.models = payload.models;
    const connections = payload.connections || {};
    if (payload.openrouter !== undefined || connections.openrouter !== undefined) state.connections.openrouter = payload.openrouter ?? connections.openrouter;
    if (payload.telegram !== undefined || connections.telegram !== undefined) state.connections.telegram = payload.telegram ?? connections.telegram;
    renderIdentity();
    renderAgent();
}

async function runConnectionAction(button, action, successMessage) {
    setButtonLoading(button, true, 'Подождите…');
    const form = button.closest('form');
    setFeedback(form);
    try {
        const payload = await api('/connections', { method: 'POST', body: { action } });
        applyConnectionPayload(payload);
        if (action === 'openrouter_delete' && payload.openrouter === undefined) state.connections.openrouter = null;
        if (action === 'telegram_disconnect' && payload.telegram === undefined) state.connections.telegram = null;
        renderConnections();
        setFeedback(form, successMessage, 'success');
        toast(successMessage);
    } catch (error) {
        setFeedback(form, error.message, 'error');
    } finally {
        setButtonLoading(button, false);
    }
}

function openSetupTarget(targetId) {
    const targetView = targetId === 'workflow-grid' ? 'agent' : 'connections';
    if (location.hash !== `#${targetView}`) location.hash = `#${targetView}`;
    else navigate(targetView);
    window.setTimeout(() => {
        const target = document.getElementById(targetId);
        target?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
        target?.querySelector('input, textarea, select, button')?.focus({ preventScroll: true });
    }, 80);
}

function prepareWorkflow(prompt) {
    if (!activationState().aiReady) {
        openSetupTarget('openrouter-card');
        toast('Подключите OpenRouter, чтобы запустить сценарий', 'error');
        return;
    }
    if (location.hash !== '#agent') location.hash = '#agent';
    else navigate('agent');
    state.hiddenHistory = false;
    dom.chatInput.value = prompt;
    saveChatDraft(prompt);
    resizeChatInput();
    window.setTimeout(() => {
        dom.chatInput.focus();
        dom.chatInput.setSelectionRange(dom.chatInput.value.length, dom.chatInput.value.length);
        dom.chatForm.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    }, 60);
}

function navigate(view, { replace = false, focus = false } = {}) {
    const target = VALID_VIEWS.has(view) ? view : 'agent';
    document.querySelectorAll('[data-view]').forEach(section => {
        const active = section.dataset.view === target;
        section.hidden = !active;
        section.classList.toggle('is-active', active);
    });
    document.querySelectorAll('[data-view-target]').forEach(link => {
        const active = link.dataset.viewTarget === target;
        link.classList.toggle('is-active', active);
        if (active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    });
    const hash = `#${target}`;
    if (replace && location.hash !== hash) history.replaceState(null, '', hash);
    document.title = `SHAIKH — ${{ agent: 'Agent Hub', notes: 'Заметки', calendar: 'Календарь', finance: 'Финансы', connections: 'Связи' }[target]}`;
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    if (focus) {
        const heading = document.querySelector(`[data-view="${target}"] h1`);
        heading?.setAttribute('tabindex', '-1');
        heading?.focus({ preventScroll: true });
    }
}

function openMobileForm(wrap) {
    if (!wrap) return;
    lastFormTrigger = document.activeElement;
    wrap.classList.add('is-open');
    document.body.classList.add('form-open');
    if (window.matchMedia('(max-width: 960px)').matches) {
        const heading = wrap.querySelector('.form-heading h2');
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');
        if (heading?.id) wrap.setAttribute('aria-labelledby', heading.id);
        dom.formOverlay.hidden = false;
        setDialogBackgroundInert(wrap, true);
        wrap.querySelector('.record-form input:not([type="hidden"]):not([disabled]), .record-form textarea:not([disabled]), .record-form select:not([disabled])')
            ?.focus({ preventScroll: true });
    }
}

function closeMobileForm(wrap) {
    if (!wrap) return;
    wrap.classList.remove('is-open');
    wrap.removeAttribute('role');
    wrap.removeAttribute('aria-modal');
    wrap.removeAttribute('aria-labelledby');
    setDialogBackgroundInert(wrap, false);
    dom.formOverlay.hidden = true;
    if (!document.querySelector('.record-form-wrap.is-open')) document.body.classList.remove('form-open');
    if (lastFormTrigger instanceof HTMLElement) lastFormTrigger.focus({ preventScroll: true });
    lastFormTrigger = null;
}

function setDialogBackgroundInert(dialog, enabled) {
    if (!dialog) return;
    if (!enabled) {
        document.querySelectorAll('[data-hub-dialog-inert="true"]').forEach(element => {
            element.inert = false;
            element.removeAttribute('inert');
            element.removeAttribute('data-hub-dialog-inert');
        });
        return;
    }
    let branch = dialog;
    while (branch?.parentElement && branch !== document.body) {
        [...branch.parentElement.children].forEach(element => {
            if (element === branch || element === dom.formOverlay || element.inert) return;
            element.inert = true;
            element.setAttribute('inert', '');
            element.dataset.hubDialogInert = 'true';
        });
        branch = branch.parentElement;
    }
}

function focusableElements(container) {
    return [...container.querySelectorAll('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.disabled && !element.hidden && element.getClientRects().length > 0);
}

function queueNoteSearch() {
    window.clearTimeout(noteSearchTimer);
    renderNotes();
    dom.notesList.setAttribute('aria-busy', 'true');
    const query = dom.notesSearch.value.trim();
    noteSearchTimer = window.setTimeout(async () => {
        try {
            await loadRecords('note', { search: query });
        } catch (error) {
            dom.notesList.setAttribute('aria-busy', 'false');
            toast(error.message, 'error');
        }
    }, 260);
}

function bindEvents() {
    window.addEventListener('hashchange', () => navigate(location.hash.slice(1), { replace: true, focus: true }));
    window.addEventListener('focus', refreshOnForeground);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refreshOnForeground();
        else {
            window.clearTimeout(telegramPollTimer);
            telegramPollTimer = 0;
        }
    });
    document.querySelectorAll('[data-view-target]').forEach(link => link.addEventListener('click', () => navigate(link.dataset.viewTarget)));
    dom.refreshButton.addEventListener('click', () => loadAll({ announce: true }));
    dom.logoutButton.addEventListener('click', async () => {
        dom.logoutButton.disabled = true;
        try {
            const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
            if (!response.ok) throw new Error('Logout failed');
            writeSessionValue(CHAT_DRAFT_STORAGE_KEY, null);
            writeSessionValue(CHAT_RUN_STORAGE_KEY, null);
            localStorage.removeItem('auth_token');
            localStorage.removeItem('auth_email');
            window.location.replace('login.html');
        } catch (_) {
            toast('Не удалось выйти. Проверьте соединение и попробуйте ещё раз.', 'error');
            dom.logoutButton.disabled = false;
        }
    });
    dom.globalAlert.addEventListener('click', event => {
        if (event.target.closest('[data-retry-all]')) loadAll({ announce: true });
    });

    dom.chatForm.addEventListener('submit', submitChat);
    dom.chatInput.addEventListener('input', () => {
        resizeChatInput();
        saveChatDraft(dom.chatInput.value);
    });
    dom.chatInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            dom.chatForm.requestSubmit();
        }
    });
    dom.clearChatButton.addEventListener('click', () => {
        state.hiddenHistory = true;
        renderMessages();
        toast('История появится после нового сообщения или обновления страницы');
    });
    dom.chatLockCta.addEventListener('click', () => openSetupTarget('openrouter-card'));

    dom.notesSearch.addEventListener('input', queueNoteSearch);
    dom.eventFilter.addEventListener('change', async () => {
        state.eventMode = dom.eventFilter.value === 'past' ? 'past' : 'upcoming';
        state.records.event = [];
        state.paging.event = pagingState();
        const loading = loadRecords('event', { mode: state.eventMode });
        dom.eventsList.setAttribute('aria-busy', 'true');
        dom.eventsList.innerHTML = '<div class="loading-block"><span class="loader"></span><span>Загружаю события…</span></div>';
        try {
            await loading;
        } catch (error) {
            state.errors.event = error;
            renderCalendar();
            dom.eventsList.setAttribute('aria-busy', 'false');
            toast(error.message, 'error');
        }
    });
    dom.transactionFilter.addEventListener('change', () => renderTransactions());
    dom.noteForm.addEventListener('submit', event => submitRecord(event, 'note'));
    dom.eventForm.addEventListener('submit', event => submitRecord(event, 'event'));
    dom.transactionForm.addEventListener('submit', event => submitRecord(event, 'transaction'));
    dom.transactionCsvPicker.addEventListener('click', () => {
        dom.transactionCsvFile.value = '';
        dom.transactionCsvFile.click();
    });
    dom.transactionCsvFile.addEventListener('change', selectTransactionCsv);
    dom.transactionCsvTemplate.addEventListener('click', downloadTransactionCsvTemplate);
    dom.transactionCsvSubmit.addEventListener('click', submitTransactionCsvImport);
    document.querySelectorAll('.reset-record-form').forEach(button => button.addEventListener('click', () => resetRecordForm(button.form)));

    document.addEventListener('click', event => {
        const edit = event.target.closest('[data-record-edit]');
        const remove = event.target.closest('[data-record-delete]');
        const toggle = event.target.closest('[data-toggle-form]');
        const close = event.target.closest('[data-close-form]');
        const workflow = event.target.closest('[data-workflow], [data-empty-workflow]');
        const manual = event.target.closest('[data-empty-manual]');
        const setup = event.target.closest('[data-setup-target]');
        const result = event.target.closest('[data-result-view]');
        const preset = event.target.closest('[data-agent-preset]');
        const loadMore = event.target.closest('[data-load-more]');
        const retryChat = event.target.closest('[data-chat-retry]');
        const editChat = event.target.closest('[data-chat-edit]');
        if (edit) editRecord(edit.dataset.recordEdit, edit.dataset.recordId);
        if (remove) deleteRecord(remove.dataset.recordDelete, remove.dataset.recordId);
        if (toggle) openMobileForm(document.getElementById(toggle.dataset.toggleForm));
        if (close) closeMobileForm(document.getElementById(close.dataset.closeForm));
        if (workflow) prepareWorkflow(workflow.dataset.prompt || workflow.dataset.emptyWorkflow || '');
        if (manual) openMobileForm(document.getElementById(manual.dataset.emptyManual));
        if (setup) {
            const target = setup.dataset.setupTarget;
            openSetupTarget(target === 'workflow-grid' && !activationState().aiReady ? 'openrouter-card' : target);
        }
        if (result) {
            location.hash = `#${result.dataset.resultView}`;
            navigate(result.dataset.resultView);
        }
        if (loadMore) {
            const kind = loadMore.dataset.loadMore;
            loadRecords(kind, {
                append: true,
                search: kind === 'note' ? dom.notesSearch.value.trim() : '',
                mode: kind === 'event' ? state.eventMode : undefined
            }).catch(error => toast(error.message, 'error'));
        }
        if (retryChat) retryChatRun();
        if (editChat) editChatRun();
        if (preset) {
            const value = AGENT_PRESETS[preset.dataset.agentPreset];
            if (value) {
                dom.profileForm.elements.instructions.value = value;
                document.querySelectorAll('[data-agent-preset]').forEach(button => {
                    const selected = button === preset;
                    button.classList.toggle('is-selected', selected);
                    button.setAttribute('aria-pressed', String(selected));
                });
                toast('Роль выбрана — сохраните настройки');
            }
        }
    });

    dom.profileForm.addEventListener('submit', event => {
        event.preventDefault();
        const profile = Object.fromEntries(new FormData(dom.profileForm).entries());
        submitConnection(dom.profileForm, { action: 'profile_update', profile, ...profile }, 'Настройки агента сохранены');
    });
    dom.openrouterForm.addEventListener('submit', event => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(dom.openrouterForm).entries());
        submitConnection(dom.openrouterForm, { action: 'openrouter_set', ...values }, 'OpenRouter подключён').then(payload => {
            if (payload) dom.openrouterForm.elements.apiKey.value = '';
        });
    });
    dom.openrouterDelete.addEventListener('click', () => {
        if (window.confirm('Удалить ключ OpenRouter? Агент перестанет отвечать до нового подключения.')) {
            runConnectionAction(dom.openrouterDelete, 'openrouter_delete', 'Ключ OpenRouter удалён');
        }
    });
    dom.telegramForm.addEventListener('submit', event => {
        event.preventDefault();
        const botToken = safeText(new FormData(dom.telegramForm).get('botToken'));
        submitConnection(dom.telegramForm, { action: 'telegram_connect', ...(botToken ? { botToken } : {}) }, 'Telegram готов к привязке').then(payload => {
            if (payload && dom.telegramForm.elements.botToken) dom.telegramForm.elements.botToken.value = '';
        });
    });
    dom.telegramDisconnect.addEventListener('click', () => {
        if (window.confirm('Отключить Telegram-бота от этого аккаунта?')) {
            runConnectionAction(dom.telegramDisconnect, 'telegram_disconnect', 'Telegram отключён');
        }
    });
    dom.telegramRegenerate.addEventListener('click', () => runConnectionAction(dom.telegramRegenerate, 'telegram_regenerate_link', 'Новый код создан'));
    dom.telegramCopy.addEventListener('click', copyTelegramCode);
    dom.telegramCheck.addEventListener('click', checkTelegramConnection);
    dom.googleCalendarConnect.addEventListener('click', connectGoogleCalendar);
    dom.googleCalendarSync.addEventListener('click', syncGoogleCalendar);
    dom.googleCalendarDisconnect.addEventListener('click', disconnectGoogleCalendar);
    dom.formOverlay.addEventListener('click', () => {
        closeMobileForm(document.querySelector('.record-form-wrap.is-open'));
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            document.querySelectorAll('.record-form-wrap.is-open').forEach(closeMobileForm);
            return;
        }
        if (event.key !== 'Tab') return;
        const dialog = document.querySelector('.record-form-wrap.is-open[aria-modal="true"]');
        if (!dialog) return;
        const elements = focusableElements(dialog);
        if (!elements.length) {
            event.preventDefault();
            return;
        }
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!dialog.contains(document.activeElement)) {
            event.preventDefault();
            first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });
}

function resizeChatInput() {
    dom.chatInput.style.height = 'auto';
    dom.chatInput.style.height = `${Math.min(dom.chatInput.scrollHeight, 145)}px`;
}

function recordTitle(record, fallback = '') {
    return safeText(record?.title || record?.name, fallback);
}

function recordBody(record, fallback = '') {
    return safeText(record?.body || record?.content || record?.description || record?.note, fallback);
}

function recordDate(record) {
    return parseDate(record?.updatedAt || record?.updated_at || record?.createdAt || record?.created_at);
}

function eventDate(record) {
    return parseDate(record?.eventAt || record?.event_at || record?.startsAt || record?.starts_at || record?.date);
}

function transactionDate(record) {
    return parseDate(record?.occurredAt || record?.occurred_at || record?.date || record?.createdAt || record?.created_at);
}

function transactionType(record) {
    return (record?.transactionType || record?.transaction_type || record?.type) === 'income' ? 'income' : 'expense';
}

function parseDate(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date) {
    const result = new Date(date);
    result.setHours(0, 0, 0, 0);
    return result;
}

function dateKey(value) {
    const date = parseDate(value);
    return date ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : '';
}

function monthKey(value) {
    const date = parseDate(value);
    return date ? `${date.getFullYear()}-${date.getMonth()}` : '';
}

function inputDate(date) {
    const valid = parseDate(date) || new Date();
    const part = value => String(value).padStart(2, '0');
    return `${valid.getFullYear()}-${part(valid.getMonth() + 1)}-${part(valid.getDate())}`;
}

function inputTime(date) {
    const valid = parseDate(date) || new Date();
    return `${String(valid.getHours()).padStart(2, '0')}:${String(valid.getMinutes()).padStart(2, '0')}`;
}

function formatTime(value) {
    const date = parseDate(value);
    return date ? new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(date) : 'Сейчас';
}

function formatShortDate(value) {
    const date = parseDate(value);
    return date ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(date) : 'Без даты';
}

function formatEventDate(date) {
    return date ? new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(date) : 'Дата не указана';
}

function formatMoney(value, compact = false) {
    const amount = numberValue(value);
    return new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency: 'KZT',
        currencyDisplay: 'narrowSymbol',
        maximumFractionDigits: 0,
        notation: compact && Math.abs(amount) >= 100000 ? 'compact' : 'standard'
    }).format(amount);
}

function formatMoneyPrecise(value) {
    return new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency: 'KZT',
        currencyDisplay: 'narrowSymbol',
        maximumFractionDigits: 2
    }).format(numberValue(value));
}

function numberValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function plural(value, forms) {
    const amount = Math.abs(value) % 100;
    const last = amount % 10;
    if (amount > 10 && amount < 20) return forms[2];
    if (last > 1 && last < 5) return forms[1];
    if (last === 1) return forms[0];
    return forms[2];
}

function modelName(value) {
    if (!value) return '';
    const model = state.models.find(item => (typeof item === 'string' ? item : (item.id || item.slug || item.value)) === value);
    return typeof model === 'string' ? model : (model?.name || model?.label || value);
}

function safeExternalUrl(value) {
    try {
        const url = new URL(value);
        return ['https:', 'tg:'].includes(url.protocol) ? url.href : '';
    } catch {
        return '';
    }
}

function iconNote() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5"/></svg>';
}

function iconCalendar() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18v16H3zM16 3v4M8 3v4M3 10h18"/></svg>';
}

function iconWallet() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18v14H3zM16 13h5M3 9h18"/></svg>';
}

function init() {
    cacheDom();
    restoreChatSession();
    consumeGoogleCalendarReturn();
    bindEvents();
    [dom.noteForm, dom.eventForm, dom.transactionForm].forEach(setFormDefaults);
    renderCalendarStrip();
    renderTransactionCsvImport();
    renderGoogleCalendarConnection();
    navigate(location.hash.slice(1), { replace: true });
    loadAll();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

document.addEventListener('DOMContentLoaded', init);
