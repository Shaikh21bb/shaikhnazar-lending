import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { assertInboxSchema, INBOX_RESPONSE_SCHEMA } from '../lib/whatsapp-inbox-contract.mjs';
import { createInboxController, effectiveInboxApproval, inboxMessageStatus, inboxApprovalReason, renderInboxThreads, renderInboxConversation, mountWhatsAppInbox } from '../js/whatsapp-inbox.js';

const THREAD_A = '11111111-1111-4111-8111-111111111111';
const THREAD_B = '22222222-2222-4222-8222-222222222222';
const APPROVAL = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-10-31T07:00:00.000Z');
const timestamp = new Date(NOW).toISOString();
const thread = (id = THREAD_A, changes = {}) => ({ id, name: 'Тестовый контакт', address: '+70000000000', updatedAt: timestamp, preview: 'Тестовое сообщение', lastDirection: 'incoming', lastStatus: 'received', origin: 'live', needsApproval: false, ...changes });
const message = (changes = {}) => ({ id: 'a'.repeat(64), threadId: THREAD_A, direction: 'incoming', actor: 'contact', kind: 'text', text: 'Тестовое сообщение', status: 'received', occurredAt: timestamp, updatedAt: timestamp, approvalId: null, replyToId: null, origin: 'live', reason: null, ...changes });
const approval = (changes = {}) => ({ id: APPROVAL, agent_id: null, original: 'Тестовое сообщение', draft: 'Тестовый черновик', reason: 'Встреча', status: 'pending', expires_at: new Date(NOW + 60_000).toISOString(), created_at: timestamp, ...changes });
const responseData = (changes = {}) => assertInboxSchema(INBOX_RESPONSE_SCHEMA, { threads: [thread(), thread(THREAD_B, { name: 'Другой тестовый контакт' })], threadPage: { nextCursor: null }, selectedThread: null, messages: [], messagePage: { olderCursor: null }, approvals: [], status: { deviceOnline: true, connected: true, captureSince: timestamp }, ...changes });
const selectedData = (changes = {}) => responseData({ selectedThread: thread(), messages: [message()], ...changes });
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness({ handler = () => jsonResponse(responseData()), ...options } = {}) {
    const calls = []; const renders = []; const notices = []; const timers = new Set();
    const controller = createInboxController({
        fetchImpl: (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); },
        now: () => NOW, render: view => renders.push(view), notice: text => notices.push(text),
        setIntervalImpl: callback => { timers.add(callback); return callback; }, clearIntervalImpl: callback => timers.delete(callback), ...options
    });
    return { controller, calls, renders, notices, timers };
}

function requestClock() {
    const deadlines = new Map(); let nextId = 0;
    return {
        deadlines,
        setTimeoutImpl: (callback, delay) => { deadlines.set(++nextId, { callback, delay }); return nextId; },
        clearTimeoutImpl: id => deadlines.delete(id),
        expire() {
            assert.equal(deadlines.size, 1, 'one deadline spans the entire current request');
            const [id, deadline] = [...deadlines][0]; deadlines.delete(id); deadline.callback();
        }
    };
}

function mountedInbox(handler) {
    const nodes = new Map();
    const doc = { hidden: false, activeElement: null, addEventListener() {}, removeEventListener() {} };
    const node = id => {
        if (nodes.has(id)) return nodes.get(id);
        let html = ''; let top = 0;
        const item = { id, events: new Map(), dataset: {}, disabled: false, hidden: false, value: '', textContent: '', scrollHeight: 0, clientHeight: 200,
            classList: { toggle() {} }, setAttribute() {}, querySelector: () => null,
            addEventListener: (name, callback, capture = false) => item.events.set(`${name}:${capture}`, callback),
            removeEventListener: (name, callback, capture = false) => { if (item.events.get(`${name}:${capture}`) === callback) item.events.delete(`${name}:${capture}`); },
            contains: active => active?.owner === item,
            focus: () => { doc.activeElement = item; },
            setSelectionRange: (start, end, direction) => { item.selectionStart = start; item.selectionEnd = end; item.selectionDirection = direction; },
            get scrollTop() { return top; }, set scrollTop(value) { top = Math.min(Math.max(0, value), Math.max(0, item.scrollHeight - item.clientHeight)); },
            get innerHTML() { return html; }, set innerHTML(value) {
                html = value;
                if (id !== 'inbox-conversation') return;
                for (const [key, element] of nodes) if (element.owner === item) nodes.delete(key);
                if (value.includes('id="inbox-message-scroll"')) {
                    const scroll = node('inbox-message-scroll'); scroll.owner = item;
                    scroll.scrollHeight = 1000 + [...value.matchAll(/data-inbox-message=/g)].length * 100;
                    node('inbox-contact-title').owner = item;
                }
                for (const match of value.matchAll(/<textarea id="([^"]+)" data-inbox-draft="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) {
                    const editor = node(match[1]); editor.owner = item; editor.dataset.inboxDraft = match[2]; editor.value = match[3];
                }
            }
        };
        nodes.set(id, item); return item;
    };
    for (const id of ['inbox-layout', 'inbox-conversation', 'inbox-thread-list', 'inbox-error', 'inbox-error-copy', 'inbox-status', 'inbox-capture-since', 'inbox-previous', 'inbox-next', 'inbox-thread-paging', 'inbox-search', 'inbox-retry']) node(id);
    doc.getElementById = id => nodes.get(id) || null;
    const controller = mountWhatsAppInbox({ document: doc, fetchImpl: handler });
    return {
        controller, node, document: doc,
        scrollTo(top) { const scroll = node('inbox-message-scroll'); scroll.scrollTop = top; node('inbox-conversation').events.get('scroll:true')({ target: scroll }); },
        async click(action) {
            const target = { disabled: false, dataset: { inboxAction: action }, closest: selector => selector === '[data-inbox-action]' ? target : null };
            await node('inbox-layout').events.get('click:false')({ target });
        }
    };
}

