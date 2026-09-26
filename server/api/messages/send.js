import { db, readJsonBody } from '../_lib.js';
import { sendChannelMessage } from '../_agent/providers.js';
import { requireDashboardSession } from '../_auth.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!requireDashboardSession(req, res)) return;
    try {
        const { id, chatId, text } = await readJsonBody(req);
        if (!id || !chatId || !text) return res.status(400).json({ error: 'Missing id, chatId or text' });
        const agentResult = await db(`agents?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
        const agent = agentResult.body?.[0];
        if (!agent) return res.status(404).json({ error: 'Agent not found' });

        const customerResult = await db(
            `customers?select=*&agent_id=eq.${encodeURIComponent(id)}&external_id=eq.${encodeURIComponent(chatId)}&limit=1`
        );
        const customer = customerResult.body?.[0];
        const channel = customer?.channel || agent.platform;
        const delivery = await sendChannelMessage({
            channel,
            agent,
            recipientId: String(chatId),
            text: String(text)
        });
        await db('agent_chats', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
                agent_id: agent.id,
                customer_id: customer?.id || null,
                chat_id: String(chatId),
                channel,
                role: 'assistant',
                text: String(text).slice(0, 4000),
                external_message_id: delivery.messageId || null,
                metadata: { sent_by: 'human' }
            })
        });
        return res.status(200).json({ ok: true, delivery });
    } catch (error) {
        console.error('Manual message send error:', error);
        return res.status(500).json({ error: error.message });
    }
}
