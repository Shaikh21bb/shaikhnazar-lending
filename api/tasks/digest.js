import { db, telegram, escapeHtml } from '../_lib.js';

function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

function fmtDay(d) {
    return d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
}

function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

async function managerDigest(manager) {
    if (!manager.chat_id || !manager.agent_id) {
        return { skipped: 'no chat or agent' };
    }

    const { res: aRes, body: agents } = await db(
        `agents?select=id,name,token&id=eq.${encodeURIComponent(manager.agent_id)}`
    );
    if (!aRes.ok || !agents || !agents[0] || !agents[0].token) {
        return { skipped: 'agent not found / no token' };
    }
    const agent = agents[0];

    const { res: tRes, body: tasks } = await db(
        `tasks?select=title,due_at,status,chat_id&chat_id=eq.${encodeURIComponent(manager.chat_id)}`
    );
    const myTasks = tRes.ok ? (tasks || []) : [];

    const now = new Date();
    const today = myTasks.filter(t => t.status !== 'done' && t.due_at && isSameDay(new Date(t.due_at), now));
    const overdue = myTasks.filter(t => t.status !== 'done' && t.due_at && new Date(t.due_at) < now);
    const pending = myTasks.filter(t => t.status === 'pending');

    // Новые клиенты за 24ч у этого агента
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const { res: cRes, body: chats } = await db(
        `agent_chats?select=chat_id,text,created_at&agent_id=eq.${encodeURIComponent(manager.agent_id)}&role=eq.user&created_at=gt.${encodeURIComponent(since)}`
    );
    const newChats = cRes.ok ? (chats || []) : [];
    const newClients = new Set(newChats.map(c => c.chat_id)).size;

    const lines = [];
    lines.push('📋 <b>SHAIKH · Утренняя сводка</b>');
    lines.push(`🗓 Сегодня: ${fmtDay(now)}`);
    lines.push('');
    lines.push(`✅ Задач на сегодня: <b>${today.length}</b>`);
    today.sort((a, b) => a.due_at < b.due_at ? -1 : 1).forEach(t => {
        lines.push(`  • ${escapeHtml(t.title)} — ${fmtDate(t.due_at)}`);
    });
    if (!today.length) lines.push('  (нет)');
    lines.push('');
    lines.push(`⚠️ Просрочено: <b>${overdue.length}</b>`);
    overdue.sort((a, b) => a.due_at < b.due_at ? -1 : 1).slice(0, 5).forEach(t => {
        lines.push(`  • ${escapeHtml(t.title)} — было: ${fmtDate(t.due_at)}`);
    });
    if (!overdue.length) lines.push('  (нет)');
    lines.push('');
    lines.push(`⏳ Не подтверждено: <b>${pending.length}</b>`);
    lines.push('');
    lines.push(`💬 Новые клиенты за 24 часа: <b>${newClients}</b>${newClients ? ` (${newChats.length} сообщений)` : ''}`);
    lines.push('');
    lines.push('Удачного дня! 🚀');

    await telegram('sendMessage', agent.token, {
        chat_id: manager.chat_id,
        text: lines.join('\n'),
        parse_mode: 'HTML'
    });

    return { sent: true, tasks: today.length, overdue: overdue.length, newClients };
}

export async function runDigest() {
    const { res: mRes, body: managers } = await db('managers?select=id,name,chat_id,agent_id');
    if (!mRes.ok) return { ok: false, error: 'db error' };

    const results = [];
    for (const m of (managers || [])) {
        try {
            results.push({ manager: m.name, ...(await managerDigest(m)) });
        } catch (e) {
            console.error('Digest error for manager', m.name, e.message);
            results.push({ manager: m.name, error: e.message });
        }
    }
    return { ok: true, managers: results.length, results };
}

export default async function handler(req, res) {
    const auth = req.headers.authorization || '';
    if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const result = await runDigest();
        return res.status(200).json(result);
    } catch (error) {
        console.error('Digest endpoint error:', error);
        return res.status(500).json({ error: error.message });
    }
}