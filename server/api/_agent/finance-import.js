import { createHash } from 'node:crypto';
import { db } from '../_lib.js';
import { serializeRecord } from './personal.js';

const MAX_IMPORT_ROWS = 300;
const MAX_AMOUNT = 999_999_999_999;
const failure = (message, status = 400) => Object.assign(new Error(message), { status });

function clean(value, limit) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, limit);
}

function importedDate(value) {
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) throw failure('В импорте есть строка с неверной датой.');
    return date.toISOString();
}

function fingerprint(parts) {
    return createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0, 40);
}

function normalizeRows(agentId, rows) {
    if (!Array.isArray(rows) || rows.length === 0) throw failure('В файле нет операций для импорта.');
    if (rows.length > MAX_IMPORT_ROWS) {
        throw failure(`За один раз можно импортировать не больше ${MAX_IMPORT_ROWS} операций.`);
    }

    const occurrences = new Map();
    return rows.map((row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw failure(`Проверьте строку ${index + 1} импорта.`);
        }
        const amount = Number(row.amount);
        if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
            throw failure(`Проверьте сумму в строке ${index + 1}.`);
        }
        const transactionType = clean(row.transactionType ?? row.transaction_type ?? row.type, 20);
        if (!['expense', 'income'].includes(transactionType)) {
            throw failure(`Укажите тип операции в строке ${index + 1}.`);
        }
        const occurredAt = importedDate(row.occurredAt ?? row.occurred_at ?? row.date);
        const title = clean(row.title ?? row.description ?? row.merchant, 240);
        if (!title) throw failure(`Добавьте описание в строке ${index + 1}.`);
        const category = clean(row.category, 80) || 'Импорт';
        const body = clean(row.body ?? row.details ?? row.comment, 12000);
        const canonical = fingerprint([
            occurredAt,
            amount.toFixed(2),
            transactionType,
            title.toLocaleLowerCase('ru-RU'),
            category.toLocaleLowerCase('ru-RU'),
            body.toLocaleLowerCase('ru-RU')
        ]);
        const occurrence = (occurrences.get(canonical) || 0) + 1;
        occurrences.set(canonical, occurrence);

        return {
            agent_id: agentId,
            kind: 'transaction',
            title,
            body,
            amount,
            currency: 'KZT',
            category,
            transaction_type: transactionType,
            occurred_at: occurredAt,
            event_at: null,
            status: 'active',
            source_message_key: `csv:${canonical}:${occurrence}`,
            metadata: { source: 'csv_import' },
            updated_at: new Date().toISOString()
        };
    });
}

export async function importTransactions(agentId, rows) {
    const payload = normalizeRows(agentId, rows);
    const result = await db('personal_agent_records?on_conflict=agent_id,source_message_key', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify(payload),
        timeoutMs: 15_000
    });
    if (!result.res.ok) throw failure('Не удалось импортировать операции.', 503);
    const inserted = (result.body || []).map(serializeRecord);
    return {
        ok: true,
        imported: inserted.length,
        duplicates: payload.length - inserted.length,
        records: inserted
    };
}

export { MAX_IMPORT_ROWS };
