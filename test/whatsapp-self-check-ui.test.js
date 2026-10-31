import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { generateEnvelopeKeyPair, encryptEnvelope, decryptEnvelope } from '../lib/private-envelope.mjs';

const source = (await readFile(new URL('../js/workspace.js', import.meta.url), 'utf8')).replace(/^import .*;\n/, '').replace(/\ninit\(\);\s*$/, '');
const storageName = 'shaikh-whatsapp-self-check-v1';
const keys = await generateEnvelopeKeyPair();
const agentId = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';

function fixture({ stored = new Map(), respond, account = 'owner-one' } = {}) {
    const nodes = new Map(), calls = [];
    const data = { agents: [{ id: agentId, name: 'Мой WhatsApp', type: 'whatsapp', enabled: true, rules: '', examples: '' }],
        device: { last_seen_at: new Date().toISOString(), public_key: keys.publicKey, status: { state: 'ready', whatsapp: 'connected' } },
        jobs: [], approvals: [], approvalHistory: [], reminders: [] };
    const document = { activeElement: null, hidden: false, querySelectorAll: () => [], addEventListener() {} };
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { id, hidden: false, disabled: false, textContent: '', innerHTML: '', dataset: {},
            classList: { toggle() {} }, setAttribute() {}, addEventListener() {},
            querySelector: selector => node(`${id}/${selector}`), querySelectorAll: () => [],
            focus() { this.focused = true; }, scrollIntoView(options) { this.scrollOptions = options; }, closest() { return this.article; } });
        return nodes.get(id);
    };
    document.getElementById = node;
    const context = vm.createContext({ document, window: { addEventListener() {}, scrollTo() {} }, location: { origin: 'https://fixture.example', hash: '', assign() {} }, history: { replaceState() {} },
        generateEnvelopeKeyPair, encryptEnvelope, decryptEnvelope, crypto: webcrypto,
        sessionStorage: { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
        setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, matchMedia: () => ({ matches: true }),
        fetch: async (url, options = {}) => {
            const body = options.body ? JSON.parse(options.body) : null;
            calls.push({ url, body, options });
            const result = respond ? await respond({ url, body, data, calls }) : { data: body ? { job: { id: jobId } } : data };
            return { ok: (result.status || 200) < 400, status: result.status || 200, json: async () => result.data };
        }
    });
    vm.runInContext(source, context);
    context.fixtureData = data; context.fixtureAccount = account;
    vm.runInContext('state.data = fixtureData; state.user = {sub:fixtureAccount};', context);
    return { data, calls, stored, context, node, run: code => vm.runInContext(code, context) };
}

test('self-check is offered only for the sole active connected WhatsApp agent', async () => {
    const ui = fixture();
    ui.run('renderAgents()');
    assert.match(ui.node('agents-list').innerHTML, /Проверить отправку себе/);
    assert.match(ui.node('agents-list').innerHTML, /aria-describedby="self-check-intro"/);
    ui.data.device.status.whatsapp = 'paused';
    ui.run('renderAgents()');
    assert.doesNotMatch(ui.node('agents-list').innerHTML, /data-self-check-whatsapp/);
    await ui.run(`startSelfCheck('${agentId}')`);
    assert.equal(ui.calls.length, 0);
    ui.data.device.status.whatsapp = 'connected';
    ui.data.agents.push({ ...ui.data.agents[0], id: 'other-enabled' });
    ui.run('renderAgents()');
    assert.doesNotMatch(ui.node('agents-list').innerHTML, /data-self-check-whatsapp/);
});

test('self-check seals the fixed intent and agent into one authenticated encrypted job', async () => {
    const ui = fixture();
    await ui.run(`startSelfCheck('${agentId}')`);
    const writes = ui.calls.filter(call => call.body);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.action, 'enqueue');
    assert.equal(writes[0].body.kind, 'whatsapp_connect');
    assert.equal(writes[0].options.credentials, 'same-origin');
    assert.equal(writes[0].options.method, 'POST');
    assert.equal(JSON.stringify(writes[0].body).includes('whatsapp_self_check'), false);
    const payload = await decryptEnvelope(keys.privateKey, writes[0].body.envelope);
    assert.equal(payload.intent, 'whatsapp_self_check');
    assert.equal(payload.agentId, agentId);
    assert.equal(payload.replyPublicKey.kty, 'RSA');
    assert.equal(payload.recipient, undefined);
    assert.equal(payload.text, undefined);
    assert.equal(ui.run('state.pendingThought'), null);
    assert.equal(ui.node('self-check-title').focused, true);
    assert.equal(ui.node('self-check-panel').scrollOptions.behavior, 'instant');
    assert.equal(JSON.parse(ui.stored.get(storageName)).jobId, jobId);
    await ui.run(`startSelfCheck('${agentId}')`);
    assert.equal(ui.calls.filter(call => call.body).length, 1, 'an already created job cannot be started a second time');
});

