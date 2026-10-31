import { assertInboxSchema, INBOX_RESPONSE_SCHEMA } from '../lib/whatsapp-inbox-contract.mjs';

const INBOX_API = '/api/hub/whatsapp-inbox';
const WORKSPACE_API = '/api/hub/workspace';
const emptyData = () => ({ threads: [], threadPage: { nextCursor: null }, selectedThread: null, messages: [], messagePage: { olderCursor: null }, approvals: [], status: { deviceOnline: false, connected: false, captureSince: null } });
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const dateLabel = value => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const mediaLabels = { image: 'Фото', video: 'Видео', audio: 'Голосовое / аудио', document: 'Документ', sticker: 'Стикер', location: 'Геопозиция', contact: 'Контакт', unsupported: 'Сообщение этого типа пока не поддерживается' };
const approvalLabels = { pending: 'Нужно согласование', approved: 'Согласовано · ожидает Mac', dispatching: 'Mac отправляет', sent: 'Передано WhatsApp', failed: 'Не удалось отправить', uncertain: 'Исход отправки неизвестен', rejected: 'Ответ отклонён', expired: 'Срок согласования истёк' };
const messageLabels = { received: 'Получено агентом', processing: 'Агент обрабатывает', awaiting_approval: 'Передано на согласование', answered: 'Агент ответил', skipped: 'Без автоматического ответа', sending: 'Отправляется', sent: 'Передано WhatsApp', uncertain: 'Исход отправки неизвестен', failed: 'Не удалось отправить' };

export function effectiveInboxApproval(approval, now = Date.now()) {
    if (!approval) return null;
    return ['pending', 'approved'].includes(approval.status) && Date.parse(approval.expires_at) <= now ? { ...approval, status: 'expired' } : approval;
}

export function inboxMessageStatus(message, approval) {
    if (message.direction === 'incoming' && approval) return approvalLabels[approval.status] || messageLabels[message.status];
    return messageLabels[message.status] || 'Статус обновляется';
}

