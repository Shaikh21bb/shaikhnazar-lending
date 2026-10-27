import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { decryptEnvelope, encryptEnvelope, validatePublicKey } from '../lib/private-envelope.mjs';
import { LocalVault } from './vault.mjs';
import { LocalModel } from './model.mjs';
import { normalizeTasks, nextDailyOverview, bindExplicitDeadline, TIMEZONE } from './reminders.mjs';

export async function writePrivateJSON(filename, value) {
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
    await fs.chmod(filename, 0o600);
}

export async function readPrivateJSON(filename, fallback = {}) {
    try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('Локальный файл состояния повреждён. Исходные заметки не изменены.'); }
}

export function deviceRequest({ baseURL, token, fetchImpl = fetch }) {
    const base = new URL(baseURL);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) {
        throw new Error('Подключение к платформе требует HTTPS.');
    }
    return async payload => {
        const response = await fetchImpl(new URL('/api/hub/device', base), {
            method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000),
        });
        let data;
        try { data = await response.json(); } catch { throw new Error('Платформа временно недоступна.'); }
        if (!response.ok) {
            const error = new Error(response.status === 401 ? 'Mac отключён от кабинета. Выполните повторное сопряжение.' : 'Платформа не приняла задание. Повторим подключение.');
            error.status = response.status;
            throw error;
        }
        return data;
    };
}

function fallbackAnalysis(text) {
    const first = String(text).split(/[\n.!?]/u).find(line => line.trim()) || 'Новая мысль';
    return { title: first.slice(0, 90), body: String(text), tags: ['входящие', 'ожидает-анализа'], links: [], tasks: [] };
}

export function hasExplicitTime(text) {
    return /(?:\b(?:[01]?\d|2[0-3])[:.][0-5]\d\b|T\d{2}:\d{2}\b|(?:^|\s)в\s+(?:[01]?\d|2[0-3])(?=\s|[,.!?]|$)|(?:^|\s)в\s+(?:один|два|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать|тринадцать|четырнадцать|пятнадцать|шестнадцать|семнадцать|восемнадцать|девятнадцать|двадцать)(?=\s|[,.!?]|$)|(?:^|[^\p{L}])(?:час(?:а|ов)?|утра|вечера|полдень|полночь|сағат)(?=$|[^\p{L}]))/iu.test(String(text));
}

export function withOriginalThought(body, thought, clarification) {
    const original = ['## Исходная мысль', '', String(thought).trim(), ...(clarification ? ['', '### Уточнение', '', String(clarification).trim()] : [])].join('\n');
    return `${String(body || '').trim()}\n\n---\n\n${original}`;
}

function resultFor(record) {
    return {
        note: record.note,
        message: record.pending ? 'Мысль сохранена в Obsidian. Локальная модель сейчас недоступна; оформление, связи и задачи будут обработаны после её запуска.' : 'Мысль оформлена и сохранена в Obsidian на Mac.',
        pendingAnalysis: Boolean(record.pending),
        clarification: record.clarification?.length ? { question: record.clarification[0].question, tasks: record.clarification } : null,
        reminders: record.tasks?.map(task => ({ id: task.id, dueAt: task.dueAt, notifyAt: task.notifyAt, text: task.text })) || [],
    };
}

export class CompanionRuntime {
    constructor({ config, stateDirectory, request, vault, model, adapter, now = () => new Date(), log = console.log }) {
        this.config = config;
        this.stateDirectory = stateDirectory;
        this.request = request || deviceRequest({ baseURL: config.baseURL, token: config.token });
        this.vault = vault || new LocalVault(config.vaultPath, { backupDirectory: path.join(stateDirectory, 'backups') });
        this.model = model || new LocalModel({ url: config.modelURL, model: config.model });
        this.adapter = adapter;
        this.now = now;
        this.log = log;
        this.journalPath = path.join(stateDirectory, 'journal.json');
        this.stopped = false;
        this.lastRetry = 0;
    }

    async initialize() {
        await this.vault.initialize();
        this.journal = await readPrivateJSON(this.journalPath, { jobs: {}, reminders: {}, daily: null });
        this.journal.jobs ||= {};
        this.journal.reminders ||= {};
        return this;
    }

    async persist() { await writePrivateJSON(this.journalPath, this.journal); }

