const API_ROOT = '/api/hub';
const VALID_VIEWS = new Set(['agent', 'notes', 'calendar', 'finance', 'connections']);

const state = {
    user: null,
    agent: null,
    messages: [],
    records: { note: [], event: [], transaction: [] },
    summary: {},
    models: [],
    connections: { openrouter: null, telegram: null },
    errors: { overview: null, connections: null, note: null, event: null, transaction: null },
    loaded: false
};

const dom = {};

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
        'chat-input', 'chat-submit', 'clear-chat-button', 'today-date', 'today-summary',
        'next-record', 'notes-search', 'notes-count', 'notes-list', 'note-form',
        'calendar-strip', 'events-count', 'events-list', 'event-form', 'balance-value',
        'income-value', 'expense-value', 'transaction-filter', 'transactions-list',
        'transaction-form', 'profile-form', 'profile-model', 'openrouter-state',
        'openrouter-form', 'openrouter-model', 'openrouter-delete', 'telegram-state',
        'telegram-form', 'telegram-token-label', 'telegram-link-box', 'telegram-link-code',
        'telegram-open-link', 'telegram-disconnect', 'telegram-regenerate', 'telegram-connect',
        'toast-region'
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
        const message = payload.error || payload.message || (response.status === 401
            ? 'Войдите в клиентский аккаунт, чтобы открыть Agent Hub.'
            : 'Не удалось выполнить запрос. Попробуйте ещё раз.');
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
        button.dataset.previousLabel = button.textContent;
        button.textContent = loadingLabel;
        button.disabled = true;
    } else {
        button.textContent = button.dataset.previousLabel || button.textContent;
        button.disabled = false;
        delete button.dataset.previousLabel;
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

async function loadOverview() {
    const payload = await api('/overview');
    state.user = payload.user || null;
    state.agent = payload.agent || null;
    if (state.agent?.ai) {
        state.connections.openrouter = {
            connected: Boolean(state.agent.ai.keyConfigured),
            model: state.agent.model || ''
        };
    }
    if (state.agent?.telegram) state.connections.telegram = state.agent.telegram;
    state.messages = Array.isArray(payload.messages) ? payload.messages : [];
    state.summary = payload.summary || {};
    const overviewRecords = normalizeOverviewRecords(payload.records);
    if (overviewRecords) state.records = overviewRecords;
    renderIdentity();
    renderAgent();
}

async function loadRecords(kind, { render = true } = {}) {
    const payload = await api(`/records?kind=${encodeURIComponent(kind)}`);
    state.records[kind] = readArray(payload, kind);
    state.errors[kind] = null;
    if (render) renderRecords(kind);
    return state.records[kind];
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

async function loadAll({ announce = false } = {}) {
    setSystemStatus('loading', 'Синхронизация…');
    dom.refreshButton.disabled = true;
    clearGlobalError();

    const tasks = [
        loadOverview(),
        loadConnections(),
        loadRecords('note', { render: false }),
        loadRecords('event', { render: false }),
        loadRecords('transaction', { render: false })
    ];
    const results = await Promise.allSettled(tasks);
    const rejected = results.filter(result => result.status === 'rejected');

    state.errors.overview = results[0].status === 'rejected' ? results[0].reason : null;
    state.errors.connections = results[1].status === 'rejected' ? results[1].reason : null;
    ['note', 'event', 'transaction'].forEach((kind, index) => {
        state.errors[kind] = results[index + 2].status === 'rejected' ? results[index + 2].reason : null;
    });

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

    if (!rejected.length) {
        setSystemStatus('ready', 'Всё синхронизировано');
        if (announce) toast('Данные обновлены');
    } else if (results[0].status !== 'rejected') {
        setSystemStatus('error', 'Часть данных недоступна');
        if (announce) toast('Некоторые разделы не обновились', 'error');
    }
    dom.refreshButton.disabled = false;
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
    dom.agentName.textContent = safeText(agent.name, 'SHAIKH Agent');
    dom.agentModel.textContent = modelName(agent.model) || 'Модель не выбрана';
    renderMessages();
    renderToday();
}

function renderMessages() {
    const messages = state.messages;
    dom.chatFeed.setAttribute('aria-busy', 'false');
    if (!messages.length) {
        const name = safeText(state.user?.name || state.user?.displayName, 'друг');
        dom.chatFeed.innerHTML = `
            <div class="chat-message">
                <span class="message-avatar">AI</span>
                <div class="message-body">
                    <div class="message-bubble">Привет, ${escapeHtml(name)}! Я готов помочь с заметками, планами и личными финансами. Просто напишите задачу обычными словами.</div>
                    <time class="message-time">Сейчас</time>
                </div>
            </div>`;
        return;
    }
    dom.chatFeed.innerHTML = messages.map(messageTemplate).join('');
    dom.chatFeed.scrollTop = dom.chatFeed.scrollHeight;
}

function messageTemplate(message) {
    const role = message.role === 'user' ? 'user' : 'assistant';
    const content = safeText(message.content || message.text || message.reply);
    const actions = Array.isArray(message.actions) ? message.actions : [];
    const actionHtml = actions.length
        ? `<div class="message-actions">${actions.map(action => `<span class="action-chip">✓ ${escapeHtml(actionLabel(action))}</span>`).join('')}</div>`
        : '';
    return `
        <div class="chat-message${role === 'user' ? ' is-user' : ''}">
            <span class="message-avatar">${role === 'user' ? escapeHtml(initials(state.user?.name || 'Вы')) : 'AI'}</span>
            <div class="message-body">
                <div class="message-bubble">${escapeHtml(content)}</div>
                ${actionHtml}
                <time class="message-time">${escapeHtml(formatTime(message.createdAt || message.created_at))}</time>
            </div>
        </div>`;
}

function actionLabel(action) {
    if (typeof action === 'string') return action;
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

function appendPendingMessage() {
    const node = document.createElement('div');
    node.className = 'chat-message is-pending';
    node.id = 'pending-agent-message';
    node.innerHTML = '<span class="message-avatar">AI</span><div class="message-body"><div class="message-bubble"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div></div>';
    dom.chatFeed.appendChild(node);
    dom.chatFeed.scrollTop = dom.chatFeed.scrollHeight;
}

async function submitChat(event) {
    event.preventDefault();
    const message = dom.chatInput.value.trim();
    if (!message || dom.chatSubmit.disabled) return;
    dom.chatInput.value = '';
    resizeChatInput();
    state.messages.push({ role: 'user', content: message, createdAt: new Date().toISOString() });
    renderMessages();
    appendPendingMessage();
    setButtonLoading(dom.chatSubmit, true, '…');

    try {
        const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const payload = await api('/chat', { method: 'POST', body: { message, requestId } });
        document.getElementById('pending-agent-message')?.remove();
        state.messages.push({
            role: 'assistant',
            content: payload.reply || 'Готово.',
            actions: Array.isArray(payload.actions) ? payload.actions : [],
            createdAt: new Date().toISOString()
        });
        renderMessages();
        const touchedKinds = new Set((payload.actions || []).map(actionKind));
        await Promise.all([...touchedKinds].filter(kind => state.records[kind]).map(kind => loadRecords(kind)));
        renderToday();
    } catch (error) {
        document.getElementById('pending-agent-message')?.remove();
        state.messages.push({ role: 'assistant', content: error.message, createdAt: new Date().toISOString() });
        renderMessages();
        toast(error.message, 'error');
    } finally {
        setButtonLoading(dom.chatSubmit, false);
        dom.chatInput.focus();
    }
}

function renderToday() {
    const now = new Date();
    dom.todayDate.textContent = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' }).format(now);
    const todayKey = dateKey(now);
    const todayEvents = state.records.event.filter(record => dateKey(eventDate(record)) === todayKey);
    const todayTransactions = state.records.transaction.filter(record => dateKey(transactionDate(record)) === todayKey);
    const expenseToday = todayTransactions.filter(record => transactionType(record) === 'expense').reduce((sum, record) => sum + numberValue(record.amount), 0);
    const notesCount = numberValue(state.summary.notesToday ?? state.summary.notes_today) || state.records.note.filter(record => dateKey(record.createdAt || record.created_at) === todayKey).length;
    dom.todaySummary.innerHTML = [
        metricTemplate(iconCalendar(), 'События', 'сегодня', todayEvents.length),
        metricTemplate(iconNote(), 'Новые заметки', 'сегодня', notesCount),
        metricTemplate(iconWallet(), 'Расходы', 'сегодня', formatMoney(expenseToday, true))
    ].join('');

    const next = state.records.event
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
    dom.notesCount.textContent = `${notes.length} ${plural(notes.length, ['заметка', 'заметки', 'заметок'])}`;
    dom.notesList.setAttribute('aria-busy', 'false');
    if (!notes.length) {
        dom.notesList.innerHTML = emptyState(iconNote(), query ? 'Ничего не найдено' : 'Заметок пока нет', query ? 'Попробуйте другой запрос.' : 'Создайте первую заметку вручную или попросите агента.');
        return;
    }
    dom.notesList.innerHTML = notes.map(note => `<article class="record-card">
            <div class="record-card__meta"><span>${escapeHtml(formatShortDate(recordDate(note)))}</span><span>Заметка</span></div>
            <h3>${escapeHtml(recordTitle(note, 'Без заголовка'))}</h3>
            <p>${escapeHtml(recordBody(note, 'Пустая заметка'))}</p>
            ${cardActions('note', getId(note))}
        </article>`).join('');
}

function renderCalendar() {
    renderCalendarStrip();
    if (state.errors.event) {
        dom.eventsCount.textContent = 'Ошибка загрузки';
        dom.eventsList.setAttribute('aria-busy', 'false');
        dom.eventsList.innerHTML = errorState(state.errors.event.message);
        return;
    }
    const events = [...state.records.event].sort((a, b) => eventDate(a) - eventDate(b));
    dom.eventsCount.textContent = `${events.length} ${plural(events.length, ['событие', 'события', 'событий'])}`;
    dom.eventsList.setAttribute('aria-busy', 'false');
    if (!events.length) {
        dom.eventsList.innerHTML = emptyState(iconCalendar(), 'Планов пока нет', 'Добавьте событие вручную или напишите агенту, что и когда запланировать.');
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
    }).join('');
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
        dom.transactionsList.innerHTML = emptyState(iconWallet(), filter === 'all' ? 'Операций пока нет' : 'Нет операций этого типа', 'Запишите сумму вручную или сообщите расход агенту.');
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
    }).join('');
}