/** State stays in this tab. Requests never write chat text to browser storage. */
export function createInboxController({ fetchImpl = globalThis.fetch, accountId = '', render = () => {}, notice = () => {}, onAuth = () => {}, onDecision = () => {}, now = Date.now, setIntervalImpl = globalThis.setInterval, clearIntervalImpl = globalThis.clearInterval, pollMs = 6000, visible = true } = {}) {
    const state = { data: emptyData(), active: false, visible, loaded: false, loading: false, quietLoading: false, sessionReady: !accountId, error: '', search: '', selectedId: null, detailOpen: false, threadsCursor: null, threadBack: [], messagesCursor: null, drafts: new Map(), actions: new Set(), decisions: new Map() };
    let revision = 0;
    let timer = null;
    let destroyed = false;
    let authExpired = false;
    const requests = new Map();
    const snapshot = () => ({ ...state, loaded: state.loaded && state.sessionReady, loading: state.loading && !state.quietLoading, data: { ...(state.sessionReady ? state.data : emptyData()), approvals: (state.sessionReady ? state.data.approvals : []).map(item => {
        const local = state.decisions.get(item.id);
        return effectiveInboxApproval(local && item.status === 'pending' ? local : item, now());
    }) } });
    const emit = () => { if (!destroyed) render(snapshot()); };
    const stopTimer = () => { if (timer !== null) clearIntervalImpl(timer); timer = null; };
    const abortRequests = (readsOnly = false) => {
        for (const [controller, mutation] of requests) if (!readsOnly || !mutation) controller.abort();
    };
    const clearPrivateState = () => {
        state.active = false; state.data = emptyData(); state.drafts.clear(); state.decisions.clear(); state.actions.clear();
        state.selectedId = null; state.search = ''; state.loaded = false; state.loading = false; state.sessionReady = false;
        state.detailOpen = false; state.threadsCursor = null; state.threadBack = []; state.messagesCursor = null; state.error = '';
    };
    function expireSession() {
        if (authExpired || destroyed) return;
        authExpired = true; revision++; stopTimer(); abortRequests(); clearPrivateState(); emit(); onAuth();
    }
    const startTimer = () => {
        stopTimer();
        if (!destroyed && state.active && state.visible) timer = setIntervalImpl(() => { if (!state.loading) void load({ quiet: true }); }, pollMs);
    };
    async function request(url, body) {
        const controller = new AbortController();
        requests.set(controller, Boolean(body));
        const { signal } = controller;
        const checkAlive = () => { if (destroyed || authExpired || signal.aborted) throw new DOMException('Запрос отменён.', 'AbortError'); };
        const verifyAccount = async () => {
            checkAlive();
            if (!accountId) return;
            const session = await fetchImpl('/api/auth/session', { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal });
            const identity = await session.json().catch(() => ({}));
            checkAlive();
            if (session.status === 401 || session.ok && String(identity.user?.sub || identity.user?.id || identity.user?.login || '') !== String(accountId)) {
                expireSession(); throw new Error('Аккаунт изменился. Откройте кабинет заново.');
            }
            if (!session.ok) throw new Error('Не удалось проверить вход. Обновите страницу.');
        };
        try {
            await verifyAccount(); checkAlive();
            const response = await fetchImpl(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
            const data = await response.json().catch(() => ({}));
            checkAlive();
            if (response.status === 401) { expireSession(); throw new Error('Войдите в аккаунт, чтобы открыть чаты.'); }
            if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Не удалось загрузить переписку. Попробуйте ещё раз.');
            await verifyAccount(); checkAlive();
            return data;
        } finally {
            requests.delete(controller);
        }
    }
    async function load({ quiet = false } = {}) {
        if (destroyed || authExpired || !state.active || !state.visible) return;
        const requestRevision = ++revision;
        abortRequests(true);
        const params = new URLSearchParams();
        if (state.search) params.set('search', state.search);
        if (state.selectedId) params.set('threadId', state.selectedId);
        if (state.threadsCursor) params.set('threadsCursor', state.threadsCursor);
        if (state.messagesCursor) params.set('messagesCursor', state.messagesCursor);
        state.loading = true; state.quietLoading = quiet;
        if (!quiet) state.error = '';
        emit();
        try {
            const data = assertInboxSchema(INBOX_RESPONSE_SCHEMA, await request(`${INBOX_API}${params.size ? `?${params}` : ''}`));
            if (destroyed || requestRevision !== revision || !state.active) return;
            state.data = data; state.loaded = true; state.sessionReady = true; state.error = '';
            for (const item of data.approvals) {
                if (item.status !== 'pending') { state.decisions.delete(item.id); state.drafts.delete(item.id); }
            }
        } catch (error) {
            if (!destroyed && requestRevision === revision) state.error = error?.message || 'Нет связи с кабинетом. Переписка обновится после восстановления связи.';
        } finally {
            if (!destroyed && requestRevision === revision) { state.loading = false; emit(); }
        }
    }
    function setActive(active) {
        if (destroyed || authExpired || state.active === active) return;
        state.active = active; revision++; state.loading = false;
        if (!active) abortRequests(true);
        if (accountId) state.sessionReady = false;
        startTimer();
        emit();
        if (active) void load({ quiet: state.loaded });
    }
    function setVisible(value) {
        if (state.visible === value || destroyed) return;
        state.visible = value; revision++; state.loading = false; startTimer();
        if (!value) abortRequests(true);
        if (accountId) state.sessionReady = false;
        emit();
        if (value && state.active) void load({ quiet: state.loaded });
    }
    function setSearch(value) {
        if (destroyed || authExpired) return Promise.resolve();
        const search = String(value).slice(0, 120).trim();
        if (state.search === search) return Promise.resolve();
        state.search = search; state.selectedId = null; state.detailOpen = false;
        state.threadsCursor = null; state.threadBack = []; state.messagesCursor = null;
        state.data = emptyData(); state.loaded = false; revision++; emit();
        return load();
    }
    function selectThread(id) {
        if (destroyed || authExpired) return Promise.resolve();
        const known = state.data.threads.find(item => item.id === id) || (state.data.selectedThread?.id === id ? state.data.selectedThread : null);
        if (!known) return Promise.resolve();
        state.selectedId = id; state.detailOpen = true; state.messagesCursor = null; revision++;
        state.data = { ...state.data, selectedThread: known, messages: [], approvals: [], messagePage: { olderCursor: null } };
        emit(); return load();
    }
    function closeThread() { if (!destroyed && !authExpired) { state.detailOpen = false; emit(); } }
    function threadPage(direction) {
        if (destroyed || authExpired || state.loading && !state.quietLoading) return Promise.resolve();
        if (direction > 0 && state.data.threadPage.nextCursor) {
            state.threadBack.push(state.threadsCursor); state.threadsCursor = state.data.threadPage.nextCursor;
        } else if (direction < 0 && state.threadBack.length) state.threadsCursor = state.threadBack.pop();
        else return Promise.resolve();
        revision++; return load();
    }
    function messagePage(older) {
        if (destroyed || authExpired || state.loading && !state.quietLoading || !state.selectedId || older && !state.data.messagePage.olderCursor) return Promise.resolve();
        state.messagesCursor = older ? state.data.messagePage.olderCursor : null;
        revision++; return load();
    }
    function setDraft(id, draft) { if (!destroyed && !authExpired) state.drafts.set(id, String(draft).slice(0, 4000)); }
    async function decide(action, id, draft) {
        if (destroyed || authExpired || !['approve', 'reject'].includes(action) || state.actions.has(id)) return false;
        const approval = snapshot().data.approvals.find(item => item.id === id);
        if (!approval || approval.status !== 'pending') {
            notice('Этот ответ уже обработан или срок согласования истёк. Черновик не отправлен.');
            emit(); return false;
        }
        const text = String(draft ?? state.drafts.get(id) ?? approval.draft).slice(0, 4000).trim();
        if (action === 'approve' && !text) { notice('Введите ответ перед согласованием.'); return false; }
        state.drafts.set(id, text); state.actions.add(id); revision++; state.loading = false; emit();
        try {
            const result = await request(WORKSPACE_API, { action, id, ...(action === 'approve' ? { draft: text } : {}) });
            if (destroyed || authExpired) return false;
            state.decisions.set(id, { ...approval, ...result.approval, status: result.approval?.status || (action === 'approve' ? 'approved' : 'rejected'), ...(action === 'approve' ? { draft: text } : {}) });
            state.drafts.delete(id);
            notice(action === 'approve' ? 'Ответ согласован. Ожидает отправки с Mac.' : 'Ответ отклонён. Агент его не отправит.');
            Promise.resolve(onDecision()).catch(() => {});
            return true;
        } catch (error) {
            if (!destroyed && state.active) notice(error?.message || 'Решение не сохранено. Черновик остался в этой вкладке.');
            return false;
        } finally {
            if (!destroyed) { state.actions.delete(id); emit(); void load({ quiet: true }); }
        }
    }
    function destroy() {
        if (destroyed) return;
        revision++; stopTimer(); abortRequests(); clearPrivateState(); emit(); destroyed = true;
    }
    return { snapshot, setActive, setVisible, setSearch, selectThread, closeThread, threadPage, messagePage, setDraft, decide, refresh: load, destroy };
}

export function renderInboxThreads(view) {
    if (!view.loaded && view.loading) return '<div class="ws-inbox-empty"><span class="ws-loading-dot" aria-hidden="true"></span><p>Загружаю чаты…</p></div>';
    if (!view.data.threads.length) return `<div class="ws-inbox-empty"><span aria-hidden="true">⌁</span><h3>${view.search ? 'Ничего не найдено' : 'Здесь появятся личные чаты'}</h3><p>${view.search ? 'Попробуйте другое имя или номер.' : 'Новые сообщения появятся после подключения и запуска WhatsApp на Mac. Предыдущая история не загружается.'}</p></div>`;
    return view.data.threads.map(thread => `<button type="button" class="ws-inbox-thread${thread.id === view.selectedId ? ' is-selected' : ''}" data-inbox-thread="${escapeHtml(thread.id)}" aria-pressed="${thread.id === view.selectedId}"><span class="ws-inbox-avatar" aria-hidden="true">${escapeHtml(thread.name.trim().slice(0, 1).toUpperCase() || '↗')}</span><span class="ws-inbox-thread-copy"><span class="ws-inbox-thread-top"><strong>${escapeHtml(thread.name || thread.address)}</strong><time datetime="${escapeHtml(thread.updatedAt)}">${escapeHtml(dateLabel(thread.updatedAt))}</time></span><span class="ws-inbox-address">${escapeHtml(thread.address)}</span><span class="ws-inbox-preview">${thread.lastDirection === 'outgoing' ? 'Агент: ' : ''}${escapeHtml(thread.preview || 'Вложение')}</span><span class="ws-inbox-thread-tags">${thread.origin === 'self_check' ? '<span class="ws-inbox-tag is-test">Самопроверка</span>' : ''}${thread.needsApproval ? '<span class="ws-inbox-tag is-review">Нужно решение</span>' : ''}</span></span></button>`).join('');
}

function renderApproval(approval, view) {
    const busy = view.actions.has(approval.id);
    const pending = approval.status === 'pending';
    return `<section class="ws-inbox-review" data-inbox-approval="${escapeHtml(approval.id)}" aria-labelledby="inbox-review-${escapeHtml(approval.id)}"><div class="ws-inbox-review-heading"><strong id="inbox-review-${escapeHtml(approval.id)}">${escapeHtml(approvalLabels[approval.status] || 'Статус согласования')}</strong>${pending ? `<time datetime="${escapeHtml(approval.expires_at)}">До ${escapeHtml(dateLabel(approval.expires_at))}</time>` : ''}</div><p class="ws-inbox-review-reason">${escapeHtml(approval.reason || 'Важный вопрос требует вашего решения.')}</p>${pending ? `<label for="inbox-draft-${escapeHtml(approval.id)}">Черновик · собеседнику не отправлен</label><textarea id="inbox-draft-${escapeHtml(approval.id)}" data-inbox-draft="${escapeHtml(approval.id)}" maxlength="4000" rows="3"${busy ? ' disabled' : ''}>${escapeHtml(view.drafts.get(approval.id) ?? approval.draft)}</textarea><div class="ws-inbox-review-actions"><button type="button" class="ws-primary" data-inbox-action="approve" data-id="${escapeHtml(approval.id)}"${busy ? ' disabled' : ''}>${busy ? 'Сохраняю…' : 'Согласовать ответ'}</button><button type="button" class="ws-secondary" data-inbox-action="reject" data-id="${escapeHtml(approval.id)}"${busy ? ' disabled' : ''}>Отклонить</button></div>` : `<p class="ws-inbox-draft">${escapeHtml(approval.draft)}</p><p class="ws-inbox-review-note">${escapeHtml(approval.status === 'uncertain' ? 'Сначала проверьте WhatsApp. Повторная отправка может создать дубликат.' : approval.status === 'sent' ? 'WhatsApp принял отправку. Доставка и прочтение собеседником не подтверждены.' : ['approved', 'dispatching'].includes(approval.status) ? 'Фактический ответ появится в истории после отправки агентом.' : 'Этот черновик больше не ожидает решения.')}</p>`}</section>`;
}

export function renderInboxConversation(view) {
    const thread = view.data.selectedThread;
    if (!thread) return '<div class="ws-inbox-empty ws-inbox-welcome"><span aria-hidden="true">↗</span><h2>Разговоры под вашим контролем.</h2><p>Выберите чат: здесь будут входящие, ответы агента и решения по важным вопросам.</p></div>';
    const approvals = new Map(view.data.approvals.map(item => [item.id, item]));
    const shownApprovals = new Set();
    const messages = view.data.messages.map(message => {
        const approval = approvals.get(message.approvalId);
        const showReview = approval && !shownApprovals.has(approval.id) && message.direction === 'incoming';
        if (showReview) shownApprovals.add(approval.id);
        const speaker = message.actor === 'contact' ? thread.name || thread.address : message.actor === 'agent' ? 'Ваш агент' : 'Система';
        return `<li class="ws-inbox-message is-${escapeHtml(message.direction)}" data-inbox-message="${escapeHtml(message.id)}"><div class="ws-inbox-bubble"><div class="ws-inbox-message-by"><strong>${escapeHtml(speaker)}</strong>${message.origin === 'self_check' ? '<span class="ws-inbox-tag is-test">Самопроверка</span>' : ''}</div>${message.kind !== 'text' ? `<p class="ws-inbox-media">${escapeHtml(mediaLabels[message.kind] || mediaLabels.unsupported)}</p>` : ''}${message.text ? `<p class="ws-inbox-text">${escapeHtml(message.text)}</p>` : ''}${message.reason === 'too_long' ? '<p class="ws-inbox-fragment">Показан фрагмент; полный текст — в WhatsApp.</p>' : ''}<div class="ws-inbox-message-meta"><span>${escapeHtml(inboxMessageStatus(message, approval))}</span><time datetime="${escapeHtml(message.occurredAt)}">${escapeHtml(dateLabel(message.occurredAt))}</time></div></div>${showReview ? renderApproval(approval, view) : ''}</li>`;
    }).join('');
    const remaining = [...approvals.values()].filter(item => !shownApprovals.has(item.id)).map(item => renderApproval(item, view)).join('');
    return `<header class="ws-inbox-conversation-heading"><button type="button" class="ws-icon-button ws-inbox-back" data-inbox-action="back" aria-label="Назад к чатам">←</button><div><h2 id="inbox-contact-title" tabindex="-1">${escapeHtml(thread.name || thread.address)}</h2><p>${escapeHtml(thread.address)}${thread.origin === 'self_check' ? ' · Самопроверка' : ''}</p></div></header><nav class="ws-inbox-message-paging" aria-label="История сообщений"><button type="button" class="ws-text-button" data-inbox-action="older"${view.loading || !view.data.messagePage.olderCursor ? ' disabled' : ''}>← Ранее</button><span>${view.messagesCursor ? 'Предыдущие сообщения' : 'Последние сообщения'}</span>${view.messagesCursor ? `<button type="button" class="ws-text-button" data-inbox-action="latest"${view.loading ? ' disabled' : ''}>К новым →</button>` : ''}</nav><div class="ws-inbox-scroll" id="inbox-message-scroll" tabindex="0" aria-label="Сообщения с ${escapeHtml(thread.name || thread.address)}">${view.loading && !view.data.messages.length ? '<div class="ws-inbox-empty"><p>Загружаю сообщения…</p></div>' : !view.data.messages.length ? '<div class="ws-inbox-empty"><p>Сообщений на этой странице пока нет.</p></div>' : `<ol class="ws-inbox-messages">${messages}</ol>`}${remaining}</div><p class="ws-inbox-delivery-note">«Передано WhatsApp» означает приём отправки сервисом. Доставка и прочтение здесь не отслеживаются.</p>`;
}

export function mountWhatsAppInbox({ document: doc = document, fetchImpl = globalThis.fetch, accountId = '', notice, onAuth, onDecision } = {}) {
    const $ = id => doc.getElementById(id);
    const layout = $('inbox-layout');
    const conversation = $('inbox-conversation');
    const threadList = $('inbox-thread-list');
    let searchTimer;
    let lastThreadMarkup = '';
    let lastConversationMarkup = '';
    let lastPage = '';
    const controller = createInboxController({ fetchImpl, accountId, notice, onAuth: () => { controller.destroy(); onAuth?.(); }, onDecision, visible: !doc.hidden, render: view => {
        layout.classList.toggle('is-detail-open', view.detailOpen);
        layout.setAttribute('aria-busy', String(view.loading));
        $('inbox-error').hidden = !view.error;
        $('inbox-error-copy').textContent = view.error;
        const status = view.data.status;
        $('inbox-status').textContent = !view.loaded ? 'Личные чаты · группы не записываются' : !status.deviceOnline ? 'Mac не на связи. Новые сообщения и ответы появятся после его запуска.' : !status.connected ? 'WhatsApp не подключён. Подключите его в разделе «Мои агенты».' : 'Mac на связи · WhatsApp подключён';
        $('inbox-capture-since').textContent = status.captureSince ? `История записывается с ${dateLabel(status.captureSince)}. Показаны новые личные сообщения, без загрузки старых переписок.` : 'История начнёт записываться после запуска WhatsApp на Mac. Старые переписки не загружаются.';
        const threads = renderInboxThreads(view);
        if (threads !== lastThreadMarkup) { threadList.innerHTML = threads; lastThreadMarkup = threads; }
        $('inbox-previous').disabled = view.loading || !view.threadBack.length;
        $('inbox-next').disabled = view.loading || !view.data.threadPage.nextCursor;
        $('inbox-thread-paging').hidden = !view.threadBack.length && !view.data.threadPage.nextCursor;
        const markup = renderInboxConversation(view);
        if (markup === lastConversationMarkup) return;
        const active = doc.activeElement;
        const focusedDraft = conversation.contains(active) ? active?.dataset?.inboxDraft : null;
        const selection = focusedDraft ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
        const oldScroll = $('inbox-message-scroll');
        const page = `${view.selectedId || ''}:${view.messagesCursor || ''}`;
        const nearBottom = oldScroll && oldScroll.scrollHeight - oldScroll.clientHeight - oldScroll.scrollTop < 70;
        const previousTop = oldScroll?.scrollTop || 0;
        conversation.innerHTML = markup; lastConversationMarkup = markup;
        const scroll = $('inbox-message-scroll');
        if (scroll) scroll.scrollTop = page !== lastPage ? view.messagesCursor ? 0 : scroll.scrollHeight : nearBottom ? scroll.scrollHeight : previousTop;
        lastPage = page;
        if (focusedDraft) {
            const editor = doc.getElementById(`inbox-draft-${focusedDraft}`);
            if (editor && !editor.disabled) { editor.focus({ preventScroll: true }); editor.setSelectionRange(...selection); }
            else $('inbox-contact-title')?.focus({ preventScroll: true });
        }
    } });
    const click = async event => {
        const thread = event.target.closest('[data-inbox-thread]');
        if (thread) {
            const id = thread.dataset.inboxThread;
            await controller.selectThread(id);
            if (controller.snapshot().selectedId === id) $('inbox-contact-title')?.focus({ preventScroll: true });
            return;
        }
        const button = event.target.closest('[data-inbox-action]');
        if (!button || button.disabled) return;
        const action = button.dataset.inboxAction;
        if (action === 'back') {
            controller.closeThread();
            threadList.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
        } else if (action === 'older' || action === 'latest') await controller.messagePage(action === 'older');
        else if (action === 'approve' || action === 'reject') {
            const editor = doc.getElementById(`inbox-draft-${button.dataset.id}`);
            await controller.decide(action, button.dataset.id, editor?.value);
        }
    };
    const input = event => { if (event.target.dataset.inboxDraft) controller.setDraft(event.target.dataset.inboxDraft, event.target.value); };
    const search = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { void controller.setSearch($('inbox-search').value); }, 250); };
    const retry = () => { void controller.refresh(); };
    const previous = () => { void controller.threadPage(-1); };
    const next = () => { void controller.threadPage(1); };
    const visibility = () => controller.setVisible(!doc.hidden);
    layout.addEventListener('click', click); layout.addEventListener('input', input);
    $('inbox-search').addEventListener('input', search); $('inbox-retry').addEventListener('click', retry);
    $('inbox-previous').addEventListener('click', previous); $('inbox-next').addEventListener('click', next);
    doc.addEventListener('visibilitychange', visibility);
    const destroy = controller.destroy;
    controller.destroy = () => {
        clearTimeout(searchTimer); layout.removeEventListener('click', click); layout.removeEventListener('input', input);
        $('inbox-search').removeEventListener('input', search); $('inbox-retry').removeEventListener('click', retry);
        $('inbox-previous').removeEventListener('click', previous); $('inbox-next').removeEventListener('click', next);
        doc.removeEventListener('visibilitychange', visibility); $('inbox-search').value = ''; destroy();
    };
    return controller;
}
