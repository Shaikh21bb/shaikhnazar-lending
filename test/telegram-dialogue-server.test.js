import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.SUPABASE_URL = 'https://telegram-dialogue-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'telegram-dialogue-service-key';
process.env.AUTH_SECRET = 'telegram-dialogue-auth-secret-for-tests';
process.env.CREDENTIALS_ENCRYPTION_KEY = 'telegram-dialogue-credential-secret-for-tests';

const { encryptCredential } = await import('../server/api/_credentials.js');
const { generateEnvelopeKeyPair, decryptEnvelope } = await import('../lib/private-envelope.mjs');
const { enqueueTelegramThought, workspaceDeviceMutation } = await import('../server/api/_agent/workspace.js');
const { replyToPersonalAgent } = await import('../server/api/telegram.js');
const { default: deviceHandler } = await import('../server/api/hub/device.js');

const ROOT = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const OTHER = '66666666-6666-4666-8666-666666666666';
const TOKEN = '123456:synthetic-telegram-token-for-tests';
const OWNER = '77777777777';
const root = { id: ROOT, telegram_connected: true, telegram_owner_chat_id: OWNER, telegram_owner_user_id: OWNER };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const expectedConversationKey = createHash('sha256').update(`${ROOT}:${DEVICE}:${OWNER}`).digest('hex');

