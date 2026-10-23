import { readJsonBody } from '../_lib.js';
import { requireHubSession, requireSameOrigin } from '../_auth.js';
import {
    createPersonalRecord,
    deletePersonalRecord,
    ensurePersonalAgent,
    listPersonalRecords,
    updatePersonalRecord
} from '../_agent/personal.js';

function scalarQuery(value) {
    return Array.isArray(value) ? value[0] : value;
}

function integerQuery(value, fallback, min, max) {
    const scalar = scalarQuery(value);
    if (scalar === undefined || scalar === null || String(scalar).trim() === '') return fallback;
    const numeric = Number(scalar);
    if (!Number.isSafeInteger(numeric)) return fallback;
    return Math.min(Math.max(numeric, min), max);
}

function booleanQuery(value) {
    const scalar = scalarQuery(value);
    if (scalar === true || scalar === 1) return true;
    return typeof scalar === 'string' && ['1', 'true'].includes(scalar.trim().toLowerCase());
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    const session = requireHubSession(req, res);
    if (!session) return;
    try {
        const agent = await ensurePersonalAgent(session);
        if (req.method === 'GET') {
            const records = await listPersonalRecords(agent.id, {
                kind: scalarQuery(req.query?.kind) || undefined,
                search: scalarQuery(req.query?.search) || '',
                limit: integerQuery(req.query?.limit, 160, 1, 250),
                offset: integerQuery(req.query?.offset, 0, 0, 10_000),
                upcoming: booleanQuery(req.query?.upcoming),
                past: booleanQuery(req.query?.past)
            });
            return res.status(200).json({ records });
        }
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        if (!requireSameOrigin(req, res)) return;
        const body = await readJsonBody(req);
        if (body.action === 'create') {
            return res.status(201).json({ record: await createPersonalRecord(agent.id, body.record || {}) });
        }
        if (body.action === 'update') {
            return res.status(200).json({ record: await updatePersonalRecord(agent.id, body.id || body.record?.id, body.record || {}) });
        }
        if (body.action === 'delete') {
            return res.status(200).json(await deletePersonalRecord(agent.id, body.id));
        }
        return res.status(400).json({ error: 'Unknown action' });
    } catch (error) {
        console.error('Agent Hub records error:', error.message);
        return res.status(error.status || 500).json({ error: error.message || 'Record operation failed' });
    }
}
