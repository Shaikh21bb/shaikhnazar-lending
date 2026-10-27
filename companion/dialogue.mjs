import path from 'node:path';
import { createHash } from 'node:crypto';
import { splitTelegramReply } from './telegram.mjs';

const keyFor = payload => /^[a-f0-9]{64}$/u.test(payload?.conversationKey || '') ? payload.conversationKey : null;
const archiveId = value => createHash('sha256').update(String(value)).digest('hex');
const dateReply = text => !String(text).includes('?') && String(text).length <= 200
    && /^(?:(?:давай|поставь|напомни|перенеси)\s+)?(?:сегодня|завтра|послезавтра|\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2}|(?:в\s+)?\d{1,2}:\d{2})(?=$|[\s,.])/iu.test(String(text).trim());

export class LocalDialogueRuntime {
    constructor(runtime, { writePrivateJSON, delivery }) {
        this.runtime = runtime;
        this.write = writePrivateJSON;
        this.delivery = delivery;
    }

    initialize() {
        this.runtime.journal.conversations ||= {};
        for (const record of Object.values(this.runtime.journal.jobs)) {
            for (const chunk of record.dialogue?.outbox || []) {
                if (chunk.status === 'dispatching') chunk.status = 'uncertain';
            }
        }
    }

    conversation(key) {
        return this.runtime.journal.conversations[key] ||= { epoch: 0, history: [], sources: [] };
    }

    async remember(job, record, answer, sources = []) {
        const key = record.conversationKey;
        const conversation = this.conversation(key);
        if (record.dialogueEpoch !== conversation.epoch) return;
        if (conversation.history.some(turn => turn.jobId === job.id)) return;
        const messages = [
            { role: 'user', content: record.clarificationText || record.thought || '', jobId: job.id },
            { role: 'assistant', content: answer, jobId: job.id },
        ];
        await this.write(path.join(this.runtime.stateDirectory, 'dialogue', key, `${archiveId(job.id)}.json`), {
            epoch: conversation.epoch, createdAt: job.created_at || record.thoughtAt, messages, sources,
        });
        conversation.history.push(...messages);
        conversation.history = conversation.history.slice(-40);
        while (conversation.history.reduce((count, turn) => count + turn.content.length, 0) > 60000) conversation.history.splice(0, 2);
        if (sources.length) conversation.sources = sources.slice(0, 6);
    }

    async queueReply(job, record, answer, sources = []) {
        if (record.dialogue) return;
        const footer = sources.length ? `\n\nИсточники Obsidian:\n${sources.map(source => `• ${source}`).join('\n')}` : '';
        record.dialogue = {
            conversationKey: record.conversationKey, replyToMessageId: record.telegramMessageId,
            response: answer, sources,
            outbox: splitTelegramReply(`${answer}${footer}`).map(text => ({ text, status: 'pending' })),
        };
        await this.remember(job, record, answer, sources);
    }

    async finishNote(job, record) {
        if (!this.runtime.telegramDialogueEnabled || !record.conversationKey || record.pending || record.dialogueCancelled) return;
        const conversation = this.conversation(record.conversationKey);
        if (record.dialogueEpoch !== conversation.epoch) return;
        const parts = [`Сохранил в Obsidian: ${record.note.title}.`];
        if (record.tasks?.length) {
            const dateFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
            parts.push(`Напоминание: ${record.tasks.map(task => dateFormat.format(new Date(task.notifyAt))).join('; ')} — Алматы.`);
        }
        if (record.clarification?.length) {
            conversation.awaiting = job.id;
            parts.push(`${record.clarification[0].question}\nМожно ответить обычным сообщением, например «Завтра в 12:00», или /when ${job.id} дата и время.`);
        } else if (record.relatedJobId === conversation.awaiting) conversation.awaiting = null;
        await this.queueReply(job, record, parts.join('\n\n'), [record.note.path]);
    }

