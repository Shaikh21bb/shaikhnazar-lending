import { db, telegram, escapeHtml } from '../_lib.js';

const STATUS_LABEL = { pending: '⏳ Запланировано', confirmed: '✅ Подтверждено', done: '🎉 Выполнено' };

function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { taskId } = await new Promise(resolve => {
            let raw = '';
            req.on('data', c => raw += c);
            req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
        });

        if (!taskId) return res.status(400).json({ error: 'Missing taskId' });

        const { res: tRes, body: tasks } = await db(`tasks?select=*&id=eq.${encodeURIComponent(taskId)}`);
        if (!tRes.ok || !tasks || tasks.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        const task = tasks[0];

        if (!task.agent_id || !task.chat_id) {
            return res.status(400).json({ error: 'Task has no agent or manager chat assigned' });
        }

        const { res: aRes, body: agents } = await db(`agents?select=id,name,token&id=eq.${encodeURIComponent(task.agent_id)}`);
        if (!aRes.ok || !agents || agents.length === 0) {
            return res.status(404).json({ error: 'Agent not found for this task' });
        }
        const agent = agents[0];

        const lines = [
            `📌 <b>Задача: ${escapeHtml(task.title)}</b>`,
            task.description ? escapeHtml(task.description) : '',
            task.due_at ? `🕒 <b>Когда:</b> ${formatDate(task.due_at)}` : '',
            task.manager ? `👤 <b>Менеджер:</b> ${escapeHtml(task.manager)}` : '',
            task.lead_name ? `🎯 <b>Клиент:</b> ${escapeHtml(task.lead_name)}${task.lead_contact ? ' (' + escapeHtml(task.lead_contact) + ')' : ''}` : '',
            '',
            STATUS_LABEL[task.status] || task.status
        ].filter(Boolean).join('\n');

        await telegram('sendMessage', agent.token, {
            chat_id: task.chat_id,
            text: lines,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Подтвердить', callback_data: `task:confirm:${task.id}` },
                    { text: '🎉 Готово', callback_data: `task:done:${task.id}` }
                ]]
            }
        });

        return res.status(200).json({ ok: true });
    } catch (error) {
        console.error('Task notify error:', error);
        return res.status(500).json({ error: error.message });
    }
}
