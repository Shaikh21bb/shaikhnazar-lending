import { db } from '../_lib.js';
import { runScheduledFollowup } from '../_agent/sales.js';

async function claimTask(taskId) {
    const { res, body } = await db(
        `tasks?id=eq.${encodeURIComponent(taskId)}&sent_at=is.null&processing_at=is.null`,
        {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ processing_at: new Date().toISOString() })
        }
    );
    return res.ok ? body?.[0] : null;
}

export default async function handler(req, res) {
    const auth = req.headers.authorization || '';
    if (!process.env.CRON_SECRET) {
        return res.status(503).json({ error: 'CRON_SECRET missing' });
    }
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const now = new Date().toISOString();
        const { res: taskRes, body: tasks } = await db(
            `tasks?select=*&source=eq.sales_agent&auto_send=eq.true&sent_at=is.null&status=in.(pending,confirmed)&due_at=lte.${encodeURIComponent(now)}&order=due_at.asc&limit=25`
        );
        if (!taskRes.ok) return res.status(500).json({ error: 'Could not load follow-ups' });

        const results = [];
        for (const candidate of tasks || []) {
            const task = await claimTask(candidate.id);
            if (!task) continue;
            try {
                const [agentResult, customerResult] = await Promise.all([
                    db(`agents?select=*&id=eq.${encodeURIComponent(task.agent_id)}&limit=1`),
                    db(`customers?select=*&id=eq.${encodeURIComponent(task.customer_id)}&limit=1`)
                ]);
                const agent = agentResult.body?.[0];
                const customer = customerResult.body?.[0];
                if (!agent || !customer) throw new Error('Agent or customer not found');
                await runScheduledFollowup({ task, agent, customer });
                await db(`tasks?id=eq.${encodeURIComponent(task.id)}`, {
                    method: 'PATCH',
                    body: JSON.stringify({
                        status: 'done',
                        sent_at: new Date().toISOString(),
                        processing_at: null,
                        last_error: null
                    })
                });
                results.push({ id: task.id, ok: true });
            } catch (error) {
                await db(`tasks?id=eq.${encodeURIComponent(task.id)}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ processing_at: null, last_error: String(error.message).slice(0, 1000) })
                });
                results.push({ id: task.id, ok: false, error: error.message });
            }
        }
        return res.status(200).json({ ok: true, checked: tasks?.length || 0, results });
    } catch (error) {
        console.error('Follow-up runner error:', error);
        return res.status(500).json({ error: error.message });
    }
}
