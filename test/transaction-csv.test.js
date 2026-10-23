import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTransactionCsv } from '../js/transaction-csv.js';

test('CSV parser supports Russian semicolon exports and decimal commas', () => {
    const result = parseTransactionCsv([
        'Дата;Описание;Сумма;Тип;Категория;Комментарий',
        '23.10.2026;"Кофе, встреча";"1 250,50";Расход;Еда;Клиент',
        '2026-10-22;Оплата проекта;100000;Доход;Работа;'
    ].join('\n'));
    assert.equal(result.separator, ';');
    assert.equal(result.errors.length, 0);
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].amount, 1250.5);
    assert.equal(result.rows[0].transactionType, 'expense');
    assert.equal(result.rows[1].transactionType, 'income');
});

test('CSV parser supports Kazakh headers, escaped quotes and negative expense inference', () => {
    const result = parseTransactionCsv([
        'Күні,Сипаттама,Сомасы,Санат,Түсініктеме',
        '2026-10-23,"Такси ""әуежай""",-3500,Жол,Кешкі сапар'
    ].join('\n'));
    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.rows[0], {
        title: 'Такси "әуежай"',
        amount: 3500,
        transactionType: 'expense',
        occurredAt: result.rows[0].occurredAt,
        category: 'Жол',
        body: 'Кешкі сапар'
    });
});

test('CSV parser reports line-specific validation errors without accepting ambiguous positives', () => {
    const result = parseTransactionCsv([
        'date,title,amount,type',
        'bad,Missing date,500,expense',
        '2026-10-23,Ambiguous positive,700,'
    ].join('\n'));
    assert.equal(result.rows.length, 0);
    assert.deepEqual(result.errors.map(error => error.line), [2, 3]);
    assert.match(result.errors[0].message, /дата/);
    assert.match(result.errors[1].message, /тип/);
});

test('CSV parser handles quoted newlines and rejects unclosed quotes', () => {
    const parsed = parseTransactionCsv('date,title,amount,type,comment\n2026-10-23,Taxi,500,expense,"line one\nline two"');
    assert.equal(parsed.rows[0].body, 'line one\nline two');
    assert.throws(() => parseTransactionCsv('date,title,amount,type\n2026-10-23,"Taxi,500,expense'), /не закрыта кавычка/);
});
