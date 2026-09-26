import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import router from '../api/index.js';

function request({ method = 'GET', route, body = '', query = {}, headers = {} }) {
    return Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
        method,
        url: `/api/${route}`,
        query: { route, ...query },
        headers
    });
}

function response() {
    return {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; },
        send(value) { this.body = value; return this; }
    };
}

test('one function keeps the existing Telegram health endpoint', async () => {
    const res = response();
    await router(request({ route: 'telegram' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
});

test('one function preserves the raw WhatsApp webhook signature', async () => {
    process.env.WHATSAPP_APP_SECRET = 'test-app-secret';
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const signature = createHmac('sha256', process.env.WHATSAPP_APP_SECRET).update(body).digest('hex');
    const res = response();
    await router(request({
        method: 'POST',
        route: 'webhooks/whatsapp',
        body,
        headers: { 'x-hub-signature-256': `sha256=${signature}` }
    }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, accepted: 0 });
});

test('one function rejects unknown routes and malformed JSON', async () => {
    const unknown = response();
    await router(request({ route: 'not-a-route' }), unknown);
    assert.equal(unknown.statusCode, 404);

    const malformed = response();
    await router(request({ method: 'POST', route: 'script', body: '{bad' }), malformed);
    assert.equal(malformed.statusCode, 400);
});
