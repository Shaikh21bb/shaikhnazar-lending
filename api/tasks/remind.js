import { db, telegram, escapeHtml } from '../_lib.js';

const THROTTLE_MS = 10 * 60 * 1000;
const PENDING_DELAY_MS = 30 * 60 * 1000;
const DUE_SOON_MS = 60 * 60 * 1000;

const STATUS_LABEL = { pending: '⏳ Запланировано', confirmed: '✅ Подтверждено', done: '🎉 Выполнено' };

function fmtDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

function fmtShort(diffMs) {
    const m = Math.max(1, Math.round(diffMs / 60000));
    if (m < 60) return `${m} мин`;
    return `${Math.round(m / 60)} ч ${m % 60} мин`;
}

function titleLine(t) {
    return `📌 <b>${escapeHtml(t.title)}</b>`;
}

function dueLine(t) {
    return t.due_at ? `🕒 <b>Когда:</b> ${fmtDateTime(t.due_at)}` : '';
}

function statusLine(t) {
    return `Статус: ${STATUS_LABEL[t.status] || t.status}`;
}

export async function runReminders(force = false) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
        return { ok: false, reason: 'no db env' };
    }

    const now = new Date();

    // Throttle: не чаще раза в 10 минут (крон идёт через force=true)
    if (!force) {
        const { res: mRes, body: metaRows } = await db('meta?select=value&key=eq.reminders_last_check');
        const last = mRes.ok && metaRows && metaRows[0] ? new Date(metaRows[0].value).getTime() : 0;
        if (now.getTime() - last < THROTTLE_MS) {
            return { ok: true, checked: false, reason: 'throttled' };
        }
    }

    try {
        await db('meta', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify({ key: 'reminders_last_check', value: now.toISOString() })
        });
    } catch (e) {
        console.error('meta save error:', e.message);
    }

    const { res: tRes, body: tasks } = await db(
        'tasks?select=*,agents(id,name,token)&status=in.(pending,confirmed)&chat_id=not.is.null'
    );
    if (!tRes.ok) return { ok: false, error: 'db error', status: tRes.status };

    const sent = [];
    for (const t of (tasks || [])) {
        const agent = t.agents;
        if (!agent || !agent.token || !t.chat_id) continue;

        const created = t.created_at ? new Date(t.created_at) : null;
        const due = t.due_at ? new Date(t.due_at) : null;
        const patch = {};
        let lines = null;

        if (t.status === 'pending' && !t.remind_confirm && created && (now - created) > PENDING_DELAY_MS) {
            patch.remind_confirm = true;
            lines = [
                '⏰ <b>Задача не подтверждена</b>',
                titleLine(t),
                dueLine(t),
                statusLine(t),
                '',
                'Менеджер ещё не принял задачу. Нажмите «Подтвердить» или «Готово» в сообщении с задачей.'
            ];
        } else if (!t.remind_due && due && due > now && (due - now) <= DUE_SOON_MS) {
            patch.remind_due = true;
            lines = [
                `⏰ <b>Дедлайн через ${fmtShort(due - now)}</b>`,
                titleLine(t),
                dueLine(t),
                statusLine(t),
                '',
                'Убедитесь, что задача под контролем.'
            ];
        } else if (!t.remind_overdue && due && due < now) {
            patch.remind_overdue = true;
            lines = [
                '⚠️ <b>Задача просрочена</b>',
                titleLine(t),
                dueLine(t),
                statusLine(t),
                '',
                'Дедлайн уже прошёл. Отметьте задачу «Готово» или обновите время в дашборде.'
            ];
        }

        if (!lines) continue;

        try {
            await telegram('sendMessage', agent.token, {
                chat_id: t.chat_id,
                text: lines.filter(Boolean).join('\n'),
                parse_mode: 'HTML'
            });
            await db(`tasks?id=eq.${encodeURIComponent(t.id)}`, {
                method: 'PATCH',
                body: JSON.stringify(patch)
            });
            sent.push(t.title);
        } catch (e) {
            console.error('Reminder send error for task', t.id, e.message);
        }
    }

    return { ok: true, checked: true, sent };
}

export default async function handler(req, res) {
    // Защита: если CRON_SECRET задан (Vercel шлёт его в Authorization),
    // требуем совпадения — иначе эндпоинт может дёргать кто угодно.
    const auth = req.headers.authorization || '';
    if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const result = await runReminders(true);
        return res.status(200).json(result);
    } catch (error) {
        console.error('Remind endpoint error:', error);
        return res.status(500).json({ error: error.message });
    }
}