test('serialized fixtures use the shared contract and rendering escapes private text and captions', () => {
    const unsafe = '</textarea><img src=x onerror="alert(1)">\nsecond line';
    const data = selectedData({ threads: [thread(THREAD_A, { name: unsafe, preview: unsafe })], selectedThread: thread(THREAD_A, { name: unsafe }), messages: [message({ kind: 'image', text: unsafe, approvalId: APPROVAL, origin: 'self_check', reason: 'too_long' })], approvals: [approval({ draft: unsafe, reason: unsafe })] });
    const view = { data, loaded: true, selectedId: THREAD_A, drafts: new Map(), actions: new Set(), threadBack: [] };
    const html = renderInboxThreads(view) + renderInboxConversation(view);
    assert.doesNotMatch(html, /<img|<script|<textarea[^>]*>\s*<\/textarea><img/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(html, /second line/);
    assert.match(html, /Фото/);
    assert.match(html, /Самопроверка/);
    assert.match(html, /Показан фрагмент; полный текст — в WhatsApp/);
    assert.match(html, /Черновик · собеседнику не отправлен/);
    assert.doesNotMatch(html, /Скачать|Транскрипция|Прочитано/);
});

test('all non-text kinds have placeholders without implying attachment download or transcription', () => {
    for (const kind of ['image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'unsupported']) {
        const view = { data: selectedData({ messages: [message({ kind, text: null })] }), drafts: new Map(), actions: new Set() };
        assert.match(renderInboxConversation(view), /ws-inbox-media/);
    }
});

test('approval reasons use familiar Russian labels and never expose unknown policy codes', () => {
    const reasons = {
        money: 'Платёж или личное финансовое решение', meeting: 'Личная встреча или срок',
        commitment: 'Обещание или договорённость', conflict: 'Личный конфликт', sensitive: 'Личные данные',
        uncertain: 'Нужно уточнить важные сведения', model_unavailable: 'Модель сейчас недоступна', rate_limit: 'Лимит автоматических ответов'
    };
    for (const [code, label] of Object.entries(reasons)) {
        const data = selectedData({ messages: [message({ approvalId: APPROVAL })], approvals: [approval({ reason: code })] });
        const html = renderInboxConversation({ data, drafts: new Map(), actions: new Set() });
        assert.match(html, new RegExp(`<p class="ws-inbox-review-reason">${label}</p>`));
        assert.doesNotMatch(html, new RegExp(`<p class="ws-inbox-review-reason">${code}</p>`));
    }
    for (const code of ['future_policy_code', 'meeting_v2', 'служебный_код', '', 'toString']) assert.equal(inboxApprovalReason(code), 'Нужно ваше решение');
    assert.equal(inboxApprovalReason('Нужно проверить время встречи'), 'Нужно проверить время встречи');
    const data = selectedData({ messages: [message({ approvalId: APPROVAL })], approvals: [approval({ reason: 'Нужно проверить <img src=x onerror=alert(1)>' })] });
    const html = renderInboxConversation({ data, drafts: new Map(), actions: new Set() });
    assert.match(html, /Нужно проверить &lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<img/);
});

test('Back from the browser cache reloads a disposed workspace to revalidate identity and restart Chats', () => {
    const events = new Map(); let reloads = 0; let disposals = 0; let stops = 0;
    const source = readFileSync(new URL('../js/workspace.js', import.meta.url), 'utf8').replace(/^import .*;\n/, '').replace(/\ninit\(\);\s*$/, '');
    runInNewContext(`${source}\ninboxController = { destroy() { disposed(); } }; bindEvents();`, {
        document: { querySelectorAll: () => [], getElementById: () => ({ addEventListener() {} }), addEventListener() {} },
        window: { addEventListener: (name, callback) => events.set(name, callback) },
        location: { reload: () => { reloads++; } }, disposed: () => { disposals++; }, clearInterval: () => { stops++; }
    });
    events.get('pageshow')({ persisted: false }); assert.equal(reloads, 0);
    events.get('pagehide')(); assert.equal(disposals, 1); assert.equal(stops, 1);
    events.get('pageshow')({ persisted: true }); assert.equal(reloads, 1);
});

test('polling runs only while Chats is active and visible, and resumes with the current search', async () => {
    const h = harness();
    await h.controller.refresh(); assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0);
    h.controller.setActive(true); await settle(); assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 1);
    [...h.timers][0](); await settle(); assert.equal(h.calls.length, 2);
    h.controller.setVisible(false); assert.equal(h.timers.size, 0);
    await h.controller.setSearch('Тест'); assert.equal(h.calls.length, 2);
    h.controller.setVisible(true); await settle(); assert.match(h.calls.at(-1).url, /search=/);
    h.controller.setActive(false); assert.equal(h.timers.size, 0);
    await h.controller.refresh(); assert.equal(h.calls.length, 3);
    h.controller.destroy();
});