test('an enqueue response lost after acceptance retries the same envelope and UUID after reload', async () => {
    const stored = new Map();
    let first;
    const before = fixture({ stored, respond: ({ body }) => {
        if (body) { first = body; throw new Error('connection lost after acceptance'); }
        return { data: {} };
    } });
    await before.run(`startSelfCheck('${agentId}')`);
    assert.ok(first);
    assert.equal(before.node('self-check-retry').hidden, false);
    assert.equal(JSON.parse(stored.get(storageName)).request.request_id, first.request_id);
    const after = fixture({ stored });
    after.run('restoreSelfCheck()');
    await after.run(`startSelfCheck('${agentId}')`);
    assert.deepEqual(after.calls.find(call => call.body).body, first);
    assert.equal(after.node('self-check-retry').hidden, true);
    assert.equal(JSON.parse(stored.get(storageName)).request, null);
});

test('account changes and tampered browser retry actions cannot replay another mutation', () => {
    for (const record of [
        { account: 'another-owner', agentId, jobId },
        { account: 'owner-one', agentId, request: { action: 'approve', id: 'some-approval', kind: 'whatsapp_connect', request_id: '0123456789abcdef', envelope: { v: 1, ciphertext: 'fixture' } } }
    ]) {
        const ui = fixture({ stored: new Map([[storageName, JSON.stringify(record)]]) });
        ui.run('restoreSelfCheck()');
        assert.equal(ui.run('state.selfCheck'), null);
        assert.equal(ui.calls.length, 0);
    }
});

test('concurrent clicks cannot enqueue duplicate self-checks while the first HTTP call is pending', async () => {
    let release;
    const ui = fixture({ respond: ({ body, data }) => body ? new Promise(resolve => { release = () => resolve({ data: { job: { id: jobId } } }); }) : { data } });
    const first = ui.run(`startSelfCheck('${agentId}')`);
    await ui.run(`startSelfCheck('${agentId}')`);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.calls.filter(call => call.body).length, 1);
    release();
    await first;
});

test('accepted outgoing self-check reports pending human approval and never claims independent inbound or phone delivery', () => {
    const ui = fixture();
    ui.data.jobs = [{ id: jobId, status: 'complete', kind: 'whatsapp_connect' }];
    ui.context.fixtureResult = { selfCheck: { agentId, ordinaryStatus: 'sent', ordinaryAnswer: '<img src=x onerror=alert(1)>', approvalId: 'fixture-approval', approvalSaved: true, inboundVerified: false, phoneDeliveryVerified: false } };
    ui.run(`state.decrypted.set('${jobId}', {result:fixtureResult}); renderSelfCheck(); renderAgents();`);
    assert.match(ui.node('self-check-status').textContent, /принят WhatsApp/);
    assert.match(ui.node('self-check-result').innerHTML, /Входящие от другого человека.*Ещё не проверено/s);
    assert.match(ui.node('self-check-result').innerHTML, /Доставка на телефон.*Ожидает вашей проверки/s);
    assert.match(ui.node('self-check-result').innerHTML, /&lt;img/);
    assert.doesNotMatch(ui.node('self-check-result').innerHTML, /<img|data-approval-action|data-resend/);
    assert.equal(ui.node('self-check-approval').hidden, false);
    assert.equal(ui.node('self-check-retry').hidden, true);
    assert.match(ui.node('agents-list').innerHTML, /data-self-check-whatsapp[^>]+disabled/);
    assert.equal(ui.calls.length, 0);
});

test('an uncertain or blocked outgoing outcome never offers a new send or a false success', () => {
    for (const ordinaryStatus of ['uncertain', 'blocked']) {
        const ui = fixture();
        ui.data.jobs = [{ id: jobId, status: 'complete', kind: 'whatsapp_connect' }];
        ui.context.fixtureResult = { selfCheck: { agentId, ordinaryStatus, approvalSaved: true, approvalId: 'fixture-approval' } };
        ui.run(`state.selfCheck={agentId:'${agentId}',jobId:'${jobId}',request:null}; state.decrypted.set('${jobId}', {result:fixtureResult}); renderSelfCheck(); renderAgents();`);
        assert.match(ui.node('self-check-status').textContent, /требует внимания/);
        assert.equal(ui.node('self-check-retry').hidden, true);
        assert.match(ui.node('agents-list').innerHTML, /data-self-check-whatsapp[^>]+disabled/);
        assert.doesNotMatch(ui.node('self-check-result').innerHTML, /data-resend/);
    }
});