    async reset(job, payload, record) {
        const conversation = this.conversation(record.conversationKey);
        await this.write(path.join(this.runtime.stateDirectory, 'dialogue', record.conversationKey, `reset-${archiveId(job.id)}.json`), conversation);
        conversation.epoch++;
        conversation.history = [];
        conversation.sources = [];
        conversation.awaiting = null;
        for (const previous of Object.values(this.runtime.journal.jobs)) {
            if (previous.conversationKey !== record.conversationKey) continue;
            if (previous.pendingDialogue) { previous.pendingDialogue = false; previous.dialogueCancelled = true; }
            for (const chunk of previous.dialogue?.outbox || []) {
                if (['pending', 'retry'].includes(chunk.status)) chunk.status = 'cancelled';
            }
        }
        record.dialogueEpoch = conversation.epoch;
        await this.queueReply(job, record, 'Начал новый диалог. Заметки Obsidian сохранены.');
        return { record, result: { message: 'Контекст диалога обновлён на Mac.' }, reminders: [] };
    }

    async process(job, payload, modelReady, existing = null) {
        const key = keyFor(payload);
        if (!key) throw new Error('Не удалось проверить локальный диалог.');
        const conversation = this.conversation(key);
        let record = existing || {
            thought: String(payload.text || '').trim(), thoughtAt: job.created_at || this.runtime.now().toISOString(),
            source: 'telegram_thought', conversationKey: key, dialogueEpoch: conversation.epoch,
            telegramMessageId: payload.telegramMessageId, dialogueMode: payload.mode || 'auto',
            completedAt: this.runtime.now().toISOString(),
        };
        if (payload.mode === 'reset') return this.reset(job, payload, record);
        if (!record.thought || record.thought.length > 20000) throw new Error('Сообщение диалога пустое или слишком длинное.');
        if (record.dialogueEpoch !== conversation.epoch) {
            record.pendingDialogue = false; record.dialogueCancelled = true;
            return { record, result: { message: 'Сообщение относится к предыдущему диалогу.' }, reminders: [] };
        }
        // Questions wait locally for a model; they never enter the note fallback.
        const entries = Object.entries(this.runtime.journal.jobs);
        const ownIndex = entries.findIndex(([id]) => id === job.id);
        const position = ownIndex < 0 ? entries.length : ownIndex;
        const earlierPending = entries.some(([id, previous], index) => id !== job.id
            && previous.pendingDialogue && previous.conversationKey === key && previous.dialogueEpoch === conversation.epoch
            && (Date.parse(previous.thoughtAt) < Date.parse(record.thoughtAt)
                || (Date.parse(previous.thoughtAt) === Date.parse(record.thoughtAt) && index < position)));
        if (!modelReady || earlierPending) {
            record.pendingDialogue = true;
            return { record, result: { message: 'Диалог ожидает локальную модель на Mac.' }, reminders: [] };
        }
        try {
            const relatedJobId = payload.mode !== 'ask' && dateReply(record.thought) ? conversation.awaiting : null;
            if (relatedJobId && this.runtime.journal.jobs[relatedJobId]?.note) {
                const processed = await this.runtime.processThought(job, { ...payload, intent: 'clarify', relatedJobId }, true);
                record = { ...processed.record, conversationKey: key, dialogueEpoch: conversation.epoch,
                    telegramMessageId: payload.telegramMessageId, relatedJobId };
                await this.finishNote(job, record);
                return { ...processed, record };
            }
            const related = await this.runtime.vault.search(record.thought, { history: conversation.history, sourcePaths: conversation.sources });
            const decision = await this.runtime.model.converse(record.thought, related, {
                history: conversation.history, mode: payload.mode === 'ask' ? 'answer' : 'auto',
            });
            if (decision.action === 'save' && payload.mode !== 'ask') {
                const processed = await this.runtime.processThought(job, { ...payload, intent: 'thought' }, true);
                record = { ...processed.record, conversationKey: key, dialogueEpoch: conversation.epoch,
                    telegramMessageId: payload.telegramMessageId };
                await this.finishNote(job, record);
                return { ...processed, record };
            }
            const allowed = new Set(related.map(note => note.path));
            const sources = [...new Set((decision.sources || []).filter(source => allowed.has(source)))].slice(0, 6);
            const answer = String(decision.answer || '').trim().slice(0, 8000) || 'Уточни, пожалуйста, вопрос. В режиме /ask заметки не создаются.';
            record.pendingDialogue = false;
            await this.queueReply(job, record, answer, sources);
            return { record, result: { message: 'Ответ подготовлен локально на Mac.' }, reminders: [] };
        } catch {
            record.pendingDialogue = true;
            record.retryDialogueAt = new Date(this.runtime.now().getTime() + 60000).toISOString();
            return { record, result: { message: 'Диалог ожидает локальную обработку на Mac.' }, reminders: [] };
        }
    }

