import { createHash } from 'node:crypto';

export const TIMEZONE = 'Asia/Almaty';

export function localParts(date, timezone = TIMEZONE) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

export function fromLocalParts(parts, timezone = TIMEZONE) {
    const wanted = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
    let candidate = wanted;
    for (let i = 0; i < 3; i++) {
        const actual = localParts(new Date(candidate), timezone);
        const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
        candidate += wanted - represented;
    }
    return new Date(candidate);
}

export function localTimestamp(date = new Date(), timezone = TIMEZONE) {
    const parts = localParts(date, timezone);
    const two = value => String(value).padStart(2, '0');
    return `${parts.year}-${two(parts.month)}-${two(parts.day)} ${two(parts.hour)}:${two(parts.minute)}:${two(parts.second)} (${timezone})`;
}

function calendarDate(year, month, day) {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
    return { year, month, day };
}

function explicitComponents(text, reference, timezone) {
    const value = String(text || '');
    const dates = [];
    const times = [];
    const offsets = [];
    const local = localParts(reference, timezone);
    for (const match of value.matchAll(/(?<![\p{L}\d])(послезавтра|завтра|сегодня)(?![\p{L}\d])/giu)) {
        const delta = { сегодня: 0, завтра: 1, послезавтра: 2 }[match[1].toLocaleLowerCase('ru')];
        const day = new Date(Date.UTC(local.year, local.month - 1, local.day + delta));
        dates.push({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() });
    }
    for (const match of value.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/gu)) {
        dates.push(calendarDate(Number(match[1]), Number(match[2]), Number(match[3])));
    }
    for (const match of value.matchAll(/(?<!\d)(\d{2})\.(\d{2})\.(\d{4})(?!\d)/gu)) {
        dates.push(calendarDate(Number(match[3]), Number(match[2]), Number(match[1])));
    }
    // Offset tokens in a user-supplied ISO timestamp are not additional event times.
    for (const match of value.matchAll(/\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})/gu)) {
        const offset = match[1];
        const start = match.index + match[0].length - offset.length;
        offsets.push({ start, end: start + offset.length, value: offset });
    }
    for (const match of value.matchAll(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/gu)) {
        if (offsets.some(offset => match.index >= offset.start && match.index < offset.end)) continue;
        times.push({ hour: Number(match[1]), minute: Number(match[2]) });
    }
    return { dates, times, offset: offsets.length === 1 ? offsets[0].value : null, invalidOffset: offsets.length > 1 };
}

export function explicitDeadline(text, { clarification, now = new Date(), originalNow = now, timezone = TIMEZONE } = {}) {
    const original = explicitComponents(text, originalNow, timezone);
    const followup = clarification ? explicitComponents(clarification, now, timezone) : null;
    // A supplied follow-up replaces only the date/time components it explicitly contains.
    const dates = followup?.dates.length ? followup.dates : original.dates;
    const times = followup?.times.length ? followup.times : original.times;
    if (dates.length > 1 || times.length > 1 || original.invalidOffset || followup?.invalidOffset) return { resolved: false, reason: 'ambiguous' };
    if (dates.some(date => !date)) return { resolved: false, reason: 'invalid_date' };
    if (!dates.length || !times.length) return { resolved: false, reason: !dates.length ? 'missing_date' : 'missing_time' };
    const date = dates[0];
    const time = times[0];
    const offset = followup?.times.length ? followup.offset : original.offset;
    let due;
    if (offset) {
        // An offset written by the user is explicit input. Model-produced offsets never enter here.
        const two = value => String(value).padStart(2, '0');
        due = new Date(`${date.year}-${two(date.month)}-${two(date.day)}T${two(time.hour)}:${two(time.minute)}:00${offset}`);
    } else due = fromLocalParts({ ...date, ...time }, timezone);
    if (!Number.isFinite(due.getTime())) return { resolved: false, reason: 'invalid_date' };
    return { resolved: true, dueAt: due.toISOString() };
}