test('late search responses cannot overwrite a newer search', async () => {
    const first = deferred(); const second = deferred();
    const h = harness({ handler: url => url.includes('search=first') ? first.promise : url.includes('search=second') ? second.promise : jsonResponse(responseData()) });
    h.controller.setActive(true); await settle();
    const a = h.controller.setSearch('first'); const b = h.controller.setSearch('second');
    second.resolve(jsonResponse(responseData({ threads: [thread(THREAD_B, { name: 'SECOND' })] }))); await b;
    first.resolve(jsonResponse(responseData({ threads: [thread(THREAD_A, { name: 'FIRST' })] }))); await a;
    assert.equal(h.controller.snapshot().search, 'second');
    assert.equal(h.controller.snapshot().data.threads[0].name, 'SECOND');
    h.controller.destroy();
});

test('late conversation responses cannot display messages from another selected contact', async () => {
    const a = deferred(); const b = deferred();
    const h = harness({ handler: url => url.includes(THREAD_A) ? a.promise : url.includes(THREAD_B) ? b.promise : jsonResponse(responseData()) });
    h.controller.setActive(true); await settle();
    const first = h.controller.selectThread(THREAD_A); const second = h.controller.selectThread(THREAD_B);
    b.resolve(jsonResponse(selectedData({ selectedThread: thread(THREAD_B), messages: [message({ threadId: THREAD_B, text: 'Второй контакт' })] }))); await second;
    a.resolve(jsonResponse(selectedData({ messages: [message({ text: 'Первый контакт' })] }))); await first;
    const view = h.controller.snapshot();
    assert.equal(view.selectedId, THREAD_B); assert.equal(view.data.selectedThread.id, THREAD_B);
    assert.equal(view.data.messages[0].text, 'Второй контакт');
    h.controller.destroy();
});

test('thread and older-message pagination keep opaque cursors across polling and support return to latest', async () => {
    const h = harness({ handler: url => jsonResponse(selectedData({ threadPage: { nextCursor: 'thread cursor/+' }, messagePage: { olderCursor: 'message cursor/+' } })) });
    h.controller.setActive(true); await settle(); await h.controller.selectThread(THREAD_A);
    await h.controller.threadPage(1);
    assert.equal(new URL(h.calls.at(-1).url, 'https://local.test').searchParams.get('threadsCursor'), 'thread cursor/+');
    await h.controller.messagePage(true); await h.controller.refresh({ quiet: true });
    const params = new URL(h.calls.at(-1).url, 'https://local.test').searchParams;
    assert.equal(params.get('messagesCursor'), 'message cursor/+'); assert.equal(params.get('threadId'), THREAD_A);
    await h.controller.messagePage(false);
    assert.equal(new URL(h.calls.at(-1).url, 'https://local.test').searchParams.has('messagesCursor'), false);
    await h.controller.threadPage(-1);
    assert.equal(new URL(h.calls.at(-1).url, 'https://local.test').searchParams.has('threadsCursor'), false);
    h.controller.destroy();
});

