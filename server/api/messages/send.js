import { db, readJsonBody } from '../_lib.js';
import { sendChannelMessage } from '../_agent/providers.js';
import { requireLegacyDashboardSession, requireSameOrigin } from '../_auth.js';
import { legacyManagerAssignment } from '../legacy/data.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const session = await requireLegacyDashboardSession(req, res);
    if (!session || !requireSameOrigin(req, res)) return;
    try {
        const { id, chatId, text } = await readJsonBody(req);
        if (!UUID.test(String(id || '')) || !String(chatId || '').trim() || String(chatId).length > 255 || !String(text || '').trim()) {
            return res.status(400).json({ error: 'Invalid id, chatId or text' });
        }
        if (session.role === 'manager') {
            const manager = await legacyManagerAssignment(session);
            if (!manager.agent_id || String(manager.agent_id) !== String(id)) {
                return res.status(403).json({ error: 'Agent is outside the manager scope' });
            }
        }
        const agentResult = await db(`agents?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
        if (!agentResult.res.ok) throw Object.assign(new Error('Agent lookup failed'), { status: 503 });
        const agent = agentResult.body?.[0];
        if (!agent) return res.status(404).json({ error: 'Agent not found' });

        const customerResult = await db(
            `customers?select=*&agent_id=eq.${encodeURIComponent(id)}&external_id=eq.${encodeURIComponent(chatId)}&limit=1`
        );
        if (!customerResult.res.ok) throw Object.assign(new Error('Customer lookup failed'), { status: 503 });
        const customer = customerResult.body?.[0];
        if (session.role === 'manager' && !customer) {
            return res.status(404).json({ error: 'Customer not found for the assigned agent' });
        }
        const channel = customer?.channel || agent.platform;
        const messageText = String(text).trim().slice(0, 4000);
        const delivery = await sendChannelMessage({
            channel,
            agent,
            recipientId: String(chatId),
            text: messageText
        });
        const history = await db('agent_chats', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
                agent_id: agent.id,
                customer_id: customer?.id || null,
                chat_id: String(chatId),
                channel,
                role: 'assistant',
                text: messageText,
                external_message_id: delivery?.messageId || null,
                metadata: { sent_by: 'human' }
            })
        });
        if (!history.res.ok) console.error('Manual message history save failed:', history.res.status);
        return res.status(200).json({ ok: true, delivery, historySaved: history.res.ok });
    } catch (error) {
        console.error('Manual message send error:', error.message);
        return res.status(error.status || 500).json({ error: error.status && error.status < 500
            ? error.message
            : 'Message delivery failed' });
    }
}