    async processThought(job, payload, modelReady) {
        if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 50_000) throw new Error('Мысль пустая или слишком длинная.');
        let original;
        if (payload.intent === 'clarify') {
            original = this.journal.jobs[payload.relatedJobId];
            if (!original?.thought || !original?.note) throw new Error('Исходная мысль не найдена на этом Mac.');
        }
        const thought = original?.thought || payload.text.trim();
        const submitted = typeof job.created_at === 'string' ? new Date(job.created_at) : null;
        const submittedAt = submitted && Number.isFinite(submitted.getTime()) && submitted.getTime() <= this.now().getTime() + 5 * 60_000 ? submitted.toISOString() : this.now().toISOString();
        const thoughtAt = original?.thoughtAt || original?.completedAt || submittedAt;
        const related = modelReady ? await this.vault.related(thought, { excludePath: original?.note.path }) : [];
        let analysis;
        let pending = false;
        try {
            if (!modelReady) throw new Error('offline');
            analysis = await this.model.analyze(thought, related, { clarification: original ? payload.text : undefined, submittedAt: thoughtAt });
        } catch {
            pending = true;
            analysis = original?.analysis ? { ...original.analysis, tasks: [] } : fallbackAnalysis(thought);
            if (original) analysis.body += `\n\n## Уточнение срока\n\n${payload.text.trim()}`;
        }
        const datedTasks = bindExplicitDeadline(analysis.tasks, thought, { now: this.now(), originalNow: new Date(thoughtAt), clarification: original ? payload.text : undefined });
        const taskData = normalizeTasks(datedTasks, { jobId: job.id, now: this.now() });
        const note = await this.vault.write({ ...analysis, body: withOriginalThought(analysis.body, thought, original ? payload.text : undefined), jobId: original?.noteJobId || job.id, updatePath: original?.note.path, source: job.kind === 'telegram_thought' ? 'telegram' : 'website', pending });
        note.openUrl = `obsidian://open?vault=${encodeURIComponent(path.basename(this.vault.directory))}&file=${encodeURIComponent(note.path)}`;
        const record = {
            thought, thoughtAt, clarificationText: original ? payload.text.trim() : undefined, note,
            noteJobId: original?.noteJobId || job.id, pending, analysis,
            tasks: pending && original ? original.tasks || [] : taskData.local,
            clarification: pending && original ? original.clarification || [] : taskData.clarification,
            replyPublicKey: payload.replyPublicKey || null, source: job.kind, completedAt: this.now().toISOString(),
        };
        for (const task of taskData.local) this.journal.reminders[task.id] = { ...task, notePath: note.path };
        return { record, result: resultFor(record), reminders: taskData.reminders };
    }

    async handleJob(job, modelReady) {
        if (!job || typeof job.id !== 'string' || !job.envelope) throw new Error('Некорректное задание платформы.');
        const payload = await decryptEnvelope(this.config.privateKey, job.envelope);
        if (payload.replyPublicKey) validatePublicKey(payload.replyPublicKey);
        let stored = this.journal.jobs[job.id];
        let result;
        let reminders;
        if (stored) {
            result = stored.result || resultFor(stored);
            reminders = stored.tasks?.map(task => ({ id: task.id, due_at: task.notifyAt })) || [];
        } else if (job.kind === 'whatsapp_connect' || job.kind === 'whatsapp_disconnect' || job.kind === 'whatsapp_status') {
            if (!this.adapter?.handleJob) throw new Error('WhatsApp-модуль не установлен на Mac.');
            result = await this.adapter.handleJob(job, payload);
            stored = { result, source: job.kind, completedAt: this.now().toISOString() };
            this.journal.jobs[job.id] = stored;
            await this.persist();
        } else {
            const processed = await this.processThought(job, payload, modelReady);
            stored = processed.record;
            result = processed.result;
            reminders = processed.reminders;
            this.journal.jobs[job.id] = stored;
            // Write the local journal before acknowledging, so a retried leased job reuses the same note.
            await this.persist();
        }
        const resultEnvelope = payload.replyPublicKey ? await encryptEnvelope(payload.replyPublicKey, result) : undefined;
        const completion = { action: 'complete', jobId: job.id, leaseToken: job.lease_token, status: 'complete', reminders: reminders || [] };
        if (resultEnvelope) completion.resultEnvelope = resultEnvelope;
        if (stored.clarification?.length) completion.needsClarification = true;
        await this.request(completion);
        if (job.kind === 'telegram_thought' && stored.clarification?.length) {
            await this.request({ action: 'notify', kind: 'clarification', jobId: job.id });
        }
        this.log('Задание обработано на Mac. Содержимое заметки осталось локально.');
        return result;
    }

    async retryPending(modelReady) {
        await this.flushPendingSync();
        if (!modelReady || this.now().getTime() - this.lastRetry < 60_000) return;
        this.lastRetry = this.now().getTime();
        for (const [id, record] of Object.entries(this.journal.jobs)) {
            if (!record.pending || !record.thought) continue;
            try {
                const related = await this.vault.related(record.thought, { excludePath: record.note.path });
                const analysis = await this.model.analyze(record.thought, related, { clarification: record.clarificationText, submittedAt: record.thoughtAt || record.completedAt });
                const datedTasks = bindExplicitDeadline(analysis.tasks, record.thought, { now: this.now(), originalNow: new Date(record.thoughtAt || record.completedAt), clarification: record.clarificationText });
                const taskData = normalizeTasks(datedTasks, { jobId: id, now: this.now() });
                const note = await this.vault.write({ ...analysis, body: withOriginalThought(analysis.body, record.thought, record.clarificationText), jobId: record.noteJobId || id, updatePath: record.note.path, source: record.source === 'telegram_thought' ? 'telegram' : 'website' });
                note.openUrl = record.note.openUrl;
                Object.assign(record, { note, analysis, pending: false, tasks: taskData.local, clarification: taskData.clarification });
                for (const task of taskData.local) this.journal.reminders[task.id] = { ...task, notePath: note.path };
                const resultEnvelope = record.replyPublicKey ? await encryptEnvelope(record.replyPublicKey, resultFor(record)) : undefined;
                record.syncPending = { action: 'sync_reminders', jobId: id, reminders: taskData.reminders, ...(resultEnvelope ? { resultEnvelope } : {}), needsClarification: Boolean(record.clarification.length) };
                await this.persist();
                await this.flushPendingSync();
                this.log('Отложенная мысль оформлена локальной моделью.');
            } catch {
                this.log('Локальная обработка ожидает доступную модель или подключение.');
                break;
            }
        }
    }

    async flushPendingSync() {
        for (const [id, record] of Object.entries(this.journal.jobs)) {
            if (!record.syncPending) continue;
            await this.request(record.syncPending);
            if (record.source === 'telegram_thought') await this.request({ action: 'notify', kind: record.clarification?.length ? 'clarification' : 'processed', jobId: id });
            delete record.syncPending;
            await this.persist();
        }
    }

    async tick() {
        const status = await this.model.status();
        const whatsapp = typeof this.adapter?.status === 'function' ? this.adapter.status() : this.adapter?.status;
        const response = await this.request({ action: 'poll', status: { state: status.ready ? 'ready' : 'model_offline', model: status.model || '', modelReady: Boolean(status.ready), ...(whatsapp ? { whatsapp } : {}) } });
        if (this.adapter?.onPoll) await this.adapter.onPoll(response);
        for (const job of response.jobs || []) {
            try { await this.handleJob(job, status.ready); }
            catch (error) {
                this.log('Задание ожидает повторной обработки. Подробности доступны только на Mac.');
                // Neither thoughts nor exception messages are sent to the platform or console.
                if (error.status === 401) throw error;
            }
        }
        await this.retryPending(status.ready);
        return { modelReady: status.ready, processed: response.jobs?.length || 0 };
    }

    async run({ interval = 10_000, once = false } = {}) {
        if (!this.journal) await this.initialize();
        this.log(`Личный агент запущен. База и её анализ — только на Mac. Часовой пояс: ${TIMEZONE}.`);
        do {
            try { await this.tick(); }
            catch (error) {
                if (error.status === 401) throw error;
                this.log('Нет связи с платформой. Агент повторит подключение; заметки остаются на Mac.');
            }
            if (!once && !this.stopped) await new Promise(resolve => { this.sleepTimer = setTimeout(resolve, interval); this.wake = resolve; });
        } while (!once && !this.stopped);
    }

    async stop() {
        this.stopped = true;
        clearTimeout(this.sleepTimer);
        this.wake?.();
        await this.adapter?.stop?.();
    }
}

export function createCompanion(options) { return new CompanionRuntime(options); }

export { nextDailyOverview };
