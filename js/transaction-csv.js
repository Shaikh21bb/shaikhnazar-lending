const MAX_ROWS = 300;
const MAX_FILE_BYTES = 1024 * 1024;

const HEADER_ALIASES = Object.freeze({
    date: ['date', 'datetime', 'occurredat', 'дата', 'уақыт', 'күні', 'күн'],
    title: ['title', 'description', 'merchant', 'name', 'назначение', 'описание', 'операция', 'атауы', 'сипаттама'],
    amount: ['amount', 'sum', 'сумма', 'сомасы', 'сома'],
    type: ['type', 'transactiontype', 'вид', 'тип', 'түрі'],
    category: ['category', 'категория', 'санат'],
    body: ['body', 'details', 'comment', 'note', 'комментарий', 'детали', 'примечание', 'түсініктеме']
});

const TYPE_ALIASES = Object.freeze({
    expense: new Set(['expense', 'out', 'debit', 'расход', 'расходы', 'списание', 'шығыс']),
    income: new Set(['income', 'in', 'credit', 'доход', 'доходы', 'поступление', 'кіріс'])
});

function normalizedKey(value) {
    return String(value ?? '')
        .replace(/^\uFEFF/, '')
        .trim()
        .toLocaleLowerCase('ru-RU')
        .replace(/[\s_\-.]+/g, '');
}

function cleanCell(value, limit = 12000) {
    return String(value ?? '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .trim()
        .slice(0, limit);
}

function separatorScore(text, separator) {
    let count = 0;
    let quoted = false;
    for (let index = 0; index < Math.min(text.length, 8000); index += 1) {
        const character = text[index];
        if (character === '"') {
            if (quoted && text[index + 1] === '"') index += 1;
            else quoted = !quoted;
        } else if (!quoted && character === separator) count += 1;
        else if (!quoted && (character === '\n' || character === '\r')) break;
    }
    return count;
}

function detectSeparator(text) {
    return [',', ';', '\t']
        .map(separator => ({ separator, count: separatorScore(text, separator) }))
        .sort((left, right) => right.count - left.count)[0]?.separator || ',';
}

function parseGrid(text, separator) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (character === '"') {
            if (quoted && text[index + 1] === '"') {
                cell += '"';
                index += 1;
            } else {
                quoted = !quoted;
            }
            continue;
        }
        if (!quoted && character === separator) {
            row.push(cell);
            cell = '';
            continue;
        }
        if (!quoted && (character === '\n' || character === '\r')) {
            if (character === '\r' && text[index + 1] === '\n') index += 1;
            row.push(cell);
            if (row.some(value => cleanCell(value))) rows.push(row);
            row = [];
            cell = '';
            continue;
        }
        cell += character;
    }
    if (quoted) throw new Error('В CSV не закрыта кавычка. Проверьте файл.');
    row.push(cell);
    if (row.some(value => cleanCell(value))) rows.push(row);
    return rows;
}

function headerMap(headers) {
    const lookup = new Map(headers.map((header, index) => [normalizedKey(header), index]));
    return Object.fromEntries(Object.entries(HEADER_ALIASES).map(([field, aliases]) => [
        field,
        aliases.map(alias => lookup.get(normalizedKey(alias))).find(index => index !== undefined) ?? -1
    ]));
}

function amountValue(raw) {
    let value = cleanCell(raw, 80).replace(/[₸₽$€]|KZT|RUB|USD|EUR/gi, '').replace(/[\s\u00A0]/g, '');
    const parentheses = /^\(.*\)$/.test(value);
    if (parentheses) value = value.slice(1, -1);
    const comma = value.lastIndexOf(',');
    const dot = value.lastIndexOf('.');
    if (comma >= 0 && dot >= 0) {
        const decimal = comma > dot ? ',' : '.';
        value = value.replace(decimal === ',' ? /\./g : /,/g, '').replace(decimal, '.');
    } else if (comma >= 0) {
        value = /,\d{3}$/.test(value) ? value.replace(/,/g, '') : value.replace(',', '.');
    } else if (dot >= 0 && /\.\d{3}$/.test(value)) {
        value = value.replace(/\./g, '');
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number === 0) return null;
    return parentheses ? -Math.abs(number) : number;
}

function transactionType(raw, amount) {
    const value = normalizedKey(raw);
    for (const [type, aliases] of Object.entries(TYPE_ALIASES)) {
        if (aliases.has(value)) return type;
    }
    if (amount < 0) return 'expense';
    if (String(raw ?? '').trim()) return null;
    return null;
}

function dateValue(raw) {
    const value = cleanCell(raw, 80);
    if (!value) return null;
    const localMatch = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (localMatch) {
        const [, day, month, year, hour = '12', minute = '00', second = '00'] = localMatch;
        const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
        if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return null;
        return date.toISOString();
    }
    const isoDate = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDate) {
        const [, year, month, day] = isoDate;
        const date = new Date(Number(year), Number(month) - 1, Number(day), 12, 0, 0);
        if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return null;
        return date.toISOString();
    }
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function parseTransactionCsv(text) {
    const source = String(text ?? '');
    if (!source.trim()) throw new Error('CSV-файл пуст.');
    if (new Blob([source]).size > MAX_FILE_BYTES) throw new Error('CSV-файл больше 1 МБ. Выберите файл поменьше.');
    const separator = detectSeparator(source);
    const grid = parseGrid(source, separator);
    if (grid.length < 2) throw new Error('В CSV нет строк с операциями.');
    const columns = headerMap(grid[0]);
    const missing = ['date', 'title', 'amount'].filter(field => columns[field] < 0);
    if (missing.length) throw new Error('Нужны столбцы: date/дата, title/описание и amount/сумма.');
    if (grid.length - 1 > MAX_ROWS) throw new Error(`За один раз можно импортировать не больше ${MAX_ROWS} операций.`);

    const rows = [];
    const errors = [];
    grid.slice(1).forEach((values, index) => {
        const line = index + 2;
        const title = cleanCell(values[columns.title], 240);
        const amount = amountValue(values[columns.amount]);
        const occurredAt = dateValue(values[columns.date]);
        const type = transactionType(columns.type >= 0 ? values[columns.type] : '', amount ?? 0);
        const problems = [];
        if (!title) problems.push('нет описания');
        if (amount === null) problems.push('неверная сумма');
        if (!occurredAt) problems.push('неверная дата');
        if (!type) problems.push('не указан тип income/expense, доход/расход или кіріс/шығыс');
        if (problems.length) {
            errors.push({ line, message: problems.join(', ') });
            return;
        }
        rows.push({
            title,
            amount: Math.abs(amount),
            transactionType: type,
            occurredAt,
            category: columns.category >= 0 ? cleanCell(values[columns.category], 80) || 'Импорт' : 'Импорт',
            body: columns.body >= 0 ? cleanCell(values[columns.body], 12000) : ''
        });
    });
    return { rows, errors, separator };
}

export { MAX_FILE_BYTES, MAX_ROWS };
