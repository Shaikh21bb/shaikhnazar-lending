import test from 'node:test';
import assert from 'node:assert/strict';
import bridge from '../server/api/whatsapp/bridge.js';
import { isAgentEnabled } from '../server/api/_agent/sales.js';

function response() {
    return {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; }
    };
}

test('QR bridge remains unavailable without server configuration', async () => {
    const previous = process.env.WHATSAPP_DELIVERY_MODE;
    delete process.env.WHATSAPP_DELIVERY_MODE;
    try {
        const res = response();
        await bridge({ method: 'GET', headers: {}, query: {} }, res);
        assert.equal(res.statusCode, 503);
    } finally {
        if (previous === undefined) delete process.env.WHATSAPP_DELIVERY_MODE;
        else process.env.WHATSAPP_DELIVERY_MODE = previous;
    }
});

test('QR bridge requires a worker secret and protects the QR from guests', async () => {
    const previous = {
        mode: process.env.WHATSAPP_DELIVERY_MODE,
        secret: process.env.WHATSAPP_BRIDGE_SECRET,
        auth: process.env.AUTH_SECRET
    };
    process.env.WHATSAPP_DELIVERY_MODE = 'qr';
    process.env.AUTH_SECRET = 'test-dashboard-secret';
    try {
        delete process.env.WHATSAPP_BRIDGE_SECRET;
        const missing = response();
        await bridge({ method: 'POST', headers: {}, body: {} }, missing);
        assert.equal(missing.statusCode, 503);

        process.env.WHATSAPP_BRIDGE_SECRET = 'test-bridge-secret';
        const invalid = response();
        await bridge({ method: 'POST', headers: { 'x-whatsapp-bridge-secret': 'wrong' }, body: {} }, invalid);
        assert.equal(invalid.statusCode, 401);

        const guest = response();
        await bridge({ method: 'GET', headers: {}, query: { agentId: '00000000-0000-0000-0000-000000000000' } }, guest);
        assert.equal(guest.statusCode, 401);

        const malformed = response();
        await bridge({ method: 'POST', headers: { 'x-whatsapp-bridge-secret': 'test-bridge-secret' }, body: { agentId: 'bad' } }, malformed);
        assert.equal(malformed.statusCode, 400);
    } finally {
        for (const [name, value] of [
            ['WHATSAPP_DELIVERY_MODE', previous.mode],
            ['WHATSAPP_BRIDGE_SECRET', previous.secret],
            ['AUTH_SECRET', previous.auth]
        ]) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test('QR Sales Agent will not answer before connection and training', () => {
    const previous = process.env.WHATSAPP_DELIVERY_MODE;
    process.env.WHATSAPP_DELIVERY_MODE = 'qr';
    try {
        const ready = { platform: 'whatsapp', status: 'active', ai_enabled: true, connected: true, project_id: 'trained' };
        assert.equal(isAgentEnabled(ready), true);
        assert.equal(isAgentEnabled({ ...ready, connected: false }), false);
        assert.equal(isAgentEnabled({ ...ready, project_id: null }), false);
    } finally {
        if (previous === undefined) delete process.env.WHATSAPP_DELIVERY_MODE;
        else process.env.WHATSAPP_DELIVERY_MODE = previous;
    }
});
