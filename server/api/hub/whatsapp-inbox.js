import { requireHubSession } from '../_auth.js';
import { whatsappInboxOverview } from '../_agent/whatsapp-inbox.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const session = requireHubSession(req, res);
    if (!session) return;
    try {
        const query = { ...Object.fromEntries(new URL(req.url || '/', 'http://localhost').searchParams), ...req.query };
        return res.status(200).json(await whatsappInboxOverview(session, query));
    } catch (error) {
        // Only a code is logged; message bodies, contacts and raw DB errors stay private.
        console.error('WhatsApp inbox request failed:', error.status || 500, error.code || 'request_failed');
        return res.status(error.status || 500).json({ error: error.status ? error.message : 'Переписка временно недоступна.' });
    }
}
