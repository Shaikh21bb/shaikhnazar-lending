import test from 'node:test';
import assert from 'node:assert/strict';
import { INBOX_EVENT_SCHEMA, INBOX_INGEST_SCHEMA, INBOX_RESPONSE_SCHEMA, assertInboxSchema, normalizeInboxEvent, cleanInboxText } from '../lib/whatsapp-inbox-contract.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const at = '2026-10-31T07:00:00.000Z';
const event = () => ({ id: 'a'.repeat(64), recipient: '12345@s.whatsapp.net', direction: 'incoming', actor: 'contact', kind: 'text',
    text: 'Фиктивное новое сообщение', status: 'received', occurredAt: at, revision: 1, origin: 'live' });

test('capture and provider accept one shared event shape and normalize nullable metadata', () => {
    const value = normalizeInboxEvent(event(), { now: Date.parse(at) });
    assert.equal(value.contactName, null);
    assert.equal(value.approvalId, null);
    assert.equal(value.replyToId, null);
    assertInboxSchema(INBOX_EVENT_SCHEMA, value);
    assertInboxSchema(INBOX_INGEST_SCHEMA, { captureSince: at, events: [value] });
});

test('private raw payloads, groups, invalid identity and unbounded batches cannot cross the inbox boundary', () => {
    for (const input of [{ ...event(), mediaKey: 'must-not-leave-Mac' }, { ...event(), vaultPath: '/private/fixture' },
        { ...event(), recipient: '12345@g.us' }, { ...event(), recipient: 'status@broadcast' },
        { ...event(), agentId: 'not-a-uuid' }, { ...event(), text: 'x'.repeat(8001) }]) {
        assert.throws(() => normalizeInboxEvent(input, { now: Date.parse(at) }));
    }
    assert.throws(() => assertInboxSchema(INBOX_INGEST_SCHEMA, { captureSince: at, events: Array.from({ length: 26 }, event) }));
});

test('incoming events cannot claim a sent reply and synthetic checks cannot masquerade as live system messages', () => {
    assert.throws(() => normalizeInboxEvent({ ...event(), status: 'sent' }, { now: Date.parse(at) }));
    assert.throws(() => normalizeInboxEvent({ ...event(), direction: 'outgoing', actor: 'contact', status: 'sent' }, { now: Date.parse(at) }));
    assert.throws(() => normalizeInboxEvent({ ...event(), direction: 'system', actor: 'system' }, { now: Date.parse(at) }));
    assert.throws(() => normalizeInboxEvent({ ...event(), direction: 'system', actor: 'system', origin: 'self_check', status: 'sent' }, { now: Date.parse(at) }));
    const synthetic = normalizeInboxEvent({ ...event(), direction: 'system', actor: 'system', origin: 'self_check', status: 'awaiting_approval' }, { now: Date.parse(at) });
    assert.equal(synthetic.origin, 'self_check');
});

test('timestamp and revision validation refuse malformed or future evidence', () => {
    for (const input of [{ ...event(), occurredAt: '1' }, { ...event(), occurredAt: '2026-10-31' },
        { ...event(), occurredAt: '2026-11-10T00:00:00Z' }, { ...event(), revision: 0 }, { ...event(), revision: 1.5 }]) {
        assert.throws(() => normalizeInboxEvent(input, { now: Date.parse(at) }));
    }
});

test('text cleaning preserves normal line breaks and avoids invalid UTF-16 at the truncation boundary', () => {
    assert.equal(cleanInboxText('A\0B\u0001C\nD\tE'), 'ABC\nD\tE');
    assert.equal(cleanInboxText('abc😀', 4), 'abc');
    assert.equal(cleanInboxText('abc😀', 5), 'abc😀');
});

test('consumer fixtures and provider projections share a private-data-free response schema', () => {
    const thread = { id: threadId, name: 'Тестовый контакт', address: '+12345', updatedAt: at, preview: 'Фиктивное новое сообщение',
        lastDirection: 'incoming', lastStatus: 'received', origin: 'live', needsApproval: false };
    const message = { id: event().id, threadId, direction: 'incoming', actor: 'contact', kind: 'text', text: event().text,
        status: 'received', occurredAt: at, updatedAt: at, approvalId: null, replyToId: null, origin: 'live', reason: null };
    const response = { threads: [thread], threadPage: { nextCursor: null }, selectedThread: thread,
        messages: [message], messagePage: { olderCursor: null }, approvals: [],
        status: { connected: true, deviceOnline: true, captureSince: at } };
    assertInboxSchema(INBOX_RESPONSE_SCHEMA, response);
    assert.throws(() => assertInboxSchema(INBOX_RESPONSE_SCHEMA, { ...response, token: 'not-public' }));
    assert.throws(() => assertInboxSchema(INBOX_RESPONSE_SCHEMA, { ...response, messages: [{ ...message, rawMessage: {} }] }));
    assert.throws(() => assertInboxSchema(INBOX_RESPONSE_SCHEMA, { ...response, threadPage: { nextCursor: null, root_id: threadId } }));
});
