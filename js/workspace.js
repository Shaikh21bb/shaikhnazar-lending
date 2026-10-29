import { generateEnvelopeKeyPair, encryptEnvelope, decryptEnvelope } from '../lib/private-envelope.mjs';

const API = '/api/hub/workspace';
const REPLY_KEY_STORAGE = 'shaikh-private-reply-key-v1';
const VIEWS = new Set(['thoughts', 'reminders', 'agents', 'mac']);
const POLL_MS = 6000;
const state = { data: null, keys: null, decrypted: new Map(), approvalDrafts: new Map(), pendingThought: null, view: 'thoughts', loading: false, sending: false, clarification: null, pairing: null, qrJobId: null, qrAgentId: null, qrFingerprint: '', user: null };
const $ = id => document.getElementById(id);
let toastTimer;
let pollingTimer;
let previousDialogFocus;

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
    const response = await fetch(API, {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
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

function showView(view, updateHash = true) {
    if (!VIEWS.has(view)) view = 'thoughts';
    state.view = view;
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

function renderAgents() {
    const agents = state.data?.agents || [];
    const whatsappConnected = state.data?.device?.status?.whatsapp === 'connected' && deviceIsOnline();
    $('agents-list').innerHTML = agents.length ? agents.map(agent => {
        const whatsapp = agent.type === 'whatsapp';
        return `<article class="ws-agent"><div class="ws-agent-head"><span class="ws-agent-avatar ${whatsapp ? 'is-whatsapp' : ''}" aria-hidden="true">${whatsapp ? '↗' : '✦'}</span><span class="ws-state ${agent.enabled ? 'is-online' : ''}">${agent.enabled ? 'Включён' : 'Выключен'}</span></div><h2>${escapeHtml(agent.name)}</h2><p>${whatsapp ? 'Сам отвечает на общие вопросы и общается в личных чатах в вашем стиле. Личные решения передаёт вам и предупреждает собеседника.' : 'Собирает мысли в заметки и работает с вашей базой Obsidian локально.'}</p><div class="ws-agent-meta"><span>${whatsapp ? `WhatsApp · ${whatsappConnected && agent.enabled ? 'подключён' : 'на Mac'}` : 'Obsidian · на Mac'}</span><span>${agent.rules || agent.examples ? 'Ваши инструкции' : 'Правила ещё не заданы'}</span></div><div class="ws-agent-actions"><button class="ws-secondary" type="button" data-edit-agent="${escapeHtml(agent.id)}">Настроить</button>${whatsapp ? whatsappConnected && agent.enabled ? `<button class="ws-text-button" type="button" data-pause-whatsapp="${escapeHtml(agent.id)}">Остановить ответы</button>` : `<button class="ws-text-button" type="button" data-connect-whatsapp="${escapeHtml(agent.id)}">Подключить WhatsApp ↗</button>` : '<span class="ws-muted">Только локальная AI</span>'}</div></article>`;
    }).join('') : empty('✦', 'Создайте своего первого агента', 'Задайте ему роль, правила общения и несколько ваших примеров ответов.');
}

function renderApprovals() {
    const approvals = (state.data?.approvals || []).filter(approval => ['pending', 'awaiting_approval'].includes(approval.status));
    $('approval-badge').hidden = !approvals.length;
    $('approval-badge').textContent = String(approvals.length);
    $('mobile-approval-dot').hidden = !approvals.length;
    $('approval-total').textContent = approvals.length ? `${approvals.length} ждут решения` : '';
    const reasons = { money: 'Платёж или личное финансовое решение', meeting: 'Личная встреча или срок', commitment: 'Обещание или договорённость', conflict: 'Личный конфликт', sensitive: 'Личные данные', uncertain: 'Нужно уточнить важные сведения', model_unavailable: 'Модель сейчас недоступна', rate_limit: 'Лимит автоматических ответов' };
    $('approvals-list').innerHTML = approvals.length ? approvals.map(approval => `<article class="ws-approval" data-approval="${escapeHtml(approval.id)}"><div class="ws-approval-head"><div><strong>${escapeHtml(recipientLabel(approval))}</strong><span>${escapeHtml(reasons[approval.reason] || 'Новый ответ — нужно ваше решение')}</span></div><span class="ws-state">На согласовании</span></div><blockquote>${escapeHtml(approval.original || 'Входящее сообщение')}</blockquote><label for="approval-${escapeHtml(approval.id)}">Ответ агента — можно отредактировать<textarea id="approval-${escapeHtml(approval.id)}" maxlength="4000" rows="3">${escapeHtml(state.approvalDrafts.get(approval.id) ?? approval.draft ?? '')}</textarea></label><div class="ws-approval-actions"><button class="ws-text-button" type="button" data-approval-action="reject" data-id="${escapeHtml(approval.id)}">Не отправлять</button><button class="ws-primary" type="button" data-approval-action="approve" data-id="${escapeHtml(approval.id)}">Согласовать ответ <span aria-hidden="true">↗</span></button></div></article>`).join('') : empty('✓', 'Согласований пока нет', 'На общие вопросы AI отвечает сам. Здесь появятся личные встречи, платежи, обещания и другие вопросы, требующие вашего решения.');
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
    const connected = state.data?.device?.status?.whatsapp === 'connected' && deviceIsOnline();
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
    try {
        const data = await api();
        state.data = data.workspace || data;
        await decryptResults();
        renderDevice(); renderThoughts(); renderReminders(); renderAgents();
        // Preserve an edited draft while it is being reviewed.
        if (!document.activeElement?.matches('#approvals-list textarea')) renderApprovals();
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
    } finally { state.loading = false; }
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
    $('agent-examples').value = typeof agent?.examples === 'string' ? agent.examples : JSON.stringify(agent?.examples || '');
    $('agent-enabled').checked = agent?.enabled || false;
    $('agent-dialog-title').textContent = agent ? 'Настроить агента' : 'Создать агента';
    $('agent-form-feedback').textContent = '';
    openDialog($('agent-dialog'));
    $('agent-name').focus();
}

async function saveAgent(event) {
    event.preventDefault();
    const button = $('save-agent-button');
    button.disabled = true;
    const id = $('agent-id').value;
    const agent = { name: $('agent-name').value.trim(), type: $('agent-type').value, rules: $('agent-rules').value.trim(), examples: $('agent-examples').value.trim(), enabled: $('agent-enabled').checked };
    try {
        const result = await api({ action: id ? 'update_agent' : 'create_agent', ...(id ? { id } : {}), agent });
        if (!id && agent.type === 'whatsapp' && agent.enabled && result.agent?.id) {
            await api({ action: 'update_agent', id: result.agent.id, agent });
        }
        closeDialog($('agent-dialog'));
        toast(id ? 'Правила агента сохранены.' : 'Агент создан. Настройте подключение, чтобы он начал работать.');
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

async function handleApproval(action, id, button) {
    const article = button.closest('[data-approval]');
    const draft = article.querySelector('textarea').value.trim();
    if (action === 'approve' && !draft) { toast('Введите ответ перед согласованием.'); return; }
    article.querySelectorAll('button').forEach(item => { item.disabled = true; });
    try {
        await api({ action, id, ...(action === 'approve' ? { draft } : {}) });
        state.approvalDrafts.delete(id);
        toast(action === 'approve' ? 'Ответ согласован. Mac отправит его, когда будет на связи.' : 'Ответ отклонён. Агент его не отправит.');
        await refresh();
    } catch (error) { toast(error.message); article.querySelectorAll('button').forEach(item => { item.disabled = false; }); }
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
    $('pairing-button').addEventListener('click', createPairing);
    $('copy-pairing-button').addEventListener('click', copyPairing);
    $('agents-list').addEventListener('click', event => {
        const edit = event.target.closest('[data-edit-agent]');
        if (edit) { openAgent(edit.dataset.editAgent); return; }
        const connect = event.target.closest('[data-connect-whatsapp]');
        if (connect) connectWhatsApp(connect.dataset.connectWhatsapp, connect);
        const pause = event.target.closest('[data-pause-whatsapp]');
        if (pause) {
            pause.disabled = true;
            enqueueEncrypted('whatsapp_disconnect', { intent: 'whatsapp_disconnect', agentId: pause.dataset.pauseWhatsapp })
                .then(() => { toast('Запрос на остановку отправлен вашему Mac.'); return refresh(); })
                .catch(error => { toast(error.message); pause.disabled = false; });
        }
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
            try { sessionStorage.removeItem(REPLY_KEY_STORAGE); } catch { /* Storage may be disabled. */ }
            try { localStorage.removeItem('auth_token'); localStorage.removeItem('auth_email'); } catch { /* Storage may be disabled. */ }
            state.keys = null; state.decrypted.clear(); state.approvalDrafts.clear(); state.pendingThought = null;
            location.assign('/login.html');
        } catch (error) { toast(error.message); $('logout-button').disabled = false; }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh({ quiet: true }); });
    window.addEventListener('pagehide', () => { clearInterval(pollingTimer); });
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
        $('account-name').textContent = state.user?.name || state.user?.login || 'Мой кабинет';
        await refresh();
        pollingTimer = setInterval(() => { if (!document.hidden) refresh({ quiet: true }); }, POLL_MS);
    } catch (error) { showError(error); }
}

init();
