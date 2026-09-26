import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { extractWhatsAppMessages, verifyWhatsAppSignature } from '../server/api/_agent/providers.js';
import { isAgentEnabled, SALES_TOOLS } from '../server/api/_agent/sales.js';

test('extractWhatsAppMessages keeps supported text messages and customer identity', () => {
    const messages = extractWhatsAppMessages({
        entry: [{ changes: [{ value: {
            contacts: [{ wa_id: '77001234567', profile: { name: 'Aigul' } }],
            messages: [
                { id: 'wamid.1', from: '77001234567', timestamp: '1700000000', type: 'text', text: { body: 'Цена?' } },
                { id: 'wamid.2', from: '77001234567', type: 'image', image: { id: 'image' } }
            ]
        } }] }]
    });
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], {
        channel: 'whatsapp',
        externalId: '77001234567',
        name: 'Aigul',
        phone: '77001234567',
        text: 'Цена?',
        messageId: 'wamid.1',
        timestamp: '2023-11-14T22:13:20.000Z'
    });
});

test('WhatsApp signature validation uses the configured app secret', () => {
    const previous = process.env.WHATSAPP_APP_SECRET;
    process.env.WHATSAPP_APP_SECRET = 'test-secret';
    const raw = '{"ok":true}';
    const signature = 'sha256=' + createHmac('sha256', 'test-secret').update(raw).digest('hex');
    assert.equal(verifyWhatsAppSignature(raw, signature), true);
    assert.equal(verifyWhatsAppSignature(raw, 'sha256=bad'), false);
    if (previous === undefined) delete process.env.WHATSAPP_APP_SECRET;
    else process.env.WHATSAPP_APP_SECRET = previous;
});

test('Sales Agent switch requires both active status and ai_enabled', () => {
    assert.equal(isAgentEnabled({ status: 'active', ai_enabled: true }), true);
    assert.equal(isAgentEnabled({ status: 'active', ai_enabled: false }), false);
    assert.equal(isAgentEnabled({ status: 'paused', ai_enabled: true }), false);
});

test('Sales Agent exposes follow-up and human handoff tools', () => {
    assert.deepEqual(SALES_TOOLS.map(tool => tool.name), ['create_followup', 'handoff_to_human']);
    for (const tool of SALES_TOOLS) assert.equal(tool.parameters.additionalProperties, false);
});