function cardActions(kind, id) {
    if (!id) return '';
    return `<div class="card-actions"><button class="card-action" type="button" data-record-edit="${kind}" data-record-id="${escapeHtml(id)}">Изменить</button><button class="card-action is-danger" type="button" data-record-delete="${kind}" data-record-id="${escapeHtml(id)}">Удалить</button></div>`;
}

function emptyState(icon, title, copy) {
    return `<div class="empty-state"><div><span class="empty-state__icon">${icon}</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(copy)}</p></div></div>`;
}

function emptyCompact(message) {
    return `<div class="next-record"><strong>${escapeHtml(message)}</strong><span>Можно добавить через чат или календарь.</span></div>`;
}

function errorState(message) {
    return `<div class="error-state"><span>${escapeHtml(message)}</span></div>`;
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

    setButtonLoading(submit, true);
    setFeedback(form);
    try {
        await api('/records', { method: 'POST', body: { action: id ? 'update' : 'create', record } });
        resetRecordForm(form);
        await loadRecords(kind);
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
    if (!window.confirm('Удалить эту запись? Действие нельзя отменить.')) return;
    try {
        await api('/records', { method: 'POST', body: { action: 'delete', id } });
        state.records[kind] = state.records[kind].filter(record => getId(record) !== id);
        renderRecords(kind);
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
    dom.profileForm.elements.instructions.value = safeText(agent.instructions || agent.systemPrompt || agent.system_prompt);
    if (agent.model) dom.profileForm.elements.model.value = agent.model;

    const openrouter = state.connections.openrouter;
    const openrouterConnected = connectionIsOn(openrouter);
    setConnectionState(dom.openrouterState, openrouterConnected ? 'Подключён' : 'Не подключён', openrouterConnected ? 'on' : 'off');
    dom.openrouterDelete.hidden = !openrouterConnected;
    if (openrouter?.model) dom.openrouterModel.value = openrouter.model;

    renderTelegramConnection();
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

function renderTelegramConnection() {
    const telegram = state.connections.telegram;
    const connected = connectionIsOn(telegram);
    const ownerLinked = Boolean(telegram?.ownerLinked ?? telegram?.owner_linked);
    const linkCode = safeText(telegram?.linkCode || telegram?.link_code || telegram?.code);
    const linkUrl = safeText(telegram?.deepLink || telegram?.deep_link || telegram?.linkUrl || telegram?.link_url || telegram?.botUrl || telegram?.bot_url || telegram?.url);
    setConnectionState(dom.telegramState, ownerLinked ? 'Подключён' : (connected || linkCode ? 'Ждёт привязки' : 'Не подключён'), connected || linkCode ? 'on' : 'off');
    dom.telegramTokenLabel.hidden = connected;
    dom.telegramDisconnect.hidden = !connected;
    dom.telegramRegenerate.hidden = !connected || ownerLinked;
    dom.telegramConnect.hidden = connected || Boolean(linkCode);
    dom.telegramLinkBox.hidden = !linkCode;
    dom.telegramLinkCode.textContent = linkCode || '—';
    dom.telegramOpenLink.hidden = !linkUrl;
    if (linkUrl) dom.telegramOpenLink.href = safeExternalUrl(linkUrl) || '#';
}

function connectionIsOn(connection) {
    if (typeof connection === 'boolean') return connection;
    return Boolean(connection?.connected ?? connection?.enabled ?? connection?.configured ?? connection?.active);
}

function setConnectionState(element, label, type) {
    element.textContent = label;
    element.classList.toggle('is-on', type === 'on');
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
        if (payload.agent.telegram) state.connections.telegram = payload.agent.telegram;
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

function navigate(view, { replace = false } = {}) {
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
}

function openMobileForm(wrap) {
    if (!wrap) return;
    wrap.classList.add('is-open');
    document.body.classList.add('form-open');
}

function closeMobileForm(wrap) {
    if (!wrap) return;
    wrap.classList.remove('is-open');
    if (!document.querySelector('.record-form-wrap.is-open')) document.body.classList.remove('form-open');
}

function bindEvents() {
    window.addEventListener('hashchange', () => navigate(location.hash.slice(1), { replace: true }));
    document.querySelectorAll('[data-view-target]').forEach(link => link.addEventListener('click', () => navigate(link.dataset.viewTarget)));
    dom.refreshButton.addEventListener('click', () => loadAll({ announce: true }));
    dom.logoutButton.addEventListener('click', async () => {
        dom.logoutButton.disabled = true;
        try {
            const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
            if (!response.ok) throw new Error('Logout failed');
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
    dom.chatInput.addEventListener('input', resizeChatInput);
    dom.chatInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            dom.chatForm.requestSubmit();
        }
    });
    document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
        dom.chatInput.value = button.dataset.prompt;
        resizeChatInput();
        dom.chatInput.focus();
    }));
    dom.clearChatButton.addEventListener('click', () => { state.messages = []; renderMessages(); });

    dom.notesSearch.addEventListener('input', renderNotes);
    dom.transactionFilter.addEventListener('change', () => renderTransactions());
    dom.noteForm.addEventListener('submit', event => submitRecord(event, 'note'));
    dom.eventForm.addEventListener('submit', event => submitRecord(event, 'event'));
    dom.transactionForm.addEventListener('submit', event => submitRecord(event, 'transaction'));
    document.querySelectorAll('.reset-record-form').forEach(button => button.addEventListener('click', () => resetRecordForm(button.form)));

    document.addEventListener('click', event => {
        const edit = event.target.closest('[data-record-edit]');
        const remove = event.target.closest('[data-record-delete]');
        const toggle = event.target.closest('[data-toggle-form]');
        const close = event.target.closest('[data-close-form]');
        if (edit) editRecord(edit.dataset.recordEdit, edit.dataset.recordId);
        if (remove) deleteRecord(remove.dataset.recordDelete, remove.dataset.recordId);
        if (toggle) openMobileForm(document.getElementById(toggle.dataset.toggleForm));
        if (close) closeMobileForm(document.getElementById(close.dataset.closeForm));
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
    dom.openrouterDelete.addEventListener('click', () => runConnectionAction(dom.openrouterDelete, 'openrouter_delete', 'Ключ OpenRouter удалён'));
    dom.telegramForm.addEventListener('submit', event => {
        event.preventDefault();
        const botToken = safeText(new FormData(dom.telegramForm).get('botToken'));
        submitConnection(dom.telegramForm, { action: 'telegram_connect', ...(botToken ? { botToken } : {}) }, 'Telegram готов к привязке').then(payload => {
            if (payload && dom.telegramForm.elements.botToken) dom.telegramForm.elements.botToken.value = '';
        });
    });
    dom.telegramDisconnect.addEventListener('click', () => runConnectionAction(dom.telegramDisconnect, 'telegram_disconnect', 'Telegram отключён'));
    dom.telegramRegenerate.addEventListener('click', () => runConnectionAction(dom.telegramRegenerate, 'telegram_regenerate_link', 'Новый код создан'));

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') document.querySelectorAll('.record-form-wrap.is-open').forEach(closeMobileForm);
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
    bindEvents();
    [dom.noteForm, dom.eventForm, dom.transactionForm].forEach(setFormDefaults);
    renderCalendarStrip();
    navigate(location.hash.slice(1), { replace: true });
    loadAll();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

document.addEventListener('DOMContentLoaded', init);
