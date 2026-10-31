import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../js/workspace.js', import.meta.url), 'utf8')).replace(/^import .*;\n/, '').replace(/\ninit\(\);\s*$/, '');
const future = '2036-10-31T10:00:00Z';
const past = '2000-01-01T10:00:00Z';
const pending = (id, extra = {}) => ({ id, status: 'pending', recipient: '12345@s.whatsapp.net', original: 'Встреча завтра?', draft: 'Проверю расписание.', created_at: '2026-10-31T09:00:00Z', expires_at: future, ...extra });
const agent = (id, enabled) => ({ id, type: 'whatsapp', name: `Агент ${id}`, enabled, rules: '', examples: '' });
const decode = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function browser({ data = {}, respond } = {}) {
    const nodes = new Map(), calls = [], expanded = [];
    const document = { activeElement: null, hidden: false, querySelectorAll: selector => selector === '#approval-history-list details[open]' ? expanded : [], addEventListener() {} };
    function element(id) {
        if (nodes.has(id)) return nodes.get(id);
        let html = '';
        const node = { id, value: '', textContent: '', disabled: false, hidden: false, checked: false, open: false, dataset: {}, attributes: {}, events: {}, selectionStart: 0, selectionEnd: 0, scrollTop: 0,
            classList: { toggle() {} }, reset() {}, showModal() { this.open = true; }, close() { this.open = false; },
            addEventListener(name, handler) { this.events[name] = handler; }, setAttribute(name, value) { this.attributes[name] = value; },
            focus() { document.activeElement = this; }, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
            matches(selector) { return selector === '#approvals-list textarea' && this.tagName === 'TEXTAREA'; },
            closest(selector) { return selector === '[data-approval]' ? this.article || null : null; },
            querySelector(selector) { return selector === 'textarea' && this.textarea ? this.textarea : element(`${id}/${selector}`); },
            querySelectorAll(selector) { return selector === 'button' ? this.buttons || [] : []; },
            get innerHTML() { return html; }, set innerHTML(value) {
                html = value;
                if (id !== 'approvals-list') return;
                if (document.activeElement?.matches('#approvals-list textarea')) document.activeElement = null;
                for (const key of nodes.keys()) if (key.startsWith('approval-') && nodes.get(key).tagName === 'TEXTAREA') nodes.delete(key);
                for (const match of value.matchAll(/<textarea id="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) {
                    const input = element(decode(match[1]));
                    const approvalId = input.id.slice('approval-'.length);
                    input.tagName = 'TEXTAREA'; input.value = decode(match[2]);
                    const article = element(`article/${approvalId}`);
                    article.dataset.approval = approvalId; article.textarea = input; input.article = article;
                    article.buttons = ['approve', 'reject'].map(action => {
                        const button = element(`button/${approvalId}/${action}`); button.article = article; return button;
                    });
                }
            }
        };
        nodes.set(id, node); return node;
    }
    document.getElementById = element;
    const context = vm.createContext({ document, window: { addEventListener() {}, scrollTo() {} }, location: { origin: 'https://fixture.example', hash: '', assign() {} }, history: { replaceState() {} },
        sessionStorage: { getItem: () => null }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, requestAnimationFrame: cb => cb(),
        fetch: async (url, options = {}) => {
            const body = options.body ? JSON.parse(options.body) : null;
            calls.push({ url, body });
            const result = respond ? await respond({ url, body, calls, data }) : { data: body ? { agent: { id: 'created' } } : data };
            return { ok: result.status === undefined || result.status < 400, status: result.status || 200, json: async () => result.data };
        }
    });
    vm.runInContext(source, context);
    context.fixture = data;
    vm.runInContext('state.data = fixture', context);
    return { run: code => vm.runInContext(code, context), context, calls, node: element, document, expanded };
}

function fillAgentForm(ui, { id = '', enabled = true } = {}) {
    ui.node('agent-id').value = id;
    ui.node('agent-type').value = 'whatsapp';
    ui.node('agent-name').value = 'Новая роль';
    ui.node('agent-enabled').checked = enabled;
}

function approvalButton(ui, id, action = 'approve') { return ui.node(`button/${id}/${action}`); }

const preventDefault = () => {};

test('a new WhatsApp role is visibly disabled and uses one create request even if checkbox is forced on', async () => {
    const ui = browser({ data: { agents: [agent('current', true)] } });
    ui.run('openAgent()');
    assert.equal(ui.node('agent-examples').value, '', 'an absent examples field must be empty, without literal JSON quotes');
    assert.equal(ui.node('agent-enabled').disabled, true);
    assert.match(ui.node('agent-activation-hint').textContent, /сохранится выключенным/);
    fillAgentForm(ui);
    ui.context.event = { preventDefault };
    await ui.run('saveAgent(event)');
    const writes = ui.calls.filter(call => call.body);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.action, 'create_agent');
    assert.equal(writes[0].body.agent.enabled, false);
    assert.match(ui.node('workspace-toast').textContent, /создан выключенным/);
});