test('failed Next leaves page history intact; Next or explicit Retry succeeds and Back returns to page one', async () => {
    for (const retry of ['next', 'retry']) {
        let fail = true;
        const h = harness({ handler: url => {
            if (url.includes('threadsCursor=page-2') && fail) { fail = false; return jsonResponse({}, 503); }
            return jsonResponse(responseData({ threads: [thread(url.includes('threadsCursor=page-2') ? THREAD_B : THREAD_A)], threadPage: { nextCursor: url.includes('threadsCursor=page-2') ? null : 'page-2' } }));
        } });
        h.controller.setActive(true); await settle();
        await h.controller.threadPage(1);
        assert.equal(h.controller.snapshot().threadsCursor, null); assert.deepEqual(h.controller.snapshot().threadBack, []);
        assert.equal(h.controller.snapshot().data.threads[0].id, THREAD_A);
        const navigationError = h.controller.snapshot().error;
        await h.controller.refresh({ quiet: true });
        assert.equal(h.controller.snapshot().error, navigationError, 'a successful background refresh must keep the failed navigation retry available');
        assert.equal(h.controller.snapshot().threadsCursor, null);
        if (retry === 'next') await h.controller.threadPage(1); else await h.controller.refresh();
        assert.equal(h.controller.snapshot().data.threads[0].id, THREAD_B); assert.deepEqual(h.controller.snapshot().threadBack, [null]);
        await h.controller.threadPage(-1);
        assert.equal(h.controller.snapshot().data.threads[0].id, THREAD_A); assert.deepEqual(h.controller.snapshot().threadBack, []);
        h.controller.destroy();
    }
});

test('failed Older retains latest messages and label, then Retry loads the intended older page', async () => {
    let fail = true;
    const h = harness({ handler: url => {
        if (url.includes('messagesCursor=older') && fail) { fail = false; return jsonResponse({}, 503); }
        return jsonResponse(selectedData({ messages: [message({ text: url.includes('messagesCursor=older') ? 'Старое сообщение' : 'Последнее сообщение' })], messagePage: { olderCursor: 'older' } }));
    } });
    h.controller.setActive(true); await settle(); await h.controller.selectThread(THREAD_A);
    await h.controller.messagePage(true);
    assert.equal(h.controller.snapshot().messagesCursor, null); assert.match(renderInboxConversation(h.controller.snapshot()), /Последние сообщения/);
    assert.equal(h.controller.snapshot().data.messages[0].text, 'Последнее сообщение');
    await h.controller.refresh();
    assert.equal(h.controller.snapshot().messagesCursor, 'older'); assert.equal(h.controller.snapshot().data.messages[0].text, 'Старое сообщение');
    await h.controller.messagePage(false); assert.equal(h.controller.snapshot().messagesCursor, null);
    h.controller.destroy();
});

test('failed Back retains its history and can be retried without skipping a page', async () => {
    let failBack = false;
    const h = harness({ handler: url => {
        if (!url.includes('threadsCursor') && failBack) { failBack = false; return jsonResponse({}, 503); }
        return jsonResponse(responseData({ threadPage: { nextCursor: 'page-2' } }));
    } });
    h.controller.setActive(true); await settle(); await h.controller.threadPage(1); failBack = true;
    await h.controller.threadPage(-1);
    assert.equal(h.controller.snapshot().threadsCursor, 'page-2'); assert.deepEqual(h.controller.snapshot().threadBack, [null]);
    await h.controller.refresh();
    assert.equal(h.controller.snapshot().threadsCursor, null); assert.deepEqual(h.controller.snapshot().threadBack, []);
    h.controller.destroy();
});

test('an obsolete navigation failure cannot roll back a newer selection or poison its Retry', async () => {
    const oldPage = deferred();
    const h = harness({ handler: url => url.includes('threadsCursor') ? oldPage.promise : jsonResponse(responseData({ threadPage: { nextCursor: 'page-2' }, ...(url.includes(THREAD_B) ? { selectedThread: thread(THREAD_B) } : {}) })) });
    h.controller.setActive(true); await settle();
    const old = h.controller.threadPage(1); await settle();
    await h.controller.selectThread(THREAD_B); oldPage.reject(new Error('Old failure')); await old;
    await h.controller.refresh();
    assert.equal(h.controller.snapshot().selectedId, THREAD_B); assert.equal(h.controller.snapshot().threadsCursor, null);
    assert.equal(h.controller.snapshot().error, ''); assert.doesNotMatch(h.calls.at(-1).url, /threadsCursor/);
    h.controller.destroy();
});

test('one finite read deadline covers session checks, API fetch and each JSON body, and polling recovers', async () => {
    for (const phase of ['session-before-fetch', 'session-before-json', 'inbox-fetch', 'inbox-json', 'session-after-fetch', 'session-after-json']) {
        const clock = requestClock(); let stall = true; let sessions = 0;
        const never = new Promise(() => {});
        const h = harness({ accountId: 'owner', requestTimeoutMs: 37, ...clock, handler: url => {
            const session = url === '/api/auth/session';
            const step = session ? `session-${++sessions === 1 ? 'before' : 'after'}` : 'inbox';
            if (stall && phase === `${step}-fetch`) return never;
            if (stall && phase === `${step}-json`) return { status: 200, ok: true, json: () => never };
            return jsonResponse(session ? { user: { sub: 'owner' } } : responseData());
        } });
        h.controller.setActive(true); await settle();
        assert.equal(h.controller.snapshot().loading, true, phase); assert.equal([...clock.deadlines.values()][0].delay, 37);
        clock.expire(); await settle();
        assert.equal(h.controller.snapshot().loading, false, phase); assert.match(h.controller.snapshot().error, /не ответил вовремя/, phase);
        assert.ok(h.calls.every(call => call.init.signal.aborted));
        stall = false; [...h.timers][0](); await settle();
        assert.equal(h.controller.snapshot().loaded, true, phase); assert.equal(h.controller.snapshot().error, '', phase); assert.equal(clock.deadlines.size, 0);
        h.controller.destroy();
    }
});

