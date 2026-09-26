import { readJsonBody } from '../_lib.js';
import { findSalesAgent, handleSalesInbound } from '../_agent/sales.js';
import { requireDashboardSession } from '../_auth.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (process.env.VERCEL_ENV === 'production' && process.env.SALES_AGENT_DEV_MODE !== 'true') {
        return res.status(404).json({ error: 'Not found' });
    }
    if (process.env.VERCEL_ENV === 'production' && !requireDashboardSession(req, res)) return;
    try {
        const body = await readJsonBody(req);
        if (!body.message) return res.status(400).json({ error: 'message is required' });
        const agent = await findSalesAgent({ id: body.agentId || undefined });
        if (!agent) return res.status(404).json({ error: 'Sales Agent not found' });
        const result = await handleSalesInbound({
            agent,
            deliver: false,
            inbound: {
                channel: 'local',
                externalId: String(body.customerId || 'local-demo-customer'),
                name: String(body.customerName || 'Локальный клиент'),
                phone: body.phone ? String(body.phone) : '',
                text: String(body.message),
                messageId: `local-in-${Date.now()}`,
                timestamp: new Date().toISOString()
            }
        });
        return res.status(200).json(result);
    } catch (error) {
        console.error('Sales simulation error:', error);
        return res.status(500).json({ error: error.message });
    }
}