test('a completed result encrypted for another session keeps the existing job and offers no rerun', () => {
    const ui = fixture();
    ui.data.jobs = [{ id: jobId, status: 'completed', kind: 'whatsapp_connect' }];
    ui.run(`state.selfCheck={agentId:'${agentId}',jobId:'${jobId}',request:null}; state.decrypted.set('${jobId}', {inaccessible:true}); renderSelfCheck();`);
    assert.match(ui.node('self-check-status').textContent, /результат недоступен/);
    assert.equal(ui.node('self-check-retry').hidden, true);
    assert.equal(ui.run('state.selfCheck.jobId'), jobId);
});

test('opening the real test approval focuses it without approving it or sending a message', () => {
    const ui = fixture();
    ui.data.approvals = [{ id: 'fixture-approval', status: 'pending', expires_at: '2036-10-31T15:00:00Z' }];
    ui.context.fixtureResult = { selfCheck: { approvalId: 'fixture-approval', approvalSaved: true } };
    ui.run(`state.selfCheck={jobId:'${jobId}'}; state.decrypted.set('${jobId}', {result:fixtureResult});`);
    const input = ui.node('approval-fixture-approval'), article = ui.node('fixture-article');
    input.article = article;
    ui.run('focusSelfCheckApproval()');
    assert.equal(input.focused, true);
    assert.equal(article.scrollOptions.behavior, 'instant');
    assert.equal(ui.calls.length, 0);
});

test('the linked important result follows pending, local approval and server terminal states instead of claiming a decision is still needed', () => {
    const ui = fixture();
    const review = { id: 'fixture-approval', status: 'pending', expires_at: '2036-10-31T15:00:00Z' };
    ui.data.approvals = [review];
    ui.data.jobs = [{ id: jobId, status: 'complete', kind: 'whatsapp_connect' }];
    ui.context.fixtureResult = { selfCheck: { agentId, ordinaryStatus: 'sent', approvalSaved: true, approvalId: review.id } };
    ui.run(`state.selfCheck={agentId:'${agentId}',jobId:'${jobId}',request:null}; state.decrypted.set('${jobId}', {result:fixtureResult}); renderSelfCheck();`);
    assert.match(ui.node('self-check-result').innerHTML, /На согласовании: требуется ваше решение/);
    assert.equal(ui.node('self-check-approval').textContent, 'Открыть тестовое согласование');

    ui.run(`state.approvalDecisions.set('fixture-approval', {id:'fixture-approval',status:'approved'}); renderSelfCheck();`);
    assert.match(ui.node('self-check-result').innerHTML, /Ответ согласован\. Ожидает отправки/);
    assert.doesNotMatch(ui.node('self-check-result').innerHTML, /требуется ваше решение/);
    assert.equal(ui.node('self-check-approval').textContent, 'Открыть результат согласования');

    for (const [status, expected] of [['dispatching', /Mac отправляет согласованный ответ/], ['sent', /Согласованный ответ принят WhatsApp/],
        ['rejected', /Вы отклонили тестовый ответ/], ['expired', /Срок тестового согласования истёк/], ['uncertain', /Исход отправки неизвестен/]]) {
        ui.data.approvals = [];
        ui.data.approvalHistory = [{ ...review, status }];
        ui.run('renderSelfCheck()');
        assert.match(ui.node('self-check-result').innerHTML, expected);
        assert.doesNotMatch(ui.node('self-check-result').innerHTML, /требуется ваше решение|Ожидает сохранения/);
        assert.equal(ui.node('self-check-approval').textContent, 'Открыть результат согласования');
    }
    ui.data.approvalHistory = [];
    ui.run('state.approvalDecisions.clear(); renderSelfCheck();');
    assert.match(ui.node('self-check-result').innerHTML, /согласование создано\. Текущий статус проверьте/);
    assert.doesNotMatch(ui.node('self-check-result').innerHTML, /требуется ваше решение/);
    assert.equal(ui.calls.length, 0);
});

test('self-check asset versions match and the page describes its limited verification scope', async () => {
    const html = await readFile(new URL('../workspace.html', import.meta.url), 'utf8');
    assert.match(html, /workspace\.css\?v=20261031b/);
    assert.match(html, /workspace\.js\?v=20261031b/);
    assert.match(html, /два теста в вашем собственном чате/i);
    assert.match(html, /Приём сообщений от других людей проверяется отдельно/);
});