test('an existing disabled role explains the active role and cannot silently enable alongside it', async () => {
    const ui = browser({ data: { agents: [agent('current', true), agent('next', false)] } });
    ui.run("openAgent('next')");
    assert.equal(ui.node('agent-enabled').disabled, true);
    assert.match(ui.node('agent-activation-hint').textContent, /Агент current/);
    fillAgentForm(ui, { id: 'next', enabled: true });
    ui.context.event = { preventDefault };
    await ui.run('saveAgent(event)');
    assert.equal(ui.calls.length, 0);
    assert.match(ui.node('agent-form-feedback').textContent, /Сначала остановите ответы/);
});

test('stopping replies disables the server agent even when Mac and its encryption key are unavailable', async () => {
    const data = { agents: [agent('current', true)], device: null };
    const ui = browser({ data, respond: ({ body }) => {
        if (body) { data.agents[0].enabled = false; return { data: { agent: data.agents[0] } }; }
        return { data };
    } });
    ui.context.button = ui.node('pause');
    await ui.run("pauseWhatsApp('current', button)");
    assert.deepEqual(ui.calls.filter(call => call.body).map(call => call.body), [{ action: 'update_agent', id: 'current', agent: { enabled: false } }]);
    assert.match(ui.node('workspace-toast').textContent, /при следующей связи/);
    assert.match(ui.node('agents-list').innerHTML, /Выключен/);
    assert.doesNotMatch(ui.node('agents-list').innerHTML, /data-connect-whatsapp/);
});

test('WhatsApp badges distinguish enabled, transport connected, paused, offline and duplicate activation', () => {
    const data = { agents: [agent('a', true), agent('b', false)], device: { last_seen_at: new Date().toISOString(), status: { state: 'ready', whatsapp: 'connected' } } };
    const ui = browser({ data });
    assert.equal(ui.run('whatsAppAgentStatus(state.data.agents[0]).connected'), true);
    assert.equal(ui.run('whatsAppAgentStatus(state.data.agents[1]).label'), 'Выключен');
    data.device.status.whatsapp = 'paused';
    assert.equal(ui.run('whatsAppAgentStatus(state.data.agents[0]).label'), 'Приостановлен');
    data.device.last_seen_at = past;
    ui.run('renderAgents()');
    assert.match(ui.node('agents-list').innerHTML, /Ждёт Mac/);
    assert.match(ui.node('agents-list').innerHTML, /data-pause-whatsapp="a"/);
    data.agents[1].enabled = true;
    assert.equal(ui.run('whatsAppAgentStatus(state.data.agents[0]).connected'), false);
    assert.equal(ui.run('whatsAppAgentStatus(state.data.agents[1]).connected'), false);
});

test('history exposes delivery uncertainty safely and never adds automatic resend controls', () => {
    const history = ['approved', 'dispatching', 'sent', 'failed', 'uncertain', 'rejected', 'expired', 'new-status'].map((status, i) => pending(`history-${i}`, { status, recipient_name: '<img src=x onerror=alert(1)>', original: '<script>secret()</script>', draft: '<b>мой ответ</b>' }));
    const ui = browser({ data: { approvals: [], approvalHistory: history } });
    ui.run('renderApprovals()');
    const output = ui.node('approval-history-list').innerHTML;
    for (const label of ['Ждёт отправки', 'Отправляется', 'Передано WhatsApp', 'Не отправлено', 'Исход неизвестен', 'Отклонено', 'Срок истёк', 'Статус уточняется']) assert.ok(output.includes(label), label);
    assert.match(output, /не подтверждает доставку на телефон/);
    assert.match(output, /&lt;script&gt;secret\(\)&lt;\/script&gt;/);
    assert.doesNotMatch(output, /<script|<img|data-approval-action|data-resend/);
    assert.equal(ui.node('approval-badge').hidden, true);
});

test('legacy overview separates expired and completed approvals without hiding actionable ones', () => {
    const ui = browser({ data: { approvals: [pending('active'), pending('old', { expires_at: past }), pending('sent', { status: 'sent' })] } });
    ui.run('renderApprovals()');
    assert.equal(ui.node('approval-badge').textContent, '1');
    assert.match(ui.node('approvals-list').innerHTML, /data-approval="active"/);
    assert.doesNotMatch(ui.node('approvals-list').innerHTML, /data-approval="old"|data-approval="sent"/);
    assert.match(ui.node('approval-history-list').innerHTML, /Срок истёк/);
    assert.match(ui.node('approval-history-list').innerHTML, /Передано WhatsApp/);
});

