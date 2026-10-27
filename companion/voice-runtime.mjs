import { VoiceError, validateVoice } from './voice.mjs';

const failureText = code => code === 'no_speech'
    ? 'Не удалось разобрать речь в голосовом. Попробуй записать ещё раз поближе к микрофону или напиши текстом.'
    : ['voice_limit', 'duration_limit'].includes(code)
        ? 'Голосовое слишком длинное или большое. Отправь запись до 10 минут и 19 МБ.'
        : 'Не удалось распознать это голосовое на Mac. Попробуй отправить более короткую запись или напиши текстом.';

export class LocalVoiceRuntime {
    constructor(runtime, processor) { this.runtime = runtime; this.processor = processor; }

    async initialize() {
        if (this.runtime.telegramVoiceEnabled) await this.processor.initialize();
    }

    async status() {
        if (!this.runtime.telegramVoiceEnabled) return { ready: false };
        try { return await this.processor.status(); } catch { return { ready: false }; }
    }

    async fail(job, record, error) {
        record.pendingVoice = false;
        record.pendingDialogue = false;
        if (error.cancelled) { record.dialogueCancelled = true; record.voiceCancelled = true; return; }
        record.voiceFailure = ['no_speech', 'voice_limit', 'duration_limit', 'invalid_audio', 'audio_unavailable'].includes(error.code) ? error.code : 'recognition_failed';
        await this.runtime.dialogue.queueReply(job, record, failureText(record.voiceFailure), [], { remember: false });
    }

    async stage(job, payload) {
        if (!/^[a-f0-9]{64}$/u.test(payload.conversationKey || '')) throw new VoiceError('invalid_audio');
        const record = {
            thought: '', thoughtAt: job.created_at || this.runtime.now().toISOString(), source: 'telegram_thought',
            conversationKey: payload.conversationKey, dialogueEpoch: this.runtime.dialogue.conversation(payload.conversationKey).epoch,
            telegramMessageId: payload.telegramMessageId, dialogueMode: 'auto', fromVoice: true,
            pendingVoice: true, completedAt: this.runtime.now().toISOString(),
        };
        if (!this.runtime.telegramVoiceEnabled) { record.pendingVoice = false; record.voiceCancelled = true; record.dialogueCancelled = true; }
        else {
            try { record.voiceInput = validateVoice(payload.voice); }
            catch (error) { await this.fail(job, record, error); }
        }
        return { record, result: { message: 'Голосовое передано локальному обработчику Mac.' }, reminders: [] };
    }

    async retry() {
        if (!(await this.status()).ready) return;
        const records = Object.entries(this.runtime.journal.jobs).filter(([, record]) => record.pendingVoice)
            .sort((a, b) => Date.parse(a[1].thoughtAt) - Date.parse(b[1].thoughtAt));
        for (const [id, record] of records) {
            if (record.retryVoiceAt && new Date(record.retryVoiceAt) > this.runtime.now()) continue;
            if (record.dialogueEpoch !== this.runtime.dialogue.conversation(record.conversationKey).epoch) {
                record.pendingVoice = false; record.voiceCancelled = true; record.dialogueCancelled = true;
                await this.runtime.persist(); continue;
            }
            try {
                const result = await this.processor.transcribe(record.voiceInput, { conversationKey: record.conversationKey, jobId: id });
                const text = typeof result.text === 'string' ? result.text.trim() : '';
                if (!text || !/[\p{L}\p{N}]/u.test(text)) throw new VoiceError('no_speech');
                if (text.length > 20000) throw new VoiceError('voice_limit');
                record.thought = text;
                record.voiceTranscribedAt = this.runtime.now().toISOString();
                record.pendingVoice = false; record.pendingDialogue = true;
                delete record.retryVoiceAt;
                // Commit the transcript before any model, note or reply action.
                await this.runtime.persist();
            } catch (error) {
                if (error instanceof VoiceError && error.retryable) {
                    record.retryVoiceAt = new Date(this.runtime.now().getTime() + 60000).toISOString();
                } else await this.fail({ id, created_at: record.thoughtAt }, record, error instanceof VoiceError ? error : new VoiceError('recognition_failed'));
                await this.runtime.persist();
            }
            // Give replies and newly queued resets a turn between long recordings.
            break;
        }
    }
}
