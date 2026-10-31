import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import sessionHandler from '../server/api/auth/session.js';
import { createSession, sessionCookie } from '../server/api/_auth.js';

const html = await readFile(new URL('../login.html', import.meta.url), 'utf8');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function element(extra = {}) {
    return { value: '', disabled: false, type: 'text', style: {}, dataset: {}, listeners: {},
        classList: { toggle() {} }, setAttribute() {}, removeAttribute() {},
        addEventListener(name, callback) { this.listeners[name] = callback; }, ...extra };
}

function harness(fetchImpl, { blockedGetter = false } = {}) {
    const nodes = Object.fromEntries(['auth-form', 'email', 'password', 'toggle-password', 'submit-btn', 'auth-error'].map(id => [id, element()]));
    nodes.password.type = 'password';
    const languageButtons = ['ru', 'kk'].map(lang => element({ dataset: { lang } }));
    const navigation = [];
    const location = { search: '?next=workspace', href: '', replace: value => navigation.push(value) };
    let ready;
    const document = { documentElement: {}, getElementById: id => nodes[id], querySelector: () => null,
        querySelectorAll: selector => selector === '.lang-btn' ? languageButtons : [],
        addEventListener(name, callback) { if (name === 'DOMContentLoaded') ready = callback; } };
    const sandbox = { document, window: { location }, navigator: {}, URLSearchParams, AbortSignal, fetch: fetchImpl,
        alert() { throw new Error('Unexpected fallback alert'); } };
    const denied = () => { throw new Error('SecurityError: browser storage blocked'); };
    if (blockedGetter) Object.defineProperty(sandbox, 'localStorage', { get: denied });
    else sandbox.localStorage = { getItem: denied, setItem: denied, removeItem: denied };
    const context = vm.createContext(sandbox);
    for (const [, script] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
        if (script.trim()) vm.runInContext(script, context);
    }
    return { nodes, document, languageButtons, navigation, location, ready: () => ready() };
}

test('blocked browser storage cannot prevent language changes or a successful cookie-based login', async () => {
    for (const blockedGetter of [false, true]) {
        const calls = [];
        const page = harness(async (url, request = {}) => {
            calls.push({ url, request });
            return url.endsWith('/session') ? { status: 401, ok: false }
                : { status: 200, ok: true, json: async () => ({ id: 'fixture-user', login: 'fixture@example.test', role: 'client' }) };
        }, { blockedGetter });
        page.languageButtons[1].listeners.click();
        assert.equal(page.document.documentElement.lang, 'kk');
        await page.ready();
        assert.equal(typeof page.nodes['auth-form'].listeners.submit, 'function');
        page.nodes.email.value = ' fixture@example.test ';
        page.nodes.password.value = ' fixture password with spaces ';
        let prevented = false;
        await page.nodes['auth-form'].listeners.submit({ preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
        const login = calls.find(call => call.url.endsWith('/login'));
        assert.equal(login.request.method, 'POST');
        assert.deepEqual(JSON.parse(login.request.body), { login: 'fixture@example.test', password: ' fixture password with spaces ' });
        assert.equal(login.url.includes('fixture'), false);
        assert.equal(page.location.href, 'workspace.html');
        assert.equal(page.nodes['auth-error'].style.display, 'none');
    }
});

test('an existing HttpOnly session is recovered without any localStorage hint', async () => {
    const page = harness(async () => ({ status: 200, ok: true, json: async () => ({ user: { role: 'client' } }) }));
    await page.ready();
    assert.deepEqual(page.navigation, ['workspace.html']);
});

test('submit is bound before a slow session check and that old result cannot override a new login', async () => {
    const lookup = deferred();
    const page = harness((url) => url.endsWith('/session') ? lookup.promise
        : Promise.resolve({ status: 200, ok: true, json: async () => ({ id: 'fixture-user', role: 'client' }) }));
    const initialization = page.ready();
    assert.equal(typeof page.nodes['auth-form'].listeners.submit, 'function');
    page.nodes.email.value = 'fixture@example.test';
    page.nodes.password.value = 'fixture-only-password';
    await page.nodes['auth-form'].listeners.submit({ preventDefault() {} });
    lookup.resolve({ status: 200, ok: true, json: async () => ({ user: { role: 'manager' } }) });
    await initialization;
    assert.equal(page.location.href, 'workspace.html');
    assert.deepEqual(page.navigation, []);
});

test('a failed login stays in the form and native fallback never puts credentials in a GET URL', async () => {
    const page = harness(async () => ({ status: 401, ok: false, json: async () => ({ error: 'invalid credentials' }) }));
    await page.ready();
    page.nodes.email.value = 'fixture@example.test';
    page.nodes.password.value = 'fixture-only-password';
    await page.nodes['auth-form'].listeners.submit({ preventDefault() {} });
    assert.equal(page.nodes['auth-error'].style.display, 'block');
    assert.equal(page.nodes['submit-btn'].disabled, false);
    assert.equal(page.location.href, '');
    const form = html.match(/<form\b[^>]*id="auth-form"[^>]*>/)?.[0] || '';
    assert.match(form, /method="post"/i);
    assert.match(form, /action="\/api\/auth\/login"/);
});

test('malformed unrelated cookies do not break a valid signed session', () => {
    const secret = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = 'fixture-session-recovery-signing-key';
    try {
        const cookie = sessionCookie(createSession({ id: 'fixture-user', role: 'client' })).split(';')[0];
        const response = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
        sessionHandler({ method: 'GET', headers: { cookie: `unrelated=%; ${cookie}; another=%E0%A4%A` } }, response);
        assert.equal(response.code, 200);
        assert.equal(response.body.user.sub, 'fixture-user');
    } finally {
        if (secret === undefined) delete process.env.AUTH_SECRET;
        else process.env.AUTH_SECRET = secret;
    }
});

test('a malformed session cookie is unauthorized rather than an uncaught URI error', () => {
    const secret = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = 'fixture-session-recovery-signing-key';
    try {
        const response = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
        assert.doesNotThrow(() => sessionHandler({ method: 'GET', headers: { cookie: 'shaikh_session=%' } }, response));
        assert.equal(response.code, 401);
        assert.equal(response.body.error, 'Unauthorized');
    } finally {
        if (secret === undefined) delete process.env.AUTH_SECRET;
        else process.env.AUTH_SECRET = secret;
    }
});