export function bindExplicitDeadline(tasks, text, options = {}) {
    const valid = (Array.isArray(tasks) ? tasks : []).filter(task => task && typeof task.text === 'string' && task.text.trim()).slice(0, 12);
    const parsed = explicitDeadline(text, options);
    // One date shared between several extracted actions is insufficient to assign their individual deadlines.
    if (valid.length !== 1 || !parsed.resolved) return valid.map(task => ({ ...task, dueAt: null, needsClarification: true }));
    const source = `${text}\n${options.clarification || ''}`;
    const meetingPattern = /(?<![\p{L}])(?:встреча|встречаемся|созвон|созвонимся|meeting)(?![\p{L}])/iu;
    const meeting = meetingPattern.test(source);
    const preparation = /^(?:(?:нужно|надо|необходимо)\s+)?(?:подготов|состав|собра|напис|сдела|закончи|продум|разработ|прочита|изучи)/iu.test(valid[0].text.trim());
    if (meeting && preparation) {
        const eventClause = String(text).split(/(?:[.!?;]\s+|\n+)/u).find(clause => meetingPattern.test(clause)
            && !/(?:отмен|не будет|перенес)/iu.test(clause) && explicitDeadline(clause, options).resolved);
        if (eventClause) return [
            { text: eventClause.trim().slice(0, 1000), dueAt: parsed.dueAt, needsClarification: false, kind: 'meeting' },
            { ...valid[0], dueAt: null, needsClarification: true, kind: 'task' },
        ];
        return [{ ...valid[0], dueAt: null, needsClarification: true, kind: 'task' }];
    }
    return [{ ...valid[0], dueAt: parsed.dueAt, needsClarification: false, kind: meeting ? 'meeting' : 'task' }];
}

export function deferQuietHours(date, timezone = TIMEZONE) {
    const parts = localParts(date, timezone);
    if (parts.hour >= 9 && parts.hour < 22) return date;
    const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + (parts.hour >= 22 ? 1 : 0)));
    return fromLocalParts({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 9 }, timezone);
}

export function nextDailyOverview(now = new Date(), timezone = TIMEZONE) {
    const parts = localParts(now, timezone);
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + (parts.hour >= 9 ? 1 : 0)));
    return fromLocalParts({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: 9 }, timezone);
}

export function normalizeTasks(tasks, { jobId, now = new Date(), timezone = TIMEZONE } = {}) {
    const reminders = [];
    const clarification = [];
    const local = [];
    for (const [index, task] of (Array.isArray(tasks) ? tasks : []).slice(0, 12).entries()) {
        if (!task || typeof task.text !== 'string' || !task.text.trim()) continue;
        // Dates without an explicit time or offset must be clarified, never guessed.
        const due = typeof task.dueAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(task.dueAt) ? new Date(task.dueAt) : null;
        if (task.needsClarification || !due || !Number.isFinite(due.getTime()) || due <= now) {
            clarification.push({ text: task.text.slice(0, 1000), question: 'На какую дату и время поставить напоминание? Время Алматы.' });
            continue;
        }
        let notifyAt = new Date(due.getTime() - (task.kind === 'meeting' ? 30 * 60_000 : 0));
        if (notifyAt < now) notifyAt = new Date(now.getTime() + 60_000);
        notifyAt = deferQuietHours(notifyAt, timezone);
        // A quiet-hours deferral beyond a meeting is shown for clarification instead of a late alert.
        if (task.kind === 'meeting' && notifyAt >= due) {
            clarification.push({ text: task.text.slice(0, 1000), question: 'Встреча попадает в тихие часы 22:00–09:00. Уточни удобное время напоминания.' });
            continue;
        }
        const hash = createHash('sha256').update(`${jobId}:${index}:${due.toISOString()}`).digest('hex');
        const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        reminders.push({ id, due_at: notifyAt.toISOString() });
        local.push({ id, text: task.text.slice(0, 1000), dueAt: due.toISOString(), notifyAt: notifyAt.toISOString(), kind: task.kind === 'meeting' ? 'meeting' : 'task' });
    }
    return { reminders, clarification, local };
}
