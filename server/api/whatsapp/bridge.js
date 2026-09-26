import { createHash, timingSafeEqual } from 'node:crypto';
import { db, readJsonBody } from '../_lib.js';
import { requireDashboardSession } from '../_auth.js';
import { findSalesAgent, handleSalesInbound } from '../_agent/sales.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JID = /^\d{6,20}@(s\.whatsapp\.net|lid)$/;
const STATES = new Set(['connecting', 'qr', 'connected', 'offline', 'logged_out']);

function validWorkerSecret(value) {
    const expected = process.env.WHATSAPP_BRIDGE_SECRET;
    if (!expected || typeof value !== 'string') return false;
    const digest = input => createHash('sha256').update(input).digest();
    return timingSafeEqual(digest(value), digest(expected));
}

async function saveStatus(agentId, body) {
    const state = String(body.state || '');
    if (!STATES.has(state)) throw new Error('Invalid bridge state');
    const qrImage = state === 'qr' ? String(body.qrImage || '') : '';
    if (state === 'qr' && (!qrImage.startsWith('data:image/png;base64,') || qrImage.length > 120000)) {
        throw new Error('Invalid QR image');
    }
    const status = await db('whatsapp_bridge_sessions?on_conflict=agent_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
            agent_id: agentId,
            state,
            qr_image: qrImage || null,
            last_seen_at: new Date().toISOString(),
            last_error: String(body.error || '').slice(0, 500) || null
        })
    });
    if (!status.res.ok) throw new Error(`Bridge status save failed (${status.res.status})`);
    const agent = await db(`agents?id=eq.${encodeURIComponent(agentId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ connected: state === 'connected' })
    });
    if (!agent.res.ok) throw new Error(`Agent connection save failed (${agent.res.status})`);
}

async function pollOutbox(agentId) {
    const now = new Date().toISOString();
    const query = `whatsapp_outbox?select=id,recipient_id,body,attempts,task_id&agent_id=eq.${encodeURIComponent(agentId)}&state=eq.pending&next_attempt_at=lte.${encodeURIComponent(now)}&order=created_at.asc&limit=10`;
    const { res, body } = await db(query);
    if (!res.ok) throw new Error(`Outbox load failed (${res.status})`);
    const jobs = [];
    for (const item of body || []) {
        const claim = await db(`whatsapp_outbox?id=eq.${encodeURIComponent(item.id)}&agent_id=eq.${encodeURIComponent(agentId)}&state=eq.pending`, {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
                state: 'processing',
                claimed_at: now,
                attempts: item.attempts + 1
            })
        });
        if (!claim.res.ok) throw new Error(`Outbox claim failed (${claim.res.status})`);
        if (claim.body?.[0]) jobs.push({
            id: item.id,
            recipientId: item.recipient_id,
            text: item.body
        });
    }
    return jobs;
}

async function acknowledge(agentId, body) {
    if (!UUID.test(String(body.id || ''))) throw new Error('Invalid message id');
    const path = `whatsapp_outbox?select=id,attempts,task_id&id=eq.${encodeURIComponent(body.id)}&agent_id=eq.${encodeURIComponent(agentId)}&state=eq.processing&limit=1`;
    const lookup = await db(path);
    if (!lookup.res.ok) throw new Error(`Outbox lookup failed (${lookup.res.status})`);
    const job = lookup.body?.[0];
    if (!job) return false;
    const sent = body.sent === true;
    const retry = !sent && job.attempts < 3;
    const error = sent ? null : String(body.error || 'WhatsApp send failed').slice(0, 500);
    const nextAttemptAt = new Date(Date.now() + 30_000 * job.attempts).toISOString();
    const update = await db(`whatsapp_outbox?id=eq.${encodeURIComponent(job.id)}&agent_id=eq.${encodeURIComponent(agentId)}&state=eq.processing`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
            state: sent ? 'sent' : (retry ? 'pending' : 'failed'),
            sent_at: sent ? new Date().toISOString() : null,
            claimed_at: null,
            next_attempt_at: nextAttemptAt,
            provider_message_id: sent ? String(body.messageId || '').slice(0, 255) : null,
            last_error: error
        })
    });
    if (!update.res.ok || !update.body?.[0]) throw new Error('Outbox acknowledgement failed');
    if (job.task_id && (sent || !retry)) {
        const task = await db(`tasks?id=eq.${encodeURIComponent(job.task_id)}`, {
            method: 'PATCH',
            body: JSON.stringify(sent ? {
                status: 'done',
                sent_at: new Date().toISOString(),
                processing_at: null,
                last_error: null
            } : {
                auto_send: false,
                processing_at: null,
                last_error: error
            })
        });
        if (!task.res.ok) throw new Error(`Follow-up acknowledgement failed (${task.res.status})`);
    }
    return true;
}

export default async function handler(req, res) {
    if (process.env.WHATSAPP_DELIVERY_MODE !== 'qr') {
        return res.status(503).json({ error: 'QR bridge is not configured' });
    }
    if (req.method === 'GET') {
        if (!requireDashboardSession(req, res)) return;
        const agentId = String(req.query?.agentId || '');
        if (!UUID.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
        try {
            const result = await db(`whatsapp_bridge_sessions?select=state,qr_image,last_seen_at,last_error&agent_id=eq.${encodeURIComponent(agentId)}&limit=1`);
            if (!result.res.ok) throw new Error(`Bridge status load failed (${result.res.status})`);
            const row = result.body?.[0];
            const fresh = row && Date.now() - new Date(row.last_seen_at).getTime() < 45000;
            return res.status(200).json({
                state: fresh ? row.state : 'offline',
                qrImage: fresh && row.state === 'qr' ? row.qr_image : null,
                lastSeenAt: row?.last_seen_at || null,
                error: row?.last_error || null
            });
        } catch (error) {
            console.error('Bridge status error:', error);
            return res.status(500).json({ error: 'Bridge status unavailable' });
        }
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!process.env.WHATSAPP_BRIDGE_SECRET) return res.status(503).json({ error: 'Bridge secret missing' });
    if (!validWorkerSecret(req.headers['x-whatsapp-bridge-secret'])) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const body = await readJsonBody(req);
        if (body.action === 'bootstrap') {
            const result = await db('agents?select=id,name&agent_type=eq.sales&platform=eq.whatsapp&order=created_at.asc&limit=2');
            if (!result.res.ok) throw new Error(`Agent lookup failed (${result.res.status})`);
            if (result.body?.length !== 1) {
                return res.status(409).json({ error: 'Exactly one WhatsApp Sales Agent is required' });
            }
            return res.status(200).json({ ok: true, agentId: result.body[0].id, name: result.body[0].name });
        }
        const agentId = String(body.agentId || '');
        if (!UUID.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
        const agent = await findSalesAgent({ id: agentId, platform: 'whatsapp' });
        if (!agent) return res.status(404).json({ error: 'WhatsApp Sales Agent not found' });
        if (body.action === 'status') {
            await saveStatus(agentId, body);
            return res.status(200).json({ ok: true });
        }
        if (body.action === 'poll') {
            return res.status(200).json({ ok: true, jobs: await pollOutbox(agentId) });
        }
        if (body.action === 'ack') {
            return res.status(200).json({ ok: await acknowledge(agentId, body) });
        }
        if (body.action === 'inbound') {
            const externalId = String(body.from || '');
            const text = String(body.text || '').trim().slice(0, 4000);
            const messageId = String(body.messageId || '').slice(0, 255);
            if (!JID.test(externalId) || !text || !messageId) {
                return res.status(400).json({ error: 'Invalid inbound message' });
            }
            const duplicate = await db(`agent_chats?select=id&agent_id=eq.${encodeURIComponent(agentId)}&channel=eq.whatsapp&chat_id=eq.${encodeURIComponent(externalId)}&external_message_id=eq.${encodeURIComponent(messageId)}&limit=1`);
            if (!duplicate.res.ok) throw new Error(`Duplicate check failed (${duplicate.res.status})`);
            if (duplicate.body?.length) return res.status(200).json({ ok: true, duplicate: true });
            const result = await handleSalesInbound({
                agent,
                inbound: {
                    channel: 'whatsapp',
                    externalId,
                    phone: externalId.endsWith('@s.whatsapp.net') ? externalId.split('@')[0] : '',
                    name: String(body.name || '').slice(0, 255),
                    text,
                    messageId,
                    timestamp: new Date().toISOString()
                }
            });
            return res.status(200).json({ ok: true, replied: result.replied });
        }
        return res.status(400).json({ error: 'Unknown action' });
    } catch (error) {
        console.error('WhatsApp bridge error:', error);
        return res.status(500).json({ error: 'Bridge request failed' });
    }
}
