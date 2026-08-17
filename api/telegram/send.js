import { db, telegram, escapeHtml } from '../_lib.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { id, chatId, text } = await new Promise(resolve => {
            let raw = '';
            req.on('data', c => raw += c);
            req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
        });

        if (!id || !chatId || !text) {
            return res.status(400).json({ error: 'Missing id, chatId or text' });
        }

        const { res: aRes, body: agents } = await db(`agents?select=id,token,name&id=eq.${encodeURIComponent(id)}`);
        if (!aRes.ok || !agents || agents.length === 0) {
            return res.status(404).json({ error: 'Agent not found' });
        }
        const agent = agents[0];

        await telegram('sendMessage', agent.token, {
            chat_id: chatId,
            text: String(text).slice(0, 4000)
        });

        await db('agent_chats', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
                agent_id: agent.id,
                chat_id: String(chatId),
                role: 'assistant',
                text: String(text).slice(0, 4000)
            })
        });

        return res.status(200).json({ ok: true });
    } catch (error) {
        console.error('Send telegram error:', error);
        return res.status(500).json({ error: error.message });
    }
}