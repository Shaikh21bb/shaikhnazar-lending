import { timingSafeEqual } from 'node:crypto';
import { db, telegram, escapeHtml, readJsonBody } from './_lib.js';
import { runReminders } from './tasks/remind.js';
import { handleSalesInbound } from './_agent/sales.js';
import { enqueueTelegramThought } from './_agent/workspace.js';
import {
    findPersonalAgentByWebhookSecret,
    linkPersonalTelegramOwner,
    personalTelegramToken,
    telegramWebhookSecretHash
} from './_agent/personal.js';

function retryableWebhookError(message, cause = null) {
    const error = Object.assign(new Error(message), { status: 503, retryWebhook: true });
    if (cause) error.cause = cause;
    return error;
}

function telegramDeadlineOptions(deadlineAt, cap = 12_000) {
    const remaining = Number(deadlineAt) - Date.now() - 1_500;
    if (remaining < 1_000) throw retryableWebhookError('Telegram webhook deadline reached');
    return { timeoutMs: Math.max(1_000, Math.min(cap, remaining)) };
}

function sameHash(left, right) {
    const a = Buffer.from(String(left || ''), 'utf8');
    const b = Buffer.from(String(right || ''), 'utf8');
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
    if (req.method === 'GET') {
        return res.status(200).json({ ok: true, name: 'SHAIKH Telegram Agent Webhook' });
    }
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const deadlineAt = Date.now() + 42_000;
        const secret = req.headers['x-telegram-bot-api-secret-token'];
        if (typeof secret !== 'string' || !secret || secret.length > 255) {
            return res.status(401).json({ error: 'Missing secret token' });
        }

        // Personal secrets are checked first and only their one-way hash is
        // sent to PostgREST. The incoming bearer value never enters a URL.
        const personalAgent = await findPersonalAgentByWebhookSecret(secret);
        if (personalAgent) {
            const update = await readJsonBody(req);
            const message = update.message || update.edited_message;
            if (message?.chat?.id !== undefined) {
                try {
                    await replyToPersonalAgent(personalAgent, message, deadlineAt);
                } catch (err) {
                    console.error('Personal Telegram reply error:', err.message);
                    if (err.retryWebhook || !err.status || Number(err.status) >= 500) {
                        return res.status(503).json({ error: 'Retry later' });
                    }
                    try {
                        const token = await personalTelegramToken(personalAgent);
                        await telegram('sendMessage', token, {
                            chat_id: String(message.chat.id),
                            text: err.status && err.status < 500
                                ? err.message
                                : 'Сейчас не получилось выполнить команду. Попробуйте ещё раз.'
                        }, telegramDeadlineOptions(deadlineAt));
                    } catch (sendError) {
                        console.error('Personal Telegram error reply failed:', sendError.message);
                        return res.status(503).json({ error: 'Retry later' });
                    }
                }
            }
            return res.status(200).json({ ok: true });
        }

        const secretHash = telegramWebhookSecretHash(secret);
        let { res: agentsRes, body: agents } = await db(
            `agents?select=*&webhook_secret_hash=eq.${encodeURIComponent(secretHash)}&connected=eq.true&limit=1`
        );
        // Zero-downtime bridge for the deploy-before-migration window. It
        // never places the incoming bearer in a URL and disappears naturally
        // once webhook_secret_hash exists and the migration clears plaintext.
        if (!agentsRes.ok && agentsRes.status === 400) {
            const legacy = await db('agents?select=*&platform=eq.telegram&connected=eq.true');
            agentsRes = legacy.res;
            agents = (legacy.body || []).filter(agent => {
                const storedHash = agent.webhook_secret_hash
                    || (agent.webhook_secret ? telegramWebhookSecretHash(agent.webhook_secret) : '');
                return sameHash(storedHash, secretHash);
            }).slice(0, 1);
        }
        if (!agentsRes.ok) return res.status(500).json({ error: 'DB error' });
        if (!agents || agents.length === 0) return res.status(401).json({ error: 'Unknown bot' });

        const agent = agents[0];
        const update = await readJsonBody(req);

        // Нажатие кнопки в задаче
        if (update.callback_query) {
            try {
                await handleCallback(agent, update.callback_query);
            } catch (err) {
                console.error('Callback error:', err.message);
            }
            return res.status(200).json({ ok: true });
        }

        const message = update.message || update.edited_message;

        // Важно: дожидаемся обработки ДО ответа — иначе Vercel заморозит функцию
        if (message && message.chat && message.chat.id !== undefined) {
            try {
                await replyToMessage(agent, message);
            } catch (err) {
                console.error('Reply error:', err.message);
            }
        }
        // Фоновая проверка напоминаний по задачам (throttle внутри)
        try {
            await runReminders(false);
        } catch (err) {
            console.error('Reminders scan error:', err.message);
        }
        return res.status(200).json({ ok: true });
    } catch (error) {
        console.error('Telegram webhook error:', error);
        return res.status(500).json({ error: 'Internal error' });
    }
}

