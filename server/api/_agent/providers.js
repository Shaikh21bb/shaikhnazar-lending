import { createHmac, timingSafeEqual } from 'crypto';
import { db, telegram } from '../_lib.js';

export function isQrWhatsApp() {
    return process.env.WHATSAPP_DELIVERY_MODE === 'qr';
}

export function providerMessageId(channel, payload = {}) {
    if (channel === 'whatsapp') return payload.id || null;
    if (channel === 'telegram') return payload.message_id ? String(payload.message_id) : null;
    return payload.id || null;
}

export async function sendChannelMessage({ channel, agent, recipientId, text, template, taskId }) {
    const message = String(text || '').slice(0, 4000);
    if (channel === 'telegram') {
        const result = await telegram('sendMessage', agent.token, { chat_id: recipientId, text: message });
        return { ok: true, messageId: String(result.message_id || '') };
    }
    if (channel === 'whatsapp') {
        if (isQrWhatsApp()) {
            const queued = await db('whatsapp_outbox', {
                method: 'POST',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify({
                    agent_id: agent.id,
                    recipient_id: String(recipientId),
                    body: message,
                    task_id: taskId || null
                })
            });
            if (!queued.res.ok || !queued.body?.[0]) {
                throw new Error(`WhatsApp QR message queue failed (${queued.res.status})`);
            }
            return { ok: true, queued: true, outboxId: queued.body[0].id, messageId: null };
        }
        const token = process.env.WHATSAPP_ACCESS_TOKEN;
        const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
        const version = process.env.WHATSAPP_GRAPH_VERSION || 'v23.0';
        if (!token || !phoneNumberId) {
            throw new Error('WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID missing');
        }
        const whatsappBody = template ? {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: recipientId,
            type: 'template',
            template: {
                name: template.name,
                language: { code: template.language || 'ru' },
                components: [{
                    type: 'body',
                    parameters: [{ type: 'text', text: message }]
                }]
            }
        } : {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: recipientId,
            type: 'text',
            text: { preview_url: false, body: message }
        };
        const response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(whatsappBody)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(`WhatsApp API ${response.status}: ${data.error?.message || 'request failed'}`);
        }
        return { ok: true, messageId: data.messages?.[0]?.id || null };
    }
    if (channel === 'local') return { ok: true, messageId: `local-${Date.now()}`, text: message };
    throw new Error(`Unsupported channel: ${channel}`);
}

export function verifyWhatsAppSignature(rawBody, signature) {
    const secret = process.env.WHATSAPP_APP_SECRET;
    if (!secret) return false;
    if (!signature || !signature.startsWith('sha256=')) return false;
    const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
    const received = Buffer.from(signature.slice(7));
    return expected.length === received.length && timingSafeEqual(expected, received);
}

export function extractWhatsAppMessages(payload) {
    const messages = [];
    for (const entry of payload?.entry || []) {
        for (const change of entry.changes || []) {
            const value = change.value || {};
            const contacts = new Map((value.contacts || []).map(c => [c.wa_id, c]));
            for (const item of value.messages || []) {
                if (item.type !== 'text' || !item.text?.body) continue;
                const contact = contacts.get(item.from);
                messages.push({
                    channel: 'whatsapp',
                    externalId: item.from,
                    name: contact?.profile?.name || '',
                    phone: item.from,
                    text: item.text.body,
                    messageId: item.id || null,
                    timestamp: item.timestamp ? new Date(Number(item.timestamp) * 1000).toISOString() : new Date().toISOString()
                });
            }
        }
    }
    return messages;
}
