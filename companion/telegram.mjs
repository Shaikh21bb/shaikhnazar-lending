import { decryptEnvelope } from '../lib/private-envelope.mjs';

export const TELEGRAM_COMMANDS = [
    { command: 'help', description: 'Как разговаривать с локальным агентом' },
    { command: 'ask', description: 'Задать вопрос без создания заметки' },
    { command: 'note', description: 'Сохранить мысль в Obsidian' },
    { command: 'new', description: 'Начать новый диалог, сохранив заметки' },
    { command: 'when', description: 'Уточнить срок задачи' },
];

export function splitTelegramReply(value, limit = 3500) {
    let remaining = String(value || '').trim().slice(0, 12000);
    const chunks = [];
    while (remaining) {
        let end = Math.min(limit, remaining.length);
        if (end < remaining.length) {
            const paragraph = remaining.lastIndexOf('\n', end);
            const space = remaining.lastIndexOf(' ', end);
            if (paragraph > limit / 2) end = paragraph;
            else if (space > limit / 2) end = space;
            if (/[\uD800-\uDBFF]/u.test(remaining[end - 1])) end--;
        }
        chunks.push(remaining.slice(0, end).trim());
        remaining = remaining.slice(end).trimStart();
    }
    return chunks;
}

// Credentials are decrypted only in memory, immediately before each attempt.
// Neither a generated answer nor a vault excerpt goes through the platform API.
export class TelegramOwnerDelivery {
    constructor({ privateKey, request, fetchImpl = fetch } = {}) {
        this.privateKey = privateKey;
        this.request = request;
        this.fetch = fetchImpl;
    }

    async credentials({ conversationKey, jobId } = {}) {
        const response = await this.request({ action: 'telegram_credentials', ...(jobId ? { jobId } : {}) });
        const value = await decryptEnvelope(this.privateKey, response.telegramEnvelope);
        if (!value || !/^\d{5,}:[A-Za-z0-9_-]{25,}$/u.test(value.token || '')
            || !/^\d{1,20}$/u.test(String(value.chatId || ''))
            || String(value.chatId) !== String(value.ownerUserId)
            || !/^[a-f0-9]{64}$/u.test(value.conversationKey || '')) {
            throw new Error('Не удалось проверить личный Telegram.');
        }
        if (conversationKey && value.conversationKey !== conversationKey) return null;
        return value;
    }

    async sendChunk(text, options = {}) {
        let credentials;
        try { credentials = await this.credentials(options); }
        catch { return { status: 'retry', retryAfter: 60 }; }
        if (!credentials) return { status: 'cancelled' };
        const body = {
            chat_id: String(credentials.chatId), text: String(text),
            link_preview_options: { is_disabled: true },
            ...(Number.isSafeInteger(options.replyToMessageId) && options.replyToMessageId > 0
                ? { reply_parameters: { message_id: options.replyToMessageId, allow_sending_without_reply: true } } : {}),
        };
        try {
            const response = await this.fetch(`https://api.telegram.org/bot${credentials.token}/sendMessage`, {
                method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
            });
            const result = await response.json();
            if (response.ok && result.ok === true && Number.isSafeInteger(result.result?.message_id)) {
                return { status: 'sent', messageId: result.result.message_id };
            }
            // An explicit rejection did not create a message. A server failure or
            // lost response may have done so, and must never be retried blindly.
            if (response.status === 429 && result.ok === false) {
                const retryAfter = Number(result.parameters?.retry_after);
                return { status: 'retry', retryAfter: Math.max(30, Math.min(3600, Number.isFinite(retryAfter) ? retryAfter : 60)) };
            }
            if (response.status >= 400 && response.status < 500 && result.ok === false) return { status: 'cancelled' };
        } catch { /* A fetch exception may contain the bot URL; never propagate it. */ }
        return { status: 'uncertain' };
    }

    async configureCommands() {
        const credentials = await this.credentials();
        if (!credentials) return false;
        try {
            const response = await this.fetch(`https://api.telegram.org/bot${credentials.token}/setMyCommands`, {
                method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ commands: TELEGRAM_COMMANDS, scope: { type: 'chat', chat_id: String(credentials.chatId) } }),
                signal: AbortSignal.timeout(15_000),
            });
            return response.ok && (await response.json()).ok === true;
        } catch { return false; }
    }
}