export async function replyToPersonalAgent(agent, message, deadlineAt = Date.now() + 42_000) {
    const token = await personalTelegramToken(agent);
    const chatId = String(message.chat.id);
    const userId = String(message.from?.id || '');
    const text = String(message.text || '').trim();
    if (!text) return;

    if (message.chat.type !== 'private' || !userId) {
        await telegram('sendMessage', token, {
            chat_id: chatId,
            text: 'Личный Agent Hub работает только в приватном чате с ботом. Откройте бота напрямую и используйте персональную ссылку привязки.'
        }, telegramDeadlineOptions(deadlineAt));
        return;
    }

    const command = text.match(/^\/(?:start|link)(?:@[A-Za-z0-9_]+)?(?:\s+([A-Za-z0-9_-]+))?$/i);
    if (command) {
        const code = command[1];
        if (code) {
            const alreadyLinked = String(agent.telegram_owner_chat_id || '') === chatId
                && String(agent.telegram_owner_user_id || '') === userId;
            if (!alreadyLinked) await linkPersonalTelegramOwner(agent, code, chatId, userId);
            await telegram('sendMessage', token, {
                chat_id: chatId,
                text: alreadyLinked
                    ? 'Telegram уже привязан к вашему Agent Hub.'
                    : 'Telegram привязан. Пишите сюда: личный агент на Mac ответит с учётом вашей базы Obsidian. База и её анализ остаются на Mac; ответы приходят в этот чат. Команды — /help.'
            }, telegramDeadlineOptions(deadlineAt));
            return;
        }
        const textReply = agent.telegram_owner_chat_id === chatId && agent.telegram_owner_user_id === userId
            ? `Привет! Я ${agent.name}. Пишите сюда — локальный агент на Mac ответит с учётом Obsidian. Для отдельной заметки используйте /note, для вопроса — /ask. Если Mac выключен, зашифрованное сообщение подождёт. База и её анализ остаются на Mac; ответы приходят в этот чат. Все команды — /help.`
            : 'Откройте «Подключения» в Agent Hub и используйте персональную ссылку привязки.';
        await telegram('sendMessage', token, { chat_id: chatId, text: textReply }, telegramDeadlineOptions(deadlineAt));
        return;
    }

    if (!agent.telegram_owner_chat_id || !agent.telegram_owner_user_id) {
        await telegram('sendMessage', token, {
            chat_id: chatId,
            text: 'Сначала привяжите этот чат через персональную ссылку в Agent Hub → Подключения.'
        }, telegramDeadlineOptions(deadlineAt));
        return;
    }
    if (String(agent.telegram_owner_chat_id) !== chatId || String(agent.telegram_owner_user_id) !== userId) {
        await telegram('sendMessage', token, {
            chat_id: chatId,
            text: 'Этот бот уже привязан к другому личному кабинету.'
        }, telegramDeadlineOptions(deadlineAt));
        return;
    }

    if (/^\/help(?:@[A-Za-z0-9_]+)?$/i.test(text)) {
        await telegram('sendMessage', token, {
            chat_id: chatId,
            text: 'Пишите обычным сообщением — личный агент ответит с учётом Obsidian.\n/ask вопрос — спросить по базе\n/note мысль — сохранить отдельную заметку\n/when идентификатор дата и время — уточнить срок задачи\n/new — начать новый диалог на Mac\n/help — команды\n\nБаза, анализ и история диалога хранятся на Mac. Ответы приходят в этот личный чат. Если Mac выключен, сообщения ждут в зашифрованной очереди.'
        }, telegramDeadlineOptions(deadlineAt));
        return;
    }

    // This authenticated personal channel is local-only. Never fall through to
    // the old cloud note/chat handler, even while no Mac is paired or online.
    const queued = await enqueueTelegramThought(agent, text, {
        externalMessageId: message.message_id ? String(message.message_id) : null,
        telegramMessageId: message.message_id,
        userId
    });
    await telegram('sendMessage', token, {
        chat_id: chatId,
        text: queued.queued
            ? !queued.dialogueEnabled
                ? 'Мысль добавлена в зашифрованную очередь для Mac. Когда он будет включён, агент сохранит и оформит её в Obsidian.'
                : queued.intent === 'thought'
                    ? 'Мысль добавлена в зашифрованную очередь для Mac. Локальный агент сохранит её в Obsidian и ответит здесь.'
                    : 'Сообщение добавлено в зашифрованную очередь для Mac. Локальный агент обработает его и ответит здесь.'
            : 'Сначала подключи Mac в личном кабинете → «Мой агент» → «Мой Mac». До подключения мысль не отправляется облачной AI-модели.'
    }, telegramDeadlineOptions(deadlineAt));
}