test('a stalled refresh retains the last conversation and edited draft, then allows another poll', async () => {
    const clock = requestClock(); let stall = false;
    const data = selectedData({ approvals: [approval()], messages: [message({ approvalId: APPROVAL })] });
    const h = harness({ ...clock, handler: () => stall ? new Promise(() => {}) : jsonResponse(data) });
    h.controller.setActive(true); await settle(); await h.controller.selectThread(THREAD_A);
    h.controller.setDraft(APPROVAL, 'Мой текст'); stall = true;
    const read = h.controller.refresh({ quiet: true }); await settle(); clock.expire(); await read;
    assert.equal(h.controller.snapshot().data.messages[0].text, 'Тестовое сообщение'); assert.equal(h.controller.snapshot().drafts.get(APPROVAL), 'Мой текст');
    stall = false; [...h.timers][0](); await settle(); assert.equal(h.controller.snapshot().error, '');
    h.controller.destroy();
});

test('a decision timeout releases controls, keeps the draft, explains uncertainty and reconciles without replaying POST', async () => {
    const clock = requestClock(); const delayedPost = deferred(); let status = 'pending'; let notifications = 0;
    const h = harness({ ...clock, onDecision: () => { notifications++; }, handler: (_url, init) => init.method === 'POST' ? delayedPost.promise : jsonResponse(selectedData({ approvals: [approval({ status })], messages: [message({ approvalId: APPROVAL })] })) });
    h.controller.setActive(true); await settle(); await h.controller.selectThread(THREAD_A);
    const action = h.controller.decide('approve', APPROVAL, 'Мой текст'); await settle(); clock.expire();
    assert.equal(await action, false); await settle();
    assert.equal(h.controller.snapshot().actions.size, 0); assert.equal(h.controller.snapshot().drafts.get(APPROVAL), 'Мой текст');
    assert.match(h.notices.at(-1), /Статус пока неизвестен/); assert.equal(notifications, 0);
    assert.equal(h.controller.snapshot().data.approvals[0].status, 'pending');
    delayedPost.resolve(jsonResponse({ approval: { status: 'sent' } })); await settle();
    assert.equal(h.controller.snapshot().data.approvals[0].status, 'pending'); assert.equal(h.controller.snapshot().decisions.size, 0);
    status = 'approved'; [...h.timers][0](); await settle();
    assert.equal(h.controller.snapshot().data.approvals[0].status, 'approved'); assert.equal(h.controller.snapshot().drafts.size, 0);
    assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 1); assert.equal(clock.deadlines.size, 0);
    h.controller.destroy();
});

test('new message IDs while reading above the bottom produce a counted jump; status updates do not count', async () => {
    let messages = [message()];
    const ui = mountedInbox(() => jsonResponse(selectedData({ messages })));
    try {
        ui.controller.setActive(true); await settle(); await ui.controller.selectThread(THREAD_A);
        assert.doesNotMatch(ui.node('inbox-conversation').innerHTML, /data-inbox-action="new-messages"/);
        ui.scrollTo(100); messages = [...messages, message({ id: 'b'.repeat(64), text: 'Новое' })];
        await ui.controller.refresh({ quiet: true });
        assert.equal(ui.node('inbox-message-scroll').scrollTop, 100); assert.match(ui.node('inbox-conversation').innerHTML, /Новые сообщения · 1 ↓/);
        assert.match(ui.node('inbox-conversation').innerHTML, /id="inbox-message-scroll"[^>]*>[\s\S]*class="ws-inbox-new-messages"[^>]*>[^<]*<\/button><\/div><p class="ws-inbox-delivery-note"/, 'the sticky jump belongs inside the message scrollport');
        messages = messages.map(item => ({ ...item, status: 'answered' })); await ui.controller.refresh({ quiet: true });
        assert.match(ui.node('inbox-conversation').innerHTML, /Новые сообщения · 1 ↓/);
        messages = [...messages, message({ id: 'c'.repeat(64) })]; await ui.controller.refresh({ quiet: true });
        assert.match(ui.node('inbox-conversation').innerHTML, /Новые сообщения · 2 ↓/);
        await ui.click('new-messages');
        const scroll = ui.node('inbox-message-scroll'); assert.equal(scroll.scrollTop, scroll.scrollHeight - scroll.clientHeight);
        assert.doesNotMatch(ui.node('inbox-conversation').innerHTML, /data-inbox-action="new-messages"/); assert.equal(ui.document.activeElement, scroll);
    } finally { ui.controller.destroy(); }
});