    async retry(modelReady) {
        if (!modelReady || !this.runtime.telegramDialogueEnabled) return;
        const pending = Object.entries(this.runtime.journal.jobs).filter(([, record]) => record.pendingDialogue)
            .sort((a, b) => Date.parse(a[1].thoughtAt) - Date.parse(b[1].thoughtAt));
        for (const [id, record] of pending) {
            if (record.retryDialogueAt && new Date(record.retryDialogueAt) > this.runtime.now()) break;
            const processed = await this.process({ id, created_at: record.thoughtAt }, {
                text: record.thought, mode: record.dialogueMode, conversationKey: record.conversationKey,
                telegramMessageId: record.telegramMessageId,
            }, true, record);
            this.runtime.journal.jobs[id] = processed.record;
            processed.record.result = processed.result;
            if (processed.record.note) processed.record.syncPending = {
                action: 'sync_reminders', jobId: id, reminders: processed.reminders,
                needsClarification: Boolean(processed.record.clarification?.length),
            };
            await this.runtime.persist();
            if (processed.record.pendingDialogue) break;
        }
    }

    async flush() {
        if (!this.runtime.telegramDialogueEnabled) return;
        const blocked = new Set();
        for (const [id, record] of Object.entries(this.runtime.journal.jobs)) {
            const reply = record.dialogue;
            if (!reply?.outbox?.length) continue;
            if (blocked.has(record.conversationKey)) continue;
            if (record.dialogueEpoch !== this.conversation(record.conversationKey).epoch) continue;
            for (const chunk of reply.outbox) {
                if (chunk.status === 'sent') continue;
                if (!['pending', 'retry'].includes(chunk.status)) break;
                if (chunk.retryAt && new Date(chunk.retryAt) > this.runtime.now()) { blocked.add(record.conversationKey); break; }
                chunk.status = 'dispatching';
                await this.runtime.persist();
                let result;
                try { result = await this.delivery.sendChunk(chunk.text, { conversationKey: reply.conversationKey, jobId: id, replyToMessageId: reply.replyToMessageId }); }
                catch { result = { status: 'uncertain' }; }
                chunk.status = ['sent', 'retry', 'cancelled', 'uncertain'].includes(result.status) ? result.status : 'uncertain';
                if (chunk.status === 'sent') { chunk.messageId = result.messageId; chunk.sentAt = this.runtime.now().toISOString(); delete chunk.retryAt; }
                if (chunk.status === 'retry') chunk.retryAt = new Date(this.runtime.now().getTime() + Math.max(30, Number(result.retryAfter) || 60) * 1000).toISOString();
                if (chunk.status === 'retry') blocked.add(record.conversationKey);
                if (['uncertain', 'cancelled'].includes(chunk.status)) {
                    for (const later of reply.outbox.slice(reply.outbox.indexOf(chunk) + 1)) {
                        if (['pending', 'retry'].includes(later.status)) later.status = 'cancelled';
                    }
                }
                await this.runtime.persist();
                if (chunk.status !== 'sent') break;
            }
        }
    }
}
