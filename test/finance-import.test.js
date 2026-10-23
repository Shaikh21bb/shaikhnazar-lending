import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';

const { importTransactions, MAX_IMPORT_ROWS } = await import('../server/api/_agent/finance-import.js');

test('CSV transaction import is tenant-scoped, normalized and idempotent', async () => {
    const previousFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
        requests.push({ url: String(url), options });
        const sent = JSON.parse(options.body);
        return new Response(JSON.stringify([{
            ...sent[0],
            id: '11111111-1111-4111-8111-111111111111',
            created_at: '2026-10-23T10:00:00.000Z'
        }]), { status: 201 });
    };
    try {
        const result = await importTransactions('agent-safe', [{
            date: '2026-10-22T12:00:00+05:00',
            amount: 4500,
            type: 'expense',
            title: 'Такси',
            category: 'Транспорт'
        }]);
        assert.equal(result.imported, 1);
        assert.equal(result.duplicates, 0);
        assert.equal(requests.length, 1);
        assert.match(requests[0].url, /on_conflict=agent_id,source_message_key/);
        const payload = JSON.parse(requests[0].options.body);
        assert.equal(payload[0].agent_id, 'agent-safe');
        assert.equal(payload[0].currency, 'KZT');
        assert.equal(payload[0].metadata.source, 'csv_import');
        assert.match(payload[0].source_message_key, /^csv:[A-Za-z0-9_-]{40}:1$/);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('CSV import keeps identical rows while assigning repeat-stable occurrence keys', async () => {
    const previousFetch = globalThis.fetch;
    let payload;
    globalThis.fetch = async (_url, options = {}) => {
        payload = JSON.parse(options.body);
        return new Response(JSON.stringify([]), { status: 201 });
    };
    try {
        const row = { date: '2026-10-22', amount: 1000, type: 'expense', title: 'Кофе' };
        const result = await importTransactions('agent-safe', [row, row]);
        assert.equal(result.imported, 0);
        assert.equal(result.duplicates, 2);
        assert.notEqual(payload[0].source_message_key, payload[1].source_message_key);
        assert.match(payload[0].source_message_key, /:1$/);
        assert.match(payload[1].source_message_key, /:2$/);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('CSV import does not collapse otherwise identical operations with different details', async () => {
    const previousFetch = globalThis.fetch;
    let payload;
    globalThis.fetch = async (_url, options = {}) => {
        payload = JSON.parse(options.body);
        return new Response(JSON.stringify(payload), { status: 201 });
    };
    try {
        const base = { date: '2026-10-22', amount: 1000, type: 'expense', title: 'Покупка', category: 'Дом' };
        const result = await importTransactions('agent-safe', [
            { ...base, body: 'Чек 101' },
            { ...base, body: 'Чек 102' }
        ]);
        assert.equal(result.imported, 2);
        assert.notEqual(payload[0].source_message_key, payload[1].source_message_key);
        assert.match(payload[0].source_message_key, /:1$/);
        assert.match(payload[1].source_message_key, /:1$/);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('CSV import rejects invalid or oversized batches before database access', async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new Error('unexpected'); };
    try {
        await assert.rejects(
            () => importTransactions('agent-safe', [{ date: 'bad', amount: -1, type: 'expense', title: '' }]),
            /сумму|датой/
        );
        await assert.rejects(
            () => importTransactions('agent-safe', Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => ({}))),
            /не больше/
        );
        assert.equal(calls, 0);
    } finally {
        globalThis.fetch = previousFetch;
    }
});
