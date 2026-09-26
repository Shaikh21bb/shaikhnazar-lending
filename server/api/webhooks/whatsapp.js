import { db } from '../_lib.js';
import { extractWhatsAppMessages, verifyWhatsAppSignature } from '../_agent/providers.js';
import { findSalesAgent, handleSalesInbound } from '../_agent/sales.js';

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
    if (typeof req.rawBody === 'string') return req.rawBody;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return raw;
}

export default async function handler(req, res) {
    if (req.method === 'GET') {
        const mode = req.query?.['hub.mode'];
        const token = req.query?.['hub.verify_token'];
        const challenge = req.query?.['hub.challenge'];
        if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
            return res.status(200).send(challenge);
        }
        return res.status(403).json({ error: 'Webhook verification failed' });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const raw = await rawBody(req);
    if (!verifyWhatsAppSignature(raw, req.headers['x-hub-signature-256'])) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch (_) { return res.status(400).json({ error: 'Invalid JSON' }); }

    // Acknowledge status-only events without invoking the agent.
    const messages = extractWhatsAppMessages(payload);
    if (!messages.length) return res.status(200).json({ ok: true, accepted: 0 });

    try {
        const configuredId = process.env.WHATSAPP_AGENT_ID || '';
        const agent = await findSalesAgent({ id: configuredId || undefined, platform: 'whatsapp' });
        if (!agent) return res.status(503).json({ error: 'WhatsApp Sales Agent is not configured' });

        let accepted = 0;
        for (const inbound of messages) {
            if (inbound.messageId) {
                const duplicate = await db(
                    `agent_chats?select=id&agent_id=eq.${encodeURIComponent(agent.id)}&channel=eq.whatsapp&chat_id=eq.${encodeURIComponent(inbound.externalId)}&external_message_id=eq.${encodeURIComponent(inbound.messageId)}&limit=1`
                );
                if (duplicate.res.ok && duplicate.body?.length) continue;
            }
            try {
                await handleSalesInbound({ agent, inbound });
                accepted++;
            } catch (error) {
                console.error('WhatsApp message processing error:', error.message);
            }
        }
        return res.status(200).json({ ok: true, accepted });
    } catch (error) {
        console.error('WhatsApp webhook error:', error);
        return res.status(500).json({ error: 'Internal error' });
    }
}
