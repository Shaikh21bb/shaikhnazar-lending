// Canonical JSON Schema contracts for Mac capture, the authenticated API and
// browser fixtures. Provider credentials and raw WhatsApp payloads never belong
// in this boundary. All identifiers are opaque strings.
export const INBOX_BATCH_SIZE = 25;
export const INBOX_THREAD_PAGE_SIZE = 25;
export const INBOX_MESSAGE_PAGE_SIZE = 50;
export const INBOX_UUID_PATTERN = '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$';
export const INBOX_ID_PATTERN = '^[a-f0-9]{64}$';
export const INBOX_PERSONAL_JID_PATTERN = '^(?:[0-9]{5,20}@s\\.whatsapp\\.net|[0-9]{5,30}@lid)$';
export const INBOX_KINDS = Object.freeze(['text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'unsupported']);
export const INBOX_STATUSES = Object.freeze(['received', 'processing', 'awaiting_approval', 'answered', 'skipped', 'sending', 'sent', 'uncertain', 'failed']);

const nullableUuid = { type: ['string', 'null'], pattern: INBOX_UUID_PATTERN };
const nullableId = { type: ['string', 'null'], pattern: INBOX_ID_PATTERN };
const timestamp = { type: 'string', format: 'date-time', maxLength: 40 };
const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export const INBOX_EVENT_SCHEMA = Object.freeze({
    $id: 'shaikh.whatsapp-inbox.event.v1', type: 'object', additionalProperties: false,
    required: ['id', 'recipient', 'direction', 'actor', 'kind', 'text', 'status', 'occurredAt', 'revision', 'origin'],
    properties: {
        id: { type: 'string', pattern: INBOX_ID_PATTERN },
        recipient: { type: 'string', pattern: INBOX_PERSONAL_JID_PATTERN },
        contactName: { type: ['string', 'null'], maxLength: 128 },
        agentId: nullableUuid,
        direction: { type: 'string', enum: ['incoming', 'outgoing', 'system'] },
        actor: { type: 'string', enum: ['contact', 'agent', 'system'] },
        kind: { type: 'string', enum: INBOX_KINDS },
        text: { type: ['string', 'null'], maxLength: 8000 },
        status: { type: 'string', enum: INBOX_STATUSES },
        occurredAt: timestamp,
        revision: { type: 'integer', minimum: 1, maximum: 2147483647 },
        approvalId: nullableUuid,
        replyToId: nullableId,
        origin: { type: 'string', enum: ['live', 'self_check'] },
        reason: { type: ['string', 'null'], maxLength: 80 }
    }
});

export const INBOX_INGEST_SCHEMA = Object.freeze({
    $id: 'shaikh.whatsapp-inbox.ingest.v1', type: 'object', additionalProperties: false,
    required: ['captureSince', 'events'], properties: {
        captureSince: timestamp,
        events: { type: 'array', maxItems: INBOX_BATCH_SIZE, items: INBOX_EVENT_SCHEMA }
    }
});

export const INBOX_THREAD_SCHEMA = Object.freeze({
    $id: 'shaikh.whatsapp-inbox.thread.v1', type: 'object', additionalProperties: false,
    required: ['id', 'name', 'address', 'updatedAt', 'preview', 'lastDirection', 'lastStatus', 'origin', 'needsApproval'],
    properties: {
        id: { type: 'string', pattern: INBOX_UUID_PATTERN },
        name: { type: 'string', maxLength: 128 },
        address: { type: 'string', maxLength: 128 },
        updatedAt: timestamp,
        preview: { type: 'string', maxLength: 240 },
        lastDirection: INBOX_EVENT_SCHEMA.properties.direction,
        lastStatus: INBOX_EVENT_SCHEMA.properties.status,
        origin: INBOX_EVENT_SCHEMA.properties.origin,
        needsApproval: { type: 'boolean' }
    }
});

export const INBOX_MESSAGE_SCHEMA = Object.freeze({
    $id: 'shaikh.whatsapp-inbox.message.v1', type: 'object', additionalProperties: false,
    required: ['id', 'threadId', 'direction', 'actor', 'kind', 'text', 'status', 'occurredAt', 'updatedAt', 'approvalId', 'replyToId', 'origin', 'reason'],
    properties: {
        id: INBOX_EVENT_SCHEMA.properties.id,
        threadId: INBOX_THREAD_SCHEMA.properties.id,
        direction: INBOX_EVENT_SCHEMA.properties.direction,
        actor: INBOX_EVENT_SCHEMA.properties.actor,
        kind: INBOX_EVENT_SCHEMA.properties.kind,
        text: INBOX_EVENT_SCHEMA.properties.text,
        status: INBOX_EVENT_SCHEMA.properties.status,
        occurredAt: timestamp, updatedAt: timestamp,
        approvalId: nullableUuid, replyToId: nullableId,
        origin: INBOX_EVENT_SCHEMA.properties.origin, reason: INBOX_EVENT_SCHEMA.properties.reason
    }
});

export const INBOX_APPROVAL_SCHEMA = Object.freeze({
    $id: 'shaikh.whatsapp-inbox.approval.v1', type: 'object', additionalProperties: false,
    required: ['id', 'agent_id', 'original', 'draft', 'reason', 'status', 'expires_at', 'created_at'],
    properties: {
        id: nullableUuid, agent_id: nullableUuid,
        original: { type: 'string', maxLength: 8000 }, draft: { type: 'string', maxLength: 4000 },
        reason: { type: 'string', maxLength: 200 },
        status: { type: 'string', enum: ['pending', 'approved', 'dispatching', 'sent', 'failed', 'uncertain', 'rejected', 'expired'] },
        expires_at: timestamp, created_at: timestamp,
        decided_at: { type: ['string', 'null'], format: 'date-time' },
        delivered_at: { type: ['string', 'null'], format: 'date-time' },
        activity_at: { type: ['string', 'null'], format: 'date-time' }
    }
});

const nullableCursor = { type: ['string', 'null'], maxLength: 512 };
export const INBOX_RESPONSE_SCHEMA = Object.freeze({
    $id: 'shaikh.whatsapp-inbox.response.v1', type: 'object', additionalProperties: false,
    required: ['threads', 'threadPage', 'selectedThread', 'messages', 'messagePage', 'approvals', 'status'],
    properties: {
        threads: { type: 'array', maxItems: INBOX_THREAD_PAGE_SIZE, items: INBOX_THREAD_SCHEMA },
        threadPage: { type: 'object', additionalProperties: false, required: ['nextCursor'], properties: { nextCursor: nullableCursor } },
        selectedThread: { anyOf: [{ type: 'null' }, INBOX_THREAD_SCHEMA] },
        messages: { type: 'array', maxItems: INBOX_MESSAGE_PAGE_SIZE, items: INBOX_MESSAGE_SCHEMA },
        messagePage: { type: 'object', additionalProperties: false, required: ['olderCursor'], properties: { olderCursor: nullableCursor } },
        approvals: { type: 'array', maxItems: INBOX_MESSAGE_PAGE_SIZE, items: INBOX_APPROVAL_SCHEMA },
        status: { type: 'object', additionalProperties: false, required: ['deviceOnline', 'connected', 'captureSince'], properties: {
            deviceOnline: { type: 'boolean' }, connected: { type: 'boolean' },
            captureSince: { type: ['string', 'null'], format: 'date-time' }
        } }
    }
});

// This validator implements only the vocabulary used in the schemas above;
// every participant tests serialized fixtures through the same contract.
export function assertInboxSchema(schema, value, path = 'inbox') {
    if (schema.anyOf) {
        for (const variant of schema.anyOf) {
            try { assertInboxSchema(variant, value, path); return value; } catch { /* Try the next declared variant. */ }
        }
        throw new Error(`${path}: invalid value`);
    }
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!types.some(type => type === actual || type === 'integer' && Number.isSafeInteger(value))) throw new Error(`${path}: invalid type`);
    if (value === null) return value;
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: invalid enum`);
    if (actual === 'string') {
        if (value.includes('\0') || schema.maxLength !== undefined && value.length > schema.maxLength
            || schema.pattern && !new RegExp(schema.pattern).test(value)
            || schema.format === 'date-time' && (!isoTimestamp.test(value) || !Number.isFinite(Date.parse(value)))) throw new Error(`${path}: invalid string`);
    } else if (actual === 'number') {
        if (!Number.isFinite(value) || schema.minimum !== undefined && value < schema.minimum
            || schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path}: invalid number`);
    } else if (actual === 'array') {
        if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${path}: too many items`);
        for (const [index, item] of value.entries()) assertInboxSchema(schema.items, item, `${path}[${index}]`);
    } else if (actual === 'object') {
        for (const name of schema.required || []) if (!Object.hasOwn(value, name)) throw new Error(`${path}: missing ${name}`);
        for (const [name, item] of Object.entries(value)) {
            if (!Object.hasOwn(schema.properties || {}, name)) {
                if (schema.additionalProperties === false) throw new Error(`${path}: unexpected field`);
            } else assertInboxSchema(schema.properties[name], item, `${path}.${name}`);
        }
    }
    return value;
}

export function normalizeInboxEvent(input, { now = Date.now() } = {}) {
    assertInboxSchema(INBOX_EVENT_SCHEMA, input);
    const event = { ...input, contactName: input.contactName || null, agentId: input.agentId || null,
        approvalId: input.approvalId || null, replyToId: input.replyToId || null, reason: input.reason || null,
        occurredAt: new Date(input.occurredAt).toISOString() };
    if (Date.parse(event.occurredAt) > now + 5 * 60_000) throw new Error('inbox: future timestamp');
    if (event.kind === 'text' && !event.text?.trim()) throw new Error('inbox: empty text');
    if (event.direction === 'incoming' && (event.actor !== 'contact'
        || !['received', 'processing', 'awaiting_approval', 'answered', 'skipped'].includes(event.status))) throw new Error('inbox: invalid incoming state');
    if (event.direction === 'outgoing' && (event.actor === 'contact'
        || !['sending', 'sent', 'uncertain', 'failed'].includes(event.status))) throw new Error('inbox: invalid outgoing state');
    if (event.direction === 'system' && (event.actor !== 'system' || event.origin !== 'self_check'
        || !['received', 'awaiting_approval', 'answered', 'skipped', 'failed'].includes(event.status))) throw new Error('inbox: invalid system record');
    return event;
}

export function cleanInboxText(value, maximum = 8000) {
    const text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, maximum);
    return text.replace(/[\uD800-\uDBFF]$/, '');
}
