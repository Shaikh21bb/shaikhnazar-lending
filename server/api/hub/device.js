import { readJsonBody } from '../_lib.js';
import { authenticateWorkspaceDevice, pairWorkspaceDevice, workspaceDeviceMutation } from '../_agent/workspace.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > 760000) return res.status(400).json({ error: 'Некорректный запрос устройства.' });
        const result = body.action === 'pair'
            ? await pairWorkspaceDevice(body)
            : await workspaceDeviceMutation(await authenticateWorkspaceDevice(req), body);
        return res.status(200).json(result);
    } catch (error) {
        console.error('Workspace device request failed:', error.status || 500, error.code || 'request_failed');
        return res.status(error.status || 500).json({ error: error.status ? error.message : 'Подключение Mac временно недоступно.' });
    }
}