test('refresh preserves a focused edited draft and selection while removing another expired item', () => {
    const data = { approvals: [pending('a'), pending('b')] };
    const ui = browser({ data });
    ui.run('renderApprovals()');
    const input = ui.node('approval-a');
    input.value = 'Мой отредактированный ответ'; input.selectionStart = 4; input.selectionEnd = 12; input.scrollTop = 8; input.focus();
    data.approvals[1].expires_at = past;
    ui.run('renderApprovals()');
    const restored = ui.node('approval-a');
    assert.notEqual(restored, input, 'the test exercises actual replacement during rendering');
    assert.equal(restored.value, 'Мой отредактированный ответ');
    assert.equal(ui.document.activeElement, restored);
    assert.equal(restored.selectionStart, 4); assert.equal(restored.selectionEnd, 12); assert.equal(restored.scrollTop, 8);
    assert.equal(ui.node('approval-badge').textContent, '1');
    assert.doesNotMatch(ui.node('approvals-list').innerHTML, /data-approval="b"/);
});

test('expiration removes a focused item with an explanation and a stale approval click cannot submit', async () => {
    const data = { approvals: [pending('a')] };
    const ui = browser({ data });
    ui.run('renderApprovals()');
    const input = ui.node('approval-a'); input.value = 'Сохранённый локальный черновик'; input.focus();
    const button = approvalButton(ui, 'a');
    data.approvals[0].expires_at = past;
    ui.run('renderApprovals()');
    assert.equal(ui.document.activeElement.id, 'approval-title');
    assert.match(ui.node('workspace-toast').textContent, /срок истёк/);
    assert.equal(ui.run("state.approvalDrafts.get('a')"), 'Сохранённый локальный черновик');
    ui.context.button = button;
    await ui.run("handleApproval('approve', 'a', button)");
    assert.equal(ui.calls.length, 0);
    assert.match(ui.node('workspace-toast').textContent, /Черновик не отправлен/);
});

test('a pending approval action cannot duplicate and remains in history even if an old poll returns pending', async () => {
    const data = { approvals: [pending('a')], approvalHistory: [] };
    let release;
    const ui = browser({ data, respond: async ({ body }) => body ? await new Promise(resolve => { release = () => resolve({ data: { approval: { ...data.approvals[0], status: 'approved' } } }); }) : { data } });
    ui.run('renderApprovals()');
    ui.node('approval-a').value = 'Именно этот ответ';
    ui.context.button = approvalButton(ui, 'a');
    const first = ui.run("handleApproval('approve', 'a', button)");
    ui.run('renderApprovals()');
    assert.match(ui.node('approvals-list').innerHTML, /data-approval-action="approve"[^>]* disabled/);
    await ui.run("handleApproval('approve', 'a', button)");
    assert.equal(ui.calls.filter(call => call.body).length, 1);
    release(); await first;
    assert.doesNotMatch(ui.node('approvals-list').innerHTML, /data-approval="a"/);
    assert.match(ui.node('approval-history-list').innerHTML, /Ждёт отправки/);
    assert.match(ui.node('approval-history-list').innerHTML, /Именно этот ответ/);
});

test('pending pagination fetches and retains the selected page instead of accumulating stale pages', async () => {
    const page = offset => ({ approvals: [pending(offset ? 'next' : 'first')], approvalHistory: [], approvalPage: { offset, limit: 250, hasMore: offset === 0 } });
    const ui = browser({ data: page(0), respond: ({ url }) => ({ data: page(Number(new URL(url, 'https://fixture.example').searchParams.get('approvalOffset') || 0)) }) });
    ui.run('renderApprovals()');
    assert.equal(ui.node('approval-badge').textContent, '1+');
    await ui.run('changeApprovalPage(1)');
    assert.equal(ui.calls.at(-1).url, '/api/hub/workspace?approvalOffset=250');
    assert.match(ui.node('approvals-list').innerHTML, /data-approval="next"/);
    assert.doesNotMatch(ui.node('approvals-list').innerHTML, /data-approval="first"/);
    assert.equal(ui.node('approval-previous').disabled, false);
    await ui.run('refresh({quiet:true})');
    assert.equal(ui.calls.at(-1).url, '/api/hub/workspace?approvalOffset=250');
    await ui.run('changeApprovalPage(-1)');
    assert.equal(ui.calls.at(-1).url, '/api/hub/workspace');
    assert.match(ui.node('approvals-list').innerHTML, /data-approval="first"/);
});