function response() {
    return {
        statusCode: 200, headers: {},
        setHeader(name, value) { this.headers[name] = value; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

test('Telegram dialogue, explicit note and clarification commands persist only encrypted Mac payloads', async () => {
    const previous = globalThis.fetch;
    const keys = await generateEnvelopeKeyPair();
    const writes = [];
    const scopedLookups = [];
    globalThis.fetch = async (input, options = {}) => {
        const url = String(input);
        if (url.includes('/workspace_devices?')) return json([{ id: DEVICE, root_id: ROOT, public_key: keys.publicKey, status: { telegramDialogue: true } }]);
        if (url.includes('/workspace_jobs?') && options.method === 'POST') {
            const body = JSON.parse(options.body);
            writes.push(body);
            return json([{ id: JOB, ...body, status: 'queued' }]);
        }
        if (url.includes('/workspace_jobs?')) { scopedLookups.push(url); return json([{ id: JOB }]); }
        throw new Error('Unexpected synthetic storage request');
    };
    try {
        const cases = [
            { text: 'Что я записал про проект?', intent: 'dialogue', content: 'Что я записал про проект?' },
            { text: '/ask@SHAIKH_memory_bot Найди связь с моей идеей', intent: 'dialogue', mode: 'ask', content: 'Найди связь с моей идеей' },
            { text: '/note Новая отдельная мысль', intent: 'thought', content: 'Новая отдельная мысль' },
            { text: `/when ${JOB} завтра в 15:00`, intent: 'clarify', content: 'завтра в 15:00' },
            { text: '/new', intent: 'dialogue', mode: 'reset', content: '' }
        ];
        for (const [index, item] of cases.entries()) {
            const result = await enqueueTelegramThought(root, item.text, { telegramMessageId: index + 1 });
            const stored = writes.at(-1);
            assert.equal(stored.kind, 'telegram_thought');
            assert.equal(stored.root_id, ROOT);
            assert.equal(stored.device_id, DEVICE);
            assert.equal('text' in stored, false);
            assert.equal(JSON.stringify(stored).includes(item.text), false);
            const payload = await decryptEnvelope(keys.privateKey, stored.envelope);
            assert.equal(payload.intent, item.intent);
            assert.equal(payload.mode, item.mode);
            assert.equal(payload.text, item.content);
            assert.equal(payload.telegramMessageId, index + 1);
            assert.equal(payload.conversationKey, expectedConversationKey);
            assert.equal(payload.source, 'telegram');
            if (item.intent === 'clarify') assert.equal(payload.relatedJobId, JOB);
            assert.equal(result.queued, true);
        }
        assert.equal(new Set(writes.map(item => item.request_id)).size, cases.length);
        assert.ok(scopedLookups.every(url => url.includes(`root_id=eq.${ROOT}`) && url.includes(`device_id=eq.${DEVICE}`)));
        await assert.rejects(enqueueTelegramThought(root, '/note', { telegramMessageId: 9 }), /Добавьте мысль/);
        await assert.rejects(enqueueTelegramThought(root, '/ask', { telegramMessageId: 10 }), /Добавьте вопрос/);
        await assert.rejects(enqueueTelegramThought(root, '/new extra', { telegramMessageId: 11 }), /без дополнительного текста/);
        await assert.rejects(enqueueTelegramThought(root, 'Привет', { telegramMessageId: 1.5 }), /идентификатор/);
        assert.equal(writes.length, cases.length);
    } finally { globalThis.fetch = previous; }
});

test('Telegram help is neutral and a different sender cannot enqueue a dialogue', async () => {
    const previous = globalThis.fetch;
    const sent = [];
    let queueAccess = 0;
    globalThis.fetch = async (input, options = {}) => {
        const url = String(input);
        if (url.includes('/personal_agent_secrets?')) return json([{ secret_box: encryptCredential(ROOT, 'telegram', TOKEN) }]);
        if (url.endsWith('/sendMessage')) { sent.push(JSON.parse(options.body)); return json({ ok: true, result: {} }); }
        queueAccess++;
        throw new Error('Help and wrong owner must not access the queue');
    };
    try {
        await replyToPersonalAgent(root, { chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, text: '/help', message_id: 1 });
        assert.match(sent[0].text, /\/ask/);
        assert.match(sent[0].text, /\/note/);
        assert.match(sent[0].text, /\/new/);
        assert.match(sent[0].text, /остаются|хранятся/);
        await replyToPersonalAgent(root, { chat: { id: '88888888888', type: 'private' }, from: { id: '88888888888' }, text: 'Покажи заметки владельца', message_id: 2 });
        assert.match(sent[1].text, /другому личному кабинету/);
        assert.equal(queueAccess, 0);
        assert.equal(sent.some(item => item.text.includes('Покажи заметки владельца')), false);
    } finally { globalThis.fetch = previous; }
});

test('older Macs keep note capture and cannot start dialogue or obtain reply credentials without explicit capability', async () => {
    const previous = globalThis.fetch;
    const keys = await generateEnvelopeKeyPair();
    let capability;
    let written;
    let credentialReads = 0;
    globalThis.fetch = async (input, options = {}) => {
        const url = String(input);
        if (url.includes('/workspace_devices?')) return json([{ id: DEVICE, root_id: ROOT, public_key: keys.publicKey, status: { telegramDialogue: capability } }]);
        if (url.includes('/workspace_jobs?') && options.method === 'POST') {
            written = JSON.parse(options.body);
            return json([{ id: JOB, ...written, status: 'queued' }]);
        }
        if (url.includes('/workspace_jobs?')) return json([{ id: JOB }]);
        credentialReads++;
        throw new Error('Unapproved dialogue must not access bot credentials');
    };
    try {
        for (const value of [undefined, false, 'true']) {
            capability = value;
            for (const [text, intent] of [['Обычная мысль', 'thought'], ['/note Отдельная мысль', 'thought'], [`/when ${JOB} завтра в 15:00`, 'clarify']]) {
                await enqueueTelegramThought(root, text, { telegramMessageId: 1 });
                const payload = await decryptEnvelope(keys.privateKey, written.envelope);
                assert.equal(payload.intent, intent);
                assert.equal(payload.conversationKey, expectedConversationKey);
                assert.equal(payload.telegramMessageId, 1);
            }
            for (const text of ['/ask Что в моих заметках?', '/new']) {
                await assert.rejects(enqueueTelegramThought(root, text, { telegramMessageId: 2 }), error => error.status === 409 && /не включён/.test(error.message));
            }
            await assert.rejects(workspaceDeviceMutation({ device: { id: DEVICE, root_id: ROOT }, root }, { action: 'telegram_credentials' }), error => error.status === 409 && /не включён/.test(error.message));
        }
        assert.equal(credentialReads, 0);
    } finally { globalThis.fetch = previous; }
});

test('partial runtime records Telegram dialogue capability only for explicit booleans', async () => {
    const previous = globalThis.fetch;
    const statuses = [];
    globalThis.fetch = async (input, options = {}) => {
        assert.match(String(input), /rpc\/workspace_patch_runtime/);
        assert.equal(options.method, 'POST');
        statuses.push(JSON.parse(options.body).p_status);
        return json(true);
    };
    try {
        for (const value of [undefined, false, 'true', true]) {
            await workspaceDeviceMutation({ device: { id: DEVICE, root_id: ROOT }, root }, { action: 'runtime', status: { telegramDialogue: value } });
        }
        assert.deepEqual(statuses.map(status => status.telegramDialogue), [undefined, false, undefined, true]);
    } finally { globalThis.fetch = previous; }
});

test('Telegram retries deduplicate within the same binding without colliding across owners or bots', async () => {
    const previous = globalThis.fetch;
    const keys = await generateEnvelopeKeyPair();
    const requestIds = [];
    globalThis.fetch = async (input, options = {}) => {
        const url = String(input);
        if (url.includes('/workspace_devices?')) return json([{ id: DEVICE, root_id: ROOT, public_key: keys.publicKey, status: { telegramDialogue: true } }]);
        if (url.includes('/workspace_jobs?')) {
            const body = JSON.parse(options.body);
            requestIds.push(body.request_id);
            return json([{ id: JOB, ...body, status: 'queued' }]);
        }
        throw new Error('Unexpected synthetic storage request');
    };
    try {
        const firstBinding = { ...root, telegram_bot_id: '123456' };
        for (const binding of [firstBinding, firstBinding, { ...firstBinding, telegram_owner_user_id: '88888888888' }, { ...firstBinding, telegram_bot_id: '654321' }]) {
            await enqueueTelegramThought(binding, 'Техническая мысль', { telegramMessageId: 42 });
        }
        assert.equal(requestIds[0], requestIds[1]);
        assert.notEqual(requestIds[0], requestIds[2]);
        assert.notEqual(requestIds[0], requestIds[3]);
    } finally { globalThis.fetch = previous; }
});

test('queued dialogue acknowledgement promises a local reply without echoing the private question', async () => {
    const previous = globalThis.fetch;
    const keys = await generateEnvelopeKeyPair();
    const sent = [];
    const question = 'Какая связь между моими личными заметками?';
    globalThis.fetch = async (input, options = {}) => {
        const url = String(input);
        if (url.includes('/personal_agent_secrets?')) return json([{ secret_box: encryptCredential(ROOT, 'telegram', TOKEN) }]);
        if (url.includes('/workspace_devices?')) return json([{ id: DEVICE, root_id: ROOT, public_key: keys.publicKey, status: { telegramDialogue: true } }]);
        if (url.includes('/workspace_jobs?')) return json([{ id: JOB, kind: 'telegram_thought', status: 'queued' }]);
        if (url.endsWith('/sendMessage')) { sent.push(JSON.parse(options.body)); return json({ ok: true, result: {} }); }
        throw new Error('Unexpected synthetic storage request');
    };
    try {
        await replyToPersonalAgent(root, { chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, text: question, message_id: 3 });
        assert.equal(sent.length, 1);
        assert.match(sent[0].text, /Сообщение.*зашифрованную очередь.*Mac/);
        assert.match(sent[0].text, /ответит здесь/);
        assert.equal(sent[0].text.includes(question), false);
    } finally { globalThis.fetch = previous; }
});

test('device receives Telegram credentials encrypted only to its fresh owned public key', async () => {
    const previous = globalThis.fetch;
    const keys = await generateEnvelopeKeyPair();
    const stale = await generateEnvelopeKeyPair();
    const lookups = [];
    globalThis.fetch = async input => {
        const url = String(input); lookups.push(url);
        if (url.includes('/workspace_devices?')) return json([{ id: DEVICE, root_id: ROOT, public_key: keys.publicKey, status: { telegramDialogue: true } }]);
        if (url.includes('/personal_agents?')) return json([root]);
        if (url.includes('/workspace_agents?')) return json([{ id: JOB }]);
        if (url.includes('/workspace_jobs?')) return json([{ id: JOB }]);
        if (url.includes('/personal_agent_secrets?')) return json([{ secret_box: encryptCredential(ROOT, 'telegram', TOKEN) }]);
        throw new Error('No outbound Telegram send or answer storage is allowed');
    };
    try {
        const result = await workspaceDeviceMutation({ device: { id: DEVICE, root_id: ROOT, public_key: stale.publicKey }, root: { id: ROOT } }, {
            action: 'telegram_credentials', jobId: JOB, chatId: 'attacker', ownerUserId: 'attacker', root_id: OTHER
        });
        assert.deepEqual(Object.keys(result), ['telegramEnvelope']);
        assert.equal(JSON.stringify(result).includes(TOKEN), false);
        const clear = await decryptEnvelope(keys.privateKey, result.telegramEnvelope);
        assert.deepEqual(clear, { token: TOKEN, chatId: OWNER, ownerUserId: OWNER, conversationKey: expectedConversationKey });
        await assert.rejects(decryptEnvelope(stale.privateKey, result.telegramEnvelope));
        assert.ok(lookups.some(url => url.includes('/workspace_devices?') && url.includes(`root_id=eq.${ROOT}`) && url.includes('revoked_at=is.null')));
        assert.ok(lookups.some(url => url.includes('/workspace_jobs?') && url.includes(`id=eq.${JOB}`) && url.includes(`device_id=eq.${DEVICE}`) && url.includes(`root_id=eq.${ROOT}`)));
        assert.ok(lookups.some(url => url.includes('/workspace_agents?') && url.includes('enabled=eq.true')));
    } finally { globalThis.fetch = previous; }
});

test('revoked, foreign, unlinked or disabled devices cannot obtain Telegram credentials', async () => {
    const previous = globalThis.fetch;
    const keys = await generateEnvelopeKeyPair();
    const device = { id: DEVICE, root_id: ROOT, public_key: keys.publicKey, status: { telegramDialogue: true } };
    let scenario = 'revoked';
    let secretReads = 0;
    globalThis.fetch = async input => {
        const url = String(input);
        if (url.includes('/workspace_devices?')) return json(scenario === 'revoked' ? [] : [device]);
        if (url.includes('/personal_agents?')) return json(scenario === 'unlinked' ? [{ id: ROOT, telegram_connected: false }] : [root]);
        if (url.includes('/workspace_agents?')) return json(scenario === 'disabled' ? [] : [{ id: JOB }]);
        if (url.includes('/workspace_jobs?')) return json([]);
        if (url.includes('/personal_agent_secrets?')) secretReads++;
        throw new Error('Credentials must not be read for an invalid binding');
    };
    try {
        const revoked = response();
        await deviceHandler({ method: 'POST', headers: { authorization: `Bearer ${'A'.repeat(43)}` }, body: { action: 'telegram_credentials' } }, revoked);
        assert.equal(revoked.statusCode, 401);
        await assert.rejects(workspaceDeviceMutation({ device: { ...device, root_id: OTHER }, root }, { action: 'telegram_credentials' }), error => error.status === 401);
        for (const value of ['revoked', 'unlinked', 'disabled', 'foreign-job']) {
            scenario = value;
            await assert.rejects(workspaceDeviceMutation({ device, root }, { action: 'telegram_credentials', jobId: JOB }), error => [401, 404, 409].includes(error.status));
        }
        assert.equal(secretReads, 0);
        await assert.rejects(workspaceDeviceMutation({ device, root }, { action: 'telegram_reply', text: 'Private answer from Obsidian' }), /Неизвестное действие/);
    } finally { globalThis.fetch = previous; }
});