const STATUS_LABEL = { pending: '⏳ Запланировано', confirmed: '✅ Подтверждено', done: '🎉 Выполнено' };

async function handleCallback(agent, callback) {
    const data = callback.data || '';
    const m = data.match(/^task:(confirm|done):([0-9a-f-]+)$/i);
    if (!m) return;

    const action = m[1].toLowerCase();
    const taskId = m[2];
    const status = action === 'confirm' ? 'confirmed' : 'done';
    const callbackChatId = String(callback.message?.chat?.id ?? '');
    if (!callbackChatId) return;

    const taskScope = `id=eq.${encodeURIComponent(taskId)}&agent_id=eq.${encodeURIComponent(agent.id)}&chat_id=eq.${encodeURIComponent(callbackChatId)}`;
    const { res: tRes, body: tasks } = await db(`tasks?select=id,title&${taskScope}`);
    const task = tasks && tasks[0];

    if (tRes.ok && task) {
        await db(`tasks?${taskScope}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: status })
        });
    }

    const label = action === 'confirm' ? '✅ Задача подтверждена!' : '🎉 Отлично! Задача выполнена.';
    const text = task
        ? `${label}\n📌 ${escapeHtml(task.title)}`
        : label;

    await telegram('answerCallbackQuery', agent.token, {
        callback_query_id: callback.id,
        text: label
    });
    await telegram('sendMessage', agent.token, {
        chat_id: callback.message.chat.id,
        text: text,
        parse_mode: 'HTML'
    });
}

async function replyToMessage(agent, message) {
    const chatId = String(message.chat.id);
    const text = (message.text || '').trim();

    // Команда старта — фиксируем chat владельца для обратной связи
    if (text === '/start' || text === '/start@shaikh') {
        const greeting = agent.language === 'kk'
            ? 'Сәлеметсіз бе! Мен сіздердің AI-менеджерімізбін. Сұрағыңызды жазыңыз — оқыған менеджердей тез әрі дұрыс жауап беремін.'
            : 'Привет! Я ваш AI-агент. Напишите мне сообщение — отвечу как обученный менеджер.';
        await telegram('sendMessage', agent.token, {
            chat_id: chatId,
            text: greeting,
            parse_mode: 'HTML'
        });
        await saveHistory(agent.id, chatId, 'user', text);
        await saveHistory(agent.id, chatId, 'assistant', 'Стартовое приветствие отправлено.');
        return;
    }

    if (!text || text.startsWith('/')) return;

    // Индикатор «печатает…», чтобы ответ не выглядел мгновенным
    try {
        await telegram('sendChatAction', agent.token, { chat_id: chatId, action: 'typing' });
    } catch (e) { console.error('sendChatAction error:', e.message); }

    await handleSalesInbound({
        agent,
        inbound: {
            channel: 'telegram',
            externalId: chatId,
            name: [message.chat.first_name, message.chat.last_name].filter(Boolean).join(' '),
            text,
            messageId: message.message_id ? String(message.message_id) : null,
            timestamp: message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString()
        }
    });
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