test('history show-more preserves expanded details and stays separate from the approval count', () => {
    const ui = browser({ data: { approvals: [pending('a')], approvalHistory: Array.from({ length: 30 }, (_, i) => pending(`done-${i}`, { status: 'sent' })) } });
    ui.run('bindEvents(); renderApprovals()');
    assert.equal((ui.node('approval-history-list').innerHTML.match(/class="ws-decision"/g) || []).length, 20);
    assert.equal(ui.node('approval-history-more').hidden, false);
    ui.expanded.push({ dataset: { historyDetails: 'done-2' } });
    ui.node('approval-history-more').events.click();
    assert.equal((ui.node('approval-history-list').innerHTML.match(/class="ws-decision"/g) || []).length, 30);
    assert.match(ui.node('approval-history-list').innerHTML, /data-history-details="done-2" open/);
    assert.equal(ui.node('approval-history-more').hidden, true);
    assert.equal(ui.node('approval-badge').textContent, '1');
});

test('an old approval with new activity leads history and its remote sent result replaces the local waiting overlay', async () => {
    const recent = Array.from({ length: 60 }, (_, i) => pending(`recent-${i}`, { status: 'sent', created_at: '2026-10-30T09:00:00Z' }));
    const old = pending('old-important', { created_at: '2026-01-01T09:00:00Z', status: 'approved', decided_at: '2026-10-31T09:01:00Z' });
    const data = { approvals: [], approvalHistory: recent };
    const ui = browser({ data, respond: () => ({ data }) });
    ui.context.localDecision = old;
    ui.run("state.approvalDecisions.set('old-important', localDecision); renderApprovals()");
    assert.equal(ui.run('approvalHistory()[0].id'), 'old-important');
    assert.match(ui.node('approval-history-list').innerHTML, /Ждёт отправки/);
    assert.ok(ui.node('approval-history-list').innerHTML.indexOf('old-important') < ui.node('approval-history-list').innerHTML.indexOf('recent-0'));
    data.approvalHistory = [{ ...old, status: 'sent', delivered_at: '2026-10-31T09:02:00Z', activity_at: '2026-10-31T09:02:00Z' }, ...recent.slice(0, 59)];
    await ui.run('refresh()');
    assert.equal(ui.run("state.approvalDecisions.has('old-important')"), false);
    assert.equal(ui.run('approvalHistory()[0].id'), 'old-important');
    assert.equal(ui.run('approvalHistory()[0].status'), 'sent');
    assert.doesNotMatch(ui.node('approval-history-list').innerHTML, /Ждёт отправки/);
    assert.match(ui.node('approval-history-list').innerHTML, /datetime="2026-10-31T09:02:00Z"/);
});

test('history activity uses valid decision and delivery dates when activity_at is absent or stale', () => {
    const ui = browser({ data: { approvalHistory: [
        pending('created-later', { status: 'sent', created_at: '2026-10-30T09:00:00Z' }),
        pending('fallback', { status: 'sent', created_at: '2026-01-01T09:00:00Z', activity_at: 'invalid', delivered_at: '2026-10-31T09:02:00Z' }),
        pending('stale-activity', { status: 'approved', created_at: '2026-01-01T09:00:00Z', activity_at: '2026-01-01T09:00:00Z', decided_at: '2026-10-31T09:01:00Z' })
    ] } });
    assert.equal(ui.run('approvalHistory().map(item => item.id).join(",")'), 'fallback,stale-activity,created-later');
});

test('approved replies expire while Mac is offline without rewriting actual or uncertain sending outcomes', () => {
    const ui = browser({ data: { approvals: [], approvalHistory: ['approved', 'dispatching', 'sent', 'uncertain'].map(status => pending(status, { status, expires_at: past })) } });
    ui.context.localDecision = pending('local-approved', { status: 'approved', expires_at: past });
    ui.run("state.approvalDecisions.set('local-approved', localDecision); renderApprovals()");
    assert.equal(ui.run("approvalHistory().find(item => item.id === 'approved').status"), 'expired');
    assert.equal(ui.run("approvalHistory().find(item => item.id === 'local-approved').status"), 'expired');
    for (const status of ['dispatching', 'sent', 'uncertain']) assert.equal(ui.run(`approvalHistory().find(item => item.id === '${status}').status`), status);
    assert.doesNotMatch(ui.node('approval-history-list').innerHTML, /Ждёт отправки/);
    assert.match(ui.node('approval-history-list').innerHTML, /Срок истёк/);
    assert.match(ui.node('approval-history-list').innerHTML, /Передано WhatsApp/);
    assert.match(ui.node('approval-history-list').innerHTML, /Исход неизвестен/);
});