test('new IDs auto-scroll at the bottom; returning to latest or changing contact never creates a false jump', async () => {
    let messages = [message()];
    const ui = mountedInbox(url => jsonResponse(selectedData({ selectedThread: thread(url.includes(THREAD_B) ? THREAD_B : THREAD_A), messages: messages.map(item => ({ ...item, threadId: url.includes(THREAD_B) ? THREAD_B : THREAD_A })), messagePage: { olderCursor: 'older' } })));
    try {
        ui.controller.setActive(true); await settle(); await ui.controller.selectThread(THREAD_A);
        messages = [...messages, message({ id: 'b'.repeat(64) })]; await ui.controller.refresh({ quiet: true });
        let scroll = ui.node('inbox-message-scroll'); assert.equal(scroll.scrollTop, scroll.scrollHeight - scroll.clientHeight);
        assert.doesNotMatch(ui.node('inbox-conversation').innerHTML, /data-inbox-action="new-messages"/);
        ui.scrollTo(0); await ui.controller.messagePage(true);
        messages = [...messages, message({ id: 'c'.repeat(64) })]; await ui.controller.refresh({ quiet: true });
        assert.doesNotMatch(ui.node('inbox-conversation').innerHTML, /data-inbox-action="new-messages"/);
        await ui.controller.messagePage(false); assert.doesNotMatch(ui.node('inbox-conversation').innerHTML, /data-inbox-action="new-messages"/);
        ui.scrollTo(0); await ui.controller.selectThread(THREAD_B);
        assert.doesNotMatch(ui.node('inbox-conversation').innerHTML, /data-inbox-action="new-messages"/);
    } finally { ui.controller.destroy(); }
});

test('scrolling manually to the bottom clears the jump and disposal removes its scroll listener', async () => {
    let messages = [message()]; const ui = mountedInbox(() => jsonResponse(selectedData({ messages })));
    ui.controller.setActive(true); await settle(); await ui.controller.selectThread(THREAD_A);
    ui.scrollTo(0); messages = [...messages, message({ id: 'b'.repeat(64) })]; await ui.controller.refresh({ quiet: true });
    assert.match(ui.node('inbox-conversation').innerHTML, /Новые сообщения · 1 ↓/);
    ui.scrollTo(ui.node('inbox-message-scroll').scrollHeight);
    assert.doesNotMatch(ui.node('inbox-conversation').innerHTML, /data-inbox-action="new-messages"/);
    ui.controller.destroy(); assert.equal(ui.node('inbox-conversation').events.has('scroll:true'), false);
});

test('edits survive polling and a repeated click cannot submit the same approval twice', async () => {
    const decision = deferred();
    const data = selectedData({ messages: [message({ approvalId: APPROVAL, status: 'awaiting_approval' })], approvals: [approval()] });
    const h = harness({ handler: (url, init) => init.method === 'POST' ? decision.promise : jsonResponse(data) });
    h.controller.setActive(true); await settle(); await h.controller.selectThread(THREAD_A);
    h.controller.setDraft(APPROVAL, 'Мой отредактированный ответ');
    await h.controller.refresh({ quiet: true });
    assert.match(renderInboxConversation(h.controller.snapshot()), /Мой отредактированный ответ/);
    const first = h.controller.decide('approve', APPROVAL);
    assert.equal(await h.controller.decide('approve', APPROVAL), false);
    assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 1);
    assert.deepEqual(JSON.parse(h.calls.find(call => call.init.method === 'POST').init.body), { action: 'approve', id: APPROVAL, draft: 'Мой отредактированный ответ' });
    decision.resolve(jsonResponse({ approval: { status: 'approved' } })); assert.equal(await first, true); await settle();
    const view = h.controller.snapshot();
    assert.equal(view.data.approvals[0].status, 'approved');
    assert.equal(view.drafts.has(APPROVAL), false);
    const html = renderInboxConversation(view);
    assert.match(html, /Согласовано · ожидает Mac/); assert.doesNotMatch(html, /data-inbox-action="approve"|is-outgoing/);
    assert.equal(await h.controller.decide('approve', APPROVAL), false);
    h.controller.destroy();
});

