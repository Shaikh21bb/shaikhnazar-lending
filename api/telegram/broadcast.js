import { db, telegram } from '../_lib.js';

async function readBody(req) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : {};
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { id, text } = await readBody(req);
        if (!id) return res.status(400).json({ error: 'Missing agent id' });
        if (!text || !text.trim()) return res.status(400).json({ error: 'Missing text' });

        const { res: aRes, body: agents } = await db(`agents?select=id,name,token&id=eq.${encodeURIComponent(id)}`);
        if (!aRes.ok || !agents || agents.length === 0) {
            return res.status(404).json({ error: 'Agent not found' });
        }
        const agent = agents[0];
        if (!agent.token) return res.status(400).json({ error: 'Agent has no bot token' });

        const { res: cRes, body: chats } = await db(
            `agent_chats?select=chat_id&agent_id=eq.${encodeURIComponent(agent.id)}`
        );
        if (!cRes.ok || !chats || chats.length === 0) {
            return res.status(200).json({ ok: true, total: 0, sent: 0, failed: 0 });
        }

        const recipients = [...new Set(chats.map(c => c.chat_id))];
        let sent = 0;
        let failed = 0;

        for (const chatId of recipients) {
            try {
                await telegram('sendMessage', agent.token, {
                    chat_id: chatId,
                    text: String(text).slice(0, 4000)
                });
                sent++;
            } catch (e) {
                console.error('Broadcast send error to', chatId, e.message);
                failed++;
            }
            await sleep(100);
        }

        return res.status(200).json({ ok: true, total: recipients.length, sent, failed });
    } catch (error) {
        console.error('Broadcast error:', error);
        return res.status(500).json({ error: error.message });
    }
}