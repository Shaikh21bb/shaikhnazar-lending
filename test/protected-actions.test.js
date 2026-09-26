import test from 'node:test';
import assert from 'node:assert/strict';
import analyze from '../server/api/analyze.js';
import script from '../server/api/script.js';
import connect from '../server/api/telegram/connect.js';
import send from '../server/api/telegram/send.js';
import broadcast from '../server/api/telegram/broadcast.js';
import task from '../server/api/telegram/task.js';

const actions = { analyze, script, connect, send, broadcast, task };

test('manual AI and Telegram actions reject guests before accessing secrets or data', async () => {
    const previous = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = 'test-dashboard-secret';
    try {
        for (const [name, handler] of Object.entries(actions)) {
            const res = {
                statusCode: 200,
                status(code) { this.statusCode = code; return this; },
                json(body) { this.body = body; return this; }
            };
            await handler({ method: 'POST', headers: {}, body: {} }, res);
            assert.equal(res.statusCode, 401, `${name} must require login`);
            assert.equal(res.body?.error, 'Unauthorized');
        }
    } finally {
        if (previous === undefined) delete process.env.AUTH_SECRET;
        else process.env.AUTH_SECRET = previous;
    }
});
