import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://telegram-voice-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'telegram-voice-service-key';
process.env.AUTH_SECRET = 'telegram-voice-auth-secret-for-tests';
process.env.CREDENTIALS_ENCRYPTION_KEY = 'telegram-voice-credential-secret-for-tests';

const { encryptCredential } = await import('../server/api/_credentials.js');
const { generateEnvelopeKeyPair, decryptEnvelope } = await import('../lib/private-envelope.mjs');
const { enqueueTelegramThought, workspaceDeviceMutation } = await import('../server/api/_agent/workspace.js');
const { replyToPersonalAgent } = await import('../server/api/telegram.js');

const ROOT = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const OWNER = '77777777777';
const TOKEN = '123456:synthetic-telegram-voice-token-for-tests';
const root = { id: ROOT, telegram_connected: true, telegram_owner_chat_id: OWNER, telegram_owner_user_id: OWNER, telegram_bot_id: '123456' };
const voice = { file_id: 'AwAC_voice-file-123', file_unique_id: 'AgAD_unique-123', duration: 15, file_size: 12345, mime_type: 'audio/ogg' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

function mockStorage(keys, status = { telegramDialogue: true, telegramVoice: true }) {
    const writes = [], sent = [], requests = [];
    return { writes, sent, requests, fetch: async (input, options = {}) => {
        const url = String(input); requests.push(url);
        if (url.includes('/workspace_devices?')) return json([{ id: DEVICE, root_id: ROOT, public_key: keys.publicKey, status }]);
        if (url.includes('/workspace_jobs?') && options.method === 'POST') {
            const body = JSON.parse(options.body); writes.push({ ...body, prefer: options.headers?.Prefer });
            return json([{ id: JOB, ...body, status: 'queued' }]);
        }
        if (url.includes('/personal_agent_secrets?')) return json([{ secret_box: encryptCredential(ROOT, 'telegram', TOKEN) }]);
        if (url.endsWith('/sendMessage')) { sent.push(JSON.parse(options.body)); return json({ ok: true, result: {} }); }
        throw new Error('Server must not fetch audio, resolve Telegram files or transcribe');
    } };
}

test('voice metadata is encrypted for the Mac without storing IDs or fetching media on the server', async () => {
    const previous = globalThis.fetch;
    const keys = await generateEnvelopeKeyPair();
    const storage = mockStorage(keys); globalThis.fetch = storage.fetch;
    try {
        const result = await enqueueTelegramThought(root, '', { voice, telegramMessageId: 42 });
        const stored = storage.writes[0];
        assert.equal(stored.kind, 'telegram_thought');
        assert.equal(stored.root_id, ROOT); assert.equal(stored.device_id, DEVICE);
        assert.ok(!JSON.stringify(stored).includes(voice.file_id));
        assert.ok(!JSON.stringify(stored).includes(voice.file_unique_id));
        assert.equal('voice' in stored, false);
        const payload = await decryptEnvelope(keys.privateKey, stored.envelope);
        assert.equal(payload.intent, 'dialogue'); assert.equal(payload.text, '');
        assert.equal(payload.telegramMessageId, 42); assert.equal(payload.source, 'telegram');
        assert.match(payload.conversationKey, /^[a-f0-9]{64}$/);
        assert.deepEqual(payload.voice, { fileId: voice.file_id, uniqueId: voice.file_unique_id, duration: 15, size: 12345, mimeType: 'audio/ogg' });
        assert.equal(result.voice, true); assert.equal(result.queued, true);
        assert.ok(storage.requests.every(url => url.includes('.supabase.co/')));
        assert.match(stored.prefer, /ignore-duplicates/);
        await enqueueTelegramThought(root, '', { voice, telegramMessageId: 42 });
        assert.equal(storage.writes[0].request_id, storage.writes[1].request_id);
        await enqueueTelegramThought(root, '', { voice, telegramMessageId: 43 });
        assert.notEqual(storage.writes[0].request_id, storage.writes[2].request_id);
    } finally { globalThis.fetch = previous; }
});

test('optional voice size and MIME remain null; declared upper boundaries are accepted', async () => {
    const previous = globalThis.fetch;
    const keys = await generateEnvelopeKeyPair(); const storage = mockStorage(keys); globalThis.fetch = storage.fetch;
    try {
        await enqueueTelegramThought(root, '', { voice: { file_id: 'voice', file_unique_id: 'unique', duration: 1 }, telegramMessageId: 1 });
        const unknown = await decryptEnvelope(keys.privateKey, storage.writes[0].envelope);
        assert.equal(unknown.voice.size, null); assert.equal(unknown.voice.mimeType, null);
        await enqueueTelegramThought(root, '', { voice: { ...voice, duration: 600, file_size: 19 * 1024 * 1024, mime_type: 'Audio/OGG' }, telegramMessageId: 2 });
        const boundary = await decryptEnvelope(keys.privateKey, storage.writes[1].envelope);
        assert.equal(boundary.voice.duration, 600); assert.equal(boundary.voice.size, 19 * 1024 * 1024); assert.equal(boundary.voice.mimeType, 'audio/ogg');
    } finally { globalThis.fetch = previous; }
});

test('invalid or oversized voice metadata never enters the job queue', async () => {
    const previous = globalThis.fetch;
    const keys = await generateEnvelopeKeyPair(); const storage = mockStorage(keys); globalThis.fetch = storage.fetch;
    try {
        const invalid = [null, [], {}, { ...voice, file_id: 123 }, { ...voice, file_unique_id: true },
            { ...voice, file_id: 'https://example.test/audio.ogg' }, { ...voice, file_id: '../escape' },
            { ...voice, file_id: 'A'.repeat(513) }, { ...voice, file_unique_id: 'A'.repeat(129) },
            { ...voice, duration: 0 }, { ...voice, duration: 1.5 }, { ...voice, duration: 601 }, { ...voice, duration: '15' },
            { ...voice, file_size: -1 }, { ...voice, file_size: 0 }, { ...voice, file_size: 19 * 1024 * 1024 + 1 },
            { ...voice, mime_type: 'video/mp4' }];
        for (const item of invalid) await assert.rejects(enqueueTelegramThought(root, '', { voice: item, telegramMessageId: 1 }), error => error.status === 400);
        await assert.rejects(enqueueTelegramThought(root, '', { telegramMessageId: 1 }), error => error.status === 400);
        assert.equal(storage.writes.length, 0);
        assert.equal(storage.requests.some(url => url.includes('api.telegram.org')), false);
    } finally { globalThis.fetch = previous; }
});

test('both dialogue and voice capabilities must be boolean true before a voice is queued', async () => {
    const previous = globalThis.fetch;
    const keys = await generateEnvelopeKeyPair();
    try {
        for (const status of [{}, { telegramDialogue: true }, { telegramDialogue: true, telegramVoice: 'true' },
            { telegramDialogue: false, telegramVoice: true }, { telegramDialogue: 'true', telegramVoice: true }]) {
            const storage = mockStorage(keys, status); globalThis.fetch = storage.fetch;
            await assert.rejects(enqueueTelegramThought(root, '', { voice, telegramMessageId: 1 }), error => error.status === 409 && /локальное распознавание/.test(error.message));
            assert.equal(storage.writes.length, 0);
        }
    } finally { globalThis.fetch = previous; }
});

test('a private owner voice receives only a neutral Mac recognition acknowledgement', async () => {
    const previous = globalThis.fetch;
    const keys = await generateEnvelopeKeyPair(); const storage = mockStorage(keys); globalThis.fetch = storage.fetch;
    try {
        await replyToPersonalAgent(root, { chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, voice, message_id: 1 });
        assert.equal(storage.writes.length, 1); assert.equal(storage.sent.length, 1);
        assert.match(storage.sent[0].text, /Голосовое.*зашифрованную очередь.*Mac/);
        assert.match(storage.sent[0].text, /распознает его локально.*текстом/);
        assert.ok(!JSON.stringify(storage.sent).includes(voice.file_id));
        assert.ok(!JSON.stringify(storage.sent).includes(voice.file_unique_id));
        assert.equal(storage.requests.some(url => /getFile|\/file\/bot|transcriptions/.test(url)), false);
    } finally { globalThis.fetch = previous; }
});

test('wrong owners, unlinked chats and groups cannot enqueue voice or access the vault', async () => {
    const previous = globalThis.fetch;
    const sent = [];
    globalThis.fetch = async (input, options = {}) => {
        const url = String(input);
        if (url.includes('/personal_agent_secrets?')) return json([{ secret_box: encryptCredential(ROOT, 'telegram', TOKEN) }]);
        if (url.endsWith('/sendMessage')) { sent.push(JSON.parse(options.body)); return json({ ok: true }); }
        throw new Error('Rejected sender must never access queue or device');
    };
    try {
        await replyToPersonalAgent(root, { chat: { id: '88888888888', type: 'private' }, from: { id: '88888888888' }, voice, message_id: 1 });
        await replyToPersonalAgent(root, { chat: { id: '-123456', type: 'group' }, from: { id: OWNER }, voice, message_id: 2 });
        await replyToPersonalAgent({ ...root, telegram_owner_user_id: null }, { chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, voice, message_id: 3 });
        assert.match(sent[0].text, /другому личному кабинету/); assert.match(sent[1].text, /приватном чате/); assert.match(sent[2].text, /Сначала привяжите/);
        assert.ok(!JSON.stringify(sent).includes(voice.file_id));
    } finally { globalThis.fetch = previous; }
});

test('audio uploads, photos and other attachments are rejected helpfully without voice jobs', async () => {
    const previous = globalThis.fetch;
    const keys = await generateEnvelopeKeyPair(); const storage = mockStorage(keys); globalThis.fetch = storage.fetch;
    try {
        for (const media of [{ audio: voice }, { photo: [{ file_id: 'image' }], caption: 'caption is not a voice' }, { video_note: { file_id: 'video' } }, { document: { file_id: 'document' } }]) {
            await replyToPersonalAgent(root, { chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, message_id: 1, ...media });
        }
        assert.equal(storage.writes.length, 0); assert.equal(storage.sent.length, 4);
        assert.ok(storage.sent.every(item => /текст и голосовые сообщения/.test(item.text)));
    } finally { globalThis.fetch = previous; }
});

test('runtime advertises voice support only with explicit dialogue and voice booleans', async () => {
    const previous = globalThis.fetch; const statuses = [];
    globalThis.fetch = async (_input, options) => { statuses.push(JSON.parse(options.body).status); return json(null); };
    try {
        for (const status of [{ telegramDialogue: true }, { telegramDialogue: true, telegramVoice: 'true' },
            { telegramDialogue: false, telegramVoice: true }, { telegramDialogue: true, telegramVoice: true }]) {
            await workspaceDeviceMutation({ device: { id: DEVICE, root_id: ROOT }, root }, { action: 'runtime', status });
        }
        assert.deepEqual(statuses.map(status => status.telegramVoice), [false, false, false, true]);
    } finally { globalThis.fetch = previous; }
});
