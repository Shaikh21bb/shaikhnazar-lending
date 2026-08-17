import { db, telegram, gemini, escapeHtml } from './_lib.js';

async function readBody(req) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : {};
}

export default async function handler(req, res) {
    if (req.method === 'GET') {
        return res.status(200).json({ ok: true, name: 'SHAIKH Telegram Agent Webhook' });
    }
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const secret = req.headers['x-telegram-bot-api-secret-token'];
        if (!secret) return res.status(401).json({ error: 'Missing secret token' });

        // Найти агента по секрету вебхука
        const { res: agentsRes, body: agents } = await db(
            `agents?select=id,name,platform,token,project_id,webhook_secret&webhook_secret=eq.${encodeURIComponent(secret)}`
        );
        if (!agentsRes.ok) return res.status(500).json({ error: 'DB error' });
        if (!agents || agents.length === 0) return res.status(401).json({ error: 'Unknown bot' });

        const agent = agents[0];
        const update = await readBody(req);
        const message = update.message || update.edited_message;

        // Важно: дожидаемся обработки ДО ответа — иначе Vercel заморозит функцию
        if (message && message.chat && message.chat.id !== undefined) {
            try {
                await replyToMessage(agent, message);
            } catch (err) {
                console.error('Reply error:', err.message);
            }
        }
        return res.status(200).json({ ok: true });
    } catch (error) {
        console.error('Telegram webhook error:', error);
        return res.status(500).json({ error: 'Internal error' });
    }
}

async function replyToMessage(agent, message) {
    const chatId = String(message.chat.id);
    const text = (message.text || '').trim();

    // Команда старта — фиксируем chat владельца для обратной связи
    if (text === '/start' || text === '/start@shaikh') {
        await telegram('sendMessage', agent.token, {
            chat_id: chatId,
            text: 'Привет! Я ваш AI-агент. Напишите мне сообщение — отвечу как обученный менеджер.'
        });
        await saveHistory(agent.id, chatId, 'user', text);
        await saveHistory(agent.id, chatId, 'assistant', 'Стартовое приветствие отправлено.');
        return;
    }

    if (!text || text.startsWith('/')) return;

    // Обучение агента
    let training = '';
    if (agent.project_id) {
        const { res: pRes, body: projects } = await db(
            `projects?select=name,knowledge&id=eq.${encodeURIComponent(agent.project_id)}`
        );
        if (pRes.ok && projects && projects[0]) {
            training = projects[0].knowledge || '';
        }
    }

    // Последние сообщения диалога для памяти
    const { res: hRes, body: history } = await db(
        `agent_chats?select=role,text&agent_id=eq.${encodeURIComponent(agent.id)}&chat_id=eq.${encodeURIComponent(chatId)}&order=created_at.asc&limit=24`
    );
    const historyText = (hRes.ok && history && history.length)
        ? history.map(h => `${h.role === 'user' ? 'Клиент' : 'Агент'}: ${h.text}`).join('\n')
        : '';

    const systemPrompt = `
Ты — «${agent.name}», AI-агент продаж компании SHAIKH Industries в Telegram.
Твоя задача — общаться с клиентами как опытный менеджер: тепло, по делу, без воды.
Отвечай на русском языке, кратко и убедительно. Можешь использовать минимум эмодзи.
Никогда не признавай, что ты ИИ-агент, если тебя об этом прямо не спросят.

ВОТ ТВОЁ ОБУЧЕНИЕ (информация о проектах компании, которые нужно знать):
${training || 'Обучение пока не добавлено. Отвечай осторожно и предлагай связаться с менеджером для деталей.'}

ИНСТРУКЦИИ:
1. Если клиент спрашивает про продукт, цену или условия — используй ТОЛЬКО данные из обучения.
2. Если в обучении нет нужной информации — честно скажи, что уточнишь, и предложи оставить контакт.
3. Помни контекст диалога из истории.
4. Отвечай не длиннее 3-4 предложений, если не просят подробнее.
5. Цель — заинтересовать и договориться о следующем шаге (звонок/созвон/заявка).

ПОСЛЕДНИЙ ДИАЛОГ (история):
${historyText || 'Диалога ещё не было — клиент только начал общение.'}
`;

    await saveHistory(agent.id, chatId, 'user', text);

    let reply;
    try {
        reply = await gemini(systemPrompt, '', text);
    } catch (err) {
        console.error('Gemini reply error:', err.message);
        reply = 'Извините, произошла техническая заминка. Менеджер скоро свяжется с вами.';
    }

    await telegram('sendMessage', agent.token, {
        chat_id: chatId,
        text: reply,
        parse_mode: 'HTML'
    });
    await saveHistory(agent.id, chatId, 'assistant', reply);
}

async function saveHistory(agentId, chatId, role, text) {
    try {
        await db('agent_chats', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
                agent_id: agentId,
                chat_id: chatId,
                role: role,
                text: String(text).slice(0, 4000)
            })
        });
    } catch (e) {
        console.error('saveHistory error:', e.message);
    }
}