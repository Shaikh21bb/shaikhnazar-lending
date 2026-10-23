import { readJsonBody } from '../_lib.js';
import { requireHubSession, requireSameOrigin } from '../_auth.js';
import { ensurePersonalAgent } from '../_agent/personal.js';
import { importTransactions } from '../_agent/finance-import.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const session = requireHubSession(req, res);
    if (!session || !requireSameOrigin(req, res)) return;
    try {
        const body = await readJsonBody(req);
        if (body.action !== 'transaction_csv') return res.status(400).json({ error: 'Unknown import action' });
        const agent = await ensurePersonalAgent(session);
        return res.status(200).json(await importTransactions(agent.id, body.rows));
    } catch (error) {
        console.error('Agent Hub import error:', error.message);
        return res.status(error.status || 500).json({ error: error.message || 'Import failed' });
    }
}
