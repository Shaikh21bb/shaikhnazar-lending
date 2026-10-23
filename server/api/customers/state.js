import { db, readJsonBody } from '../_lib.js';
import { requireLegacyDashboardSession, requireSameOrigin } from '../_auth.js';
import { legacyManagerAssignment } from '../legacy/data.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findCustomer(agentId, channel, chatId) {
    const { res, body } = await db(
        `customers?select=id,agent_id,channel,external_id,handoff_status,ai_enabled&agent_id=eq.${encodeURIComponent(agentId)}&channel=eq.${encodeURIComponent(channel)}&external_id=eq.${encodeURIComponent(chatId)}&limit=1`
    );
    if (!res.ok) throw new Error(`Customer lookup failed (${res.status})`);
    return body?.[0] || null;
}

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    const session = await requireLegacyDashboardSession(req, res);
    if (!session) return;
    if (req.method === 'POST' && !requireSameOrigin(req, res)) return;

    try {
        const input = req.method === 'GET' ? req.query || {} : await readJsonBody(req);
        const agentId = String(input.agentId || '');
        const channel = String(input.channel || '');
        const chatId = String(input.chatId || '');
        if (!UUID.test(agentId) || !['telegram', 'whatsapp', 'local'].includes(channel) || !chatId || chatId.length > 255) {
            return res.status(400).json({ error: 'Invalid customer selector' });
        }
        if (session.role === 'manager') {
            const manager = await legacyManagerAssignment(session);
            if (!manager.agent_id || String(manager.agent_id) !== agentId) {
                return res.status(403).json({ error: 'Customer is outside the manager scope' });
            }
        }
        const customer = await findCustomer(agentId, channel, chatId);
        if (!customer) return res.status(404).json({ error: 'Customer not found' });
        if (req.method === 'GET') return res.status(200).json({ customer });

        const toHuman = input.handoffStatus === 'human';
        if (input.handoffStatus !== 'human' && input.handoffStatus !== 'ai') {
            return res.status(400).json({ error: 'Invalid handoffStatus' });
        }
        const { res: patchRes, body } = await db(
            `customers?id=eq.${encodeURIComponent(customer.id)}&agent_id=eq.${encodeURIComponent(agentId)}`,
            {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
                handoff_status: toHuman ? 'human' : 'ai',
                ai_enabled: !toHuman,
                handoff_reason: toHuman ? 'Передано менеджером из панели' : null,
                updated_at: new Date().toISOString()
            })
            }
        );
        if (!patchRes.ok) throw new Error(`Customer update failed (${patchRes.status})`);
        if (!body?.[0]) return res.status(409).json({ error: 'Customer changed; reload and try again' });
        return res.status(200).json({ customer: body[0] });
    } catch (error) {
        console.error('Customer state error:', error.message);
        return res.status(error.status || 500).json({ error: error.status && error.status < 500
            ? error.message
            : 'Customer state unavailable' });
    }
}
