import { createHash, timingSafeEqual } from 'node:crypto';
import { db } from '../_lib.js';
import { deliverWorkspaceReminders } from '../_agent/workspace.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    const authorization = String(req.headers?.authorization || '');
    if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const result = await db('workspace_scheduler?select=token_hash&singleton=eq.true&limit=1');
        if (!result.res.ok || !result.body?.[0]) return res.status(503).json({ error: 'Scheduler unavailable' });
        const actual = createHash('sha256').update(authorization.slice(7)).digest();
        const expected = Buffer.from(result.body[0].token_hash, 'hex');
        if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) return res.status(401).json({ error: 'Unauthorized' });
        return res.status(200).json(await deliverWorkspaceReminders());
    } catch {
        console.error('Workspace reminder runner unavailable');
        return res.status(503).json({ error: 'Scheduler unavailable' });
    }
}