test('a failed decision retains its draft and refreshes authoritative agreement state', async () => {
    let requests = 0;
    const h = harness({ handler: (_url, init) => {
        if (init.method === 'POST') return jsonResponse({ error: 'Согласование уже изменилось.' }, 409);
        requests++; return jsonResponse(selectedData({ messages: [message({ approvalId: APPROVAL })], approvals: [approval()] }));
    } });
    h.controller.setActive(true); await settle(); await h.controller.selectThread(THREAD_A);
    assert.equal(await h.controller.decide('approve', APPROVAL, 'Сохранить мой текст'), false); await settle();
    assert.equal(h.controller.snapshot().drafts.get(APPROVAL), 'Сохранить мой текст');
    assert.match(h.notices.at(-1), /уже изменилось/); assert.equal(requests, 3);
    h.controller.destroy();
});

test('remote rejection or expiration removes stale controls and updates incoming status', async () => {
    const expired = effectiveInboxApproval(approval({ expires_at: new Date(NOW - 1).toISOString() }), NOW);
    assert.equal(expired.status, 'expired');
    let status = 'pending';
    const h = harness({ handler: () => jsonResponse(selectedData({ messages: [message({ approvalId: APPROVAL, status: 'awaiting_approval' })], approvals: [approval({ status })] })) });
    h.controller.setActive(true); await settle(); await h.controller.selectThread(THREAD_A);
    h.controller.setDraft(APPROVAL, 'Старый черновик'); status = 'rejected'; await h.controller.refresh();
    const view = h.controller.snapshot();
    assert.equal(view.drafts.has(APPROVAL), false);
    assert.equal(inboxMessageStatus(view.data.messages[0], view.data.approvals[0]), 'Ответ отклонён');
    assert.doesNotMatch(renderInboxConversation(view), /data-inbox-action="approve"|Нужно согласование|Старый черновик/);
    assert.equal(await h.controller.decide('approve', APPROVAL, 'Новый текст'), false);
    assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 0);
    h.controller.destroy();
});

test('expired pending approvals cannot be sent even before the next poll', async () => {
    const h = harness({ handler: () => jsonResponse(selectedData({ messages: [message({ approvalId: APPROVAL })], approvals: [approval({ expires_at: new Date(NOW - 1).toISOString() })] })) });
    h.controller.setActive(true); await settle(); await h.controller.selectThread(THREAD_A);
    assert.equal(await h.controller.decide('approve', APPROVAL), false);
    assert.doesNotMatch(renderInboxConversation(h.controller.snapshot()), /<textarea|data-inbox-action="approve"/);
    h.controller.destroy();
});

test('outgoing uncertainty and service acceptance never claim delivery or read status', () => {
    const data = selectedData({ messages: [message({ direction: 'outgoing', actor: 'agent', status: 'uncertain' }), message({ id: 'b'.repeat(64), direction: 'outgoing', actor: 'system', status: 'sent' })] });
    const html = renderInboxConversation({ data, drafts: new Map(), actions: new Set() });
    assert.match(html, /Исход отправки неизвестен/); assert.match(html, /Передано WhatsApp/);
    assert.match(html, /Доставка и прочтение здесь не отслеживаются/);
    assert.doesNotMatch(html, />Доставлено<|>Прочитано</);
});

test('unauthorized responses clear private data and drafts, stop polling and redirect once', async () => {
    let expired = false; let redirects = 0;
    const h = harness({ onAuth: () => { redirects++; }, handler: () => expired ? jsonResponse({}, 401) : jsonResponse(selectedData()) });
    h.controller.setActive(true); await settle(); h.controller.setDraft(APPROVAL, 'Личный черновик');
    expired = true; await h.controller.refresh();
    const view = h.controller.snapshot();
    assert.equal(redirects, 1); assert.equal(view.data.messages.length, 0); assert.equal(view.drafts.size, 0);
    assert.equal(view.active, false); assert.equal(h.timers.size, 0);
    h.controller.destroy();
});

test('network and malformed response errors retain the last coherent conversation', async () => {
    let broken = false;
    const h = harness({ handler: () => broken ? jsonResponse({ threads: [] }) : jsonResponse(selectedData()) });
    h.controller.setActive(true); await settle(); broken = true; await h.controller.refresh();
    assert.equal(h.controller.snapshot().data.messages[0].text, 'Тестовое сообщение');
    assert.ok(h.controller.snapshot().error);
    h.controller.destroy();
});

