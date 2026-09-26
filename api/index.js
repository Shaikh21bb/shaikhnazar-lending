import analyze from '../server/api/analyze.js';
import adminAccounts from '../server/api/admin/accounts.js';
import login from '../server/api/auth/login.js';
import logout from '../server/api/auth/logout.js';
import session from '../server/api/auth/session.js';
import customerState from '../server/api/customers/state.js';
import followupsRun from '../server/api/followups/run.js';
import messagesSend from '../server/api/messages/send.js';
import salesSimulate from '../server/api/sales/simulate.js';
import script from '../server/api/script.js';
import tasksDigest from '../server/api/tasks/digest.js';
import tasksRemind from '../server/api/tasks/remind.js';
import telegram from '../server/api/telegram.js';
import telegramBroadcast from '../server/api/telegram/broadcast.js';
import telegramConnect from '../server/api/telegram/connect.js';
import telegramSend from '../server/api/telegram/send.js';
import telegramTask from '../server/api/telegram/task.js';
import whatsapp from '../server/api/webhooks/whatsapp.js';
import whatsappBridge from '../server/api/whatsapp/bridge.js';

// Hobby permits at most 12 Functions per deployment. Keep route handlers as
// ordinary modules and expose one Function without changing public API URLs.
export const config = { api: { bodyParser: false } };

const routes = new Map([
    ['admin/accounts', adminAccounts],
    ['analyze', analyze],
    ['auth/login', login],
    ['auth/logout', logout],
    ['auth/session', session],
    ['customers/state', customerState],
    ['followups/run', followupsRun],
    ['messages/send', messagesSend],
    ['sales/simulate', salesSimulate],
    ['script', script],
    ['tasks/digest', tasksDigest],
    ['tasks/remind', tasksRemind],
    ['telegram', telegram],
    ['telegram/broadcast', telegramBroadcast],
    ['telegram/connect', telegramConnect],
    ['telegram/send', telegramSend],
    ['telegram/task', telegramTask],
    ['webhooks/whatsapp', whatsapp],
    ['whatsapp/bridge', whatsappBridge]
]);

function routeFor(req) {
    const rewritten = req.query?.route;
    if (Array.isArray(rewritten)) return rewritten.join('/');
    if (typeof rewritten === 'string') return rewritten.replace(/^\/+|\/+$/g, '');
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    return pathname.startsWith('/api/') ? pathname.slice(5).replace(/\/+$/g, '') : '';
}

export default async function handler(req, res) {
    const route = routeFor(req);
    const routeHandler = routes.get(route);
    if (!routeHandler) return res.status(404).json({ error: 'Not found' });

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
            if (typeof req.body === 'undefined') {
                const chunks = [];
                for await (const chunk of req) chunks.push(Buffer.from(chunk));
                req.rawBody = Buffer.concat(chunks).toString('utf8');
                req.body = req.rawBody ? JSON.parse(req.rawBody) : {};
            }
        } catch (_) {
            return res.status(400).json({ error: 'Invalid JSON' });
        }
    }
    return routeHandler(req, res);
}