test('disposing aborts every in-flight read and decision and late responses cannot restore private state', async () => {
    const read = deferred(); const decision = deferred(); let pendingRead = false;
    const data = selectedData({ messages: [message({ approvalId: APPROVAL })], approvals: [approval()] });
    const h = harness({ handler: (_url, init) => init.method === 'POST' ? decision.promise : pendingRead ? read.promise : jsonResponse(data) });
    h.controller.setActive(true); await settle(); await h.controller.selectThread(THREAD_A);
    h.controller.setDraft(APPROVAL, 'Приватный текст');
    const mutation = h.controller.decide('approve', APPROVAL); await settle();
    pendingRead = true; const request = h.controller.refresh({ quiet: true }); await settle();
    const pendingCalls = h.calls.slice(-2);
    h.controller.destroy();
    assert.equal(pendingCalls.length, 2);
    assert.ok(pendingCalls.every(call => call.init.signal.aborted));
    assert.equal(h.controller.snapshot().data.messages.length, 0); assert.equal(h.controller.snapshot().drafts.size, 0);
    read.resolve(jsonResponse(data)); decision.resolve(jsonResponse({ approval: { status: 'approved' } }));
    await Promise.all([request, mutation]);
    const view = h.controller.snapshot();
    assert.equal(view.data.threads.length, 0); assert.equal(view.data.messages.length, 0);
    assert.equal(view.decisions.size, 0); assert.equal(view.drafts.size, 0);
    assert.doesNotMatch(renderInboxConversation(view), /Приватный текст|Тестовый контакт|Тестовое сообщение/);
});

test('a decision response arriving after401 cannot restore a private draft or optimistic approval', async () => {
    let expired = false; const decision = deferred(); let redirects = 0;
    const data = selectedData({ messages: [message({ approvalId: APPROVAL })], approvals: [approval()] });
    const h = harness({ onAuth: () => { redirects++; }, handler: (_url, init) => init.method === 'POST' ? decision.promise : expired ? jsonResponse({}, 401) : jsonResponse(data) });
    h.controller.setActive(true); await settle(); await h.controller.selectThread(THREAD_A);
    const action = h.controller.decide('approve', APPROVAL, 'Личный черновик'); await settle();
    const mutationCall = h.calls.at(-1); expired = true; await h.controller.refresh();
    assert.equal(mutationCall.init.signal.aborted, true);
    decision.resolve(jsonResponse({ approval: { status: 'approved', draft: 'Личный черновик' } })); await action;
    assert.equal(redirects, 1); assert.equal(h.controller.snapshot().decisions.size, 0);
    assert.equal(h.controller.snapshot().drafts.size, 0); assert.equal(h.controller.snapshot().data.messages.length, 0);
    h.controller.destroy();
});

test('account is verified before and after private requests; a switch disposes without displaying either account history', async () => {
    let identity = 'owner-a'; let waitForInbox = false; let redirects = 0;
    const deferredInbox = deferred();
    const h = harness({ accountId: 'owner-a', onAuth: () => { redirects++; }, handler: url => {
        if (url === '/api/auth/session') return jsonResponse({ user: { sub: identity } });
        return waitForInbox ? deferredInbox.promise : jsonResponse(selectedData());
    } });
    h.controller.setActive(true); await settle();
    assert.equal(h.controller.snapshot().data.messages.length, 1);
    waitForInbox = true; const request = h.controller.refresh({ quiet: true }); await settle();
    identity = 'owner-b'; deferredInbox.resolve(jsonResponse(selectedData({ messages: [message({ text: 'Чужая история' })] })));
    await request;
    assert.equal(redirects, 1); assert.equal(h.controller.snapshot().data.messages.length, 0);
    assert.equal(h.timers.size, 0);
    assert.ok(h.renders.every(view => !view.data.messages.some(item => item.text === 'Чужая история')));
    assert.equal(h.calls.filter(call => call.url === '/api/auth/session').length, 4);
    h.controller.destroy();
});

test('the search input and request both cap search at the server limit120', async () => {
    const h = harness(); h.controller.setActive(true); await settle();
    await h.controller.setSearch('я'.repeat(150));
    assert.equal(new URL(h.calls.at(-1).url, 'https://local.test').searchParams.get('search').length, 120);
    const html = readFileSync(new URL('../workspace.html', import.meta.url), 'utf8');
    assert.match(html, /id="inbox-search"[^>]+maxlength="120"/);
    h.controller.destroy();
});

test('workspace exposes Chats on desktop and phone without a manual-send composer or plaintext persistence', () => {
    const html = readFileSync(new URL('../workspace.html', import.meta.url), 'utf8');
    const module = readFileSync(new URL('../js/whatsapp-inbox.js', import.meta.url), 'utf8');
    const workspace = readFileSync(new URL('../js/workspace.js', import.meta.url), 'utf8');
    assert.equal((html.match(/href="#chats" data-view="chats"/g) || []).length, 2);
    assert.match(html, /id="view-chats"/);
    const scriptVersion = html.match(/workspace\.js\?v=([a-z0-9]+)/)?.[1];
    const inboxVersion = workspace.match(/await import\('\.\/whatsapp-inbox\.js\?v=([a-z0-9]+)'\)/)?.[1];
    assert.ok(scriptVersion);
    assert.equal(inboxVersion, scriptVersion, 'Lazy chat module must ship with the workspace revision');
    assert.doesNotMatch(module, /sessionStorage|localStorage|indexedDB|document\.cookie|data-inbox-action="send"/);
});
