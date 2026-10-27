import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VOICE_LIMITS = Object.freeze({ bytes: 19 * 1024 * 1024, seconds: 600 });
export class VoiceError extends Error {
    constructor(code, { retryable = false, cancelled = false } = {}) {
        super('Голосовое сообщение не обработано.');
        this.code = code; this.retryable = retryable; this.cancelled = cancelled;
    }
}

export function validateVoice(value) {
    if (!value || !/^[A-Za-z0-9_-]{1,512}$/u.test(value.fileId || '')
        || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.uniqueId || '')
        || !Number.isSafeInteger(value.duration) || value.duration < 1 || value.duration > VOICE_LIMITS.seconds
        || (value.size != null && (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > VOICE_LIMITS.bytes))) {
        throw new VoiceError('voice_limit');
    }
    return { fileId: value.fileId, uniqueId: value.uniqueId, duration: value.duration, size: value.size ?? null };
}

export function validateTelegramFilePath(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_./-]{1,512}$/u.test(value)
        || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
        throw new VoiceError('invalid_audio');
    }
    return value;
}

export async function voiceFormat(filename) {
    const file = await fs.open(filename, 'r');
    const header = Buffer.alloc(16);
    try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
    if (header.toString('ascii', 0, 4) === 'OggS') return 'ogg';
    if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE') return 'wav';
    if (header.toString('ascii', 4, 8) === 'ftyp') return 'mov';
    if (header.toString('ascii', 0, 3) === 'ID3' || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0)) return 'mp3';
    throw new VoiceError('invalid_audio');
}

export function localProgram(binary, args, { timeoutMs = 20000, maxOutput = 100000, env, spawnImpl = spawn } = {}) {
    return new Promise((resolve, reject) => {
        let child, finished = false, output = [], count = 0, timer;
        const finish = (error, value) => {
            if (finished) return;
            finished = true; clearTimeout(timer);
            if (error) reject(error); else resolve(value);
        };
        try { child = spawnImpl(binary, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env }); }
        catch { finish(new VoiceError('unavailable', { retryable: true })); return; }
        timer = setTimeout(() => { child.kill('SIGKILL'); finish(new VoiceError('recognition_failed')); }, timeoutMs);
        child.stdout?.on('data', chunk => {
            count += chunk.length;
            if (count > maxOutput) { child.kill('SIGKILL'); finish(new VoiceError('recognition_failed')); }
            else output.push(Buffer.from(chunk));
        });
        child.stderr?.on('data', () => {});
        child.once('error', () => finish(new VoiceError('unavailable', { retryable: true })));
        child.once('close', code => finish(null, { code, stdout: Buffer.concat(output).toString('utf8') }));
    });
}

function speechEnvironment(temporary) {
    return {
        HOME: os.homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8',
        ...(temporary ? { TMPDIR: temporary } : {}),
        HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_DATASETS_OFFLINE: '1',
        HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', TOKENIZERS_PARALLELISM: 'false',
    };
}

export class LocalSpeechRecognizer {
    constructor({ python, modelPath, ffmpeg, run = localProgram, now = () => Date.now() } = {}) {
        this.python = python; this.modelPath = modelPath; this.ffmpeg = ffmpeg;
        this.script = fileURLToPath(new URL('./transcribe.py', import.meta.url));
        this.run = run; this.now = now;
    }

    async status() {
        if (this.cached && this.now() - this.checkedAt < 60000) return this.cached;
        this.checkedAt = this.now();
        try {
            for (const value of [this.python, this.modelPath, this.ffmpeg]) {
                if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error();
                await fs.access(value);
            }
            const result = await this.run(this.python, ['-I', '-B', this.script, '--check', '--model', this.modelPath], {
                timeoutMs: 15000, maxOutput: 2000, env: speechEnvironment(),
            });
            const data = JSON.parse(result.stdout);
            this.cached = { ready: result.code === 0 && data.ready === true };
        } catch { this.cached = { ready: false }; }
        return this.cached;
    }

    async transcribe(input, directory) {
        if (!(await this.status()).ready) throw new VoiceError('unavailable', { retryable: true });
        const wav = path.join(directory, 'speech.wav');
        const format = await voiceFormat(input);
        const decoded = await this.run(this.ffmpeg, [
            '-nostdin', '-hide_banner', '-loglevel', 'error', '-n',
            '-protocol_whitelist', 'file,pipe', '-format_whitelist', format, '-f', format,
            ...(format === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
            '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1',
            '-t', '600.05', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', wav,
        ], { timeoutMs: 20000, maxOutput: 1000, env: speechEnvironment(directory) });
        if (decoded.code !== 0) throw new VoiceError('invalid_audio');
        const stat = await fs.stat(wav);
        if (!stat.isFile() || stat.size < 44 || stat.size > 600.1 * 32000 + 65536) throw new VoiceError('voice_limit');
        await fs.chmod(wav, 0o600);
        const result = await this.run(this.python, ['-I', '-B', this.script, '--model', this.modelPath, '--audio', wav], {
            timeoutMs: 120000, maxOutput: 100000, env: speechEnvironment(directory),
        });
        let data;
        try { data = JSON.parse(result.stdout); } catch { throw new VoiceError('recognition_failed'); }
        if (result.code !== 0 || data.error) {
            const code = ['no_speech', 'invalid_audio', 'duration_limit', 'unavailable'].includes(data.error) ? data.error : 'recognition_failed';
            throw new VoiceError(code, { retryable: code === 'unavailable' });
        }
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        if (!text || !/[\p{L}\p{N}]/u.test(text)) throw new VoiceError('no_speech');
        if (text.length > 20000) throw new VoiceError('voice_limit');
        return { text, ...(typeof data.language === 'string' ? { language: data.language.slice(0, 12) } : {}) };
    }
}

export class LocalVoiceProcessor {
    constructor({ config, stateDirectory, delivery, recognizer, fetchImpl = fetch } = {}) {
        this.delivery = delivery; this.fetch = fetchImpl;
        this.temporary = path.join(stateDirectory, 'voice-temp');
        this.recognizer = recognizer || new LocalSpeechRecognizer({ python: config.speechPython, modelPath: config.speechModelPath, ffmpeg: config.ffmpegPath });
    }

    async initialize() {
        await fs.mkdir(this.temporary, { recursive: true, mode: 0o700 });
        if ((await fs.lstat(this.temporary)).isSymbolicLink()) throw new VoiceError('invalid_audio');
        await fs.chmod(this.temporary, 0o700);
        for (const entry of await fs.readdir(this.temporary, { withFileTypes: true })) {
            if (entry.name.startsWith('job-') && entry.isDirectory() && !entry.isSymbolicLink()) {
                await fs.rm(path.join(this.temporary, entry.name), { recursive: true, force: true });
            }
        }
    }

    status() { return this.recognizer.status(); }

    async transcribe(voice, { conversationKey, jobId }) {
        const metadata = validateVoice(voice);
        if (!(await this.status()).ready) throw new VoiceError('unavailable', { retryable: true });
        let credentials;
        try { credentials = await this.delivery.credentials({ conversationKey, jobId }); }
        catch { throw new VoiceError('download_unavailable', { retryable: true }); }
        if (!credentials) throw new VoiceError('owner_changed', { cancelled: true });
        const directory = await fs.mkdtemp(path.join(this.temporary, 'job-'));
        await fs.chmod(directory, 0o700);
        try {
            let info;
            try {
                const response = await this.fetch(`https://api.telegram.org/bot${credentials.token}/getFile`, {
                    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ file_id: metadata.fileId }), signal: AbortSignal.timeout(15000),
                });
                info = await response.json();
                if (!response.ok || info.ok !== true) throw new VoiceError('audio_unavailable', { retryable: response.status === 429 || response.status >= 500 });
            } catch (error) {
                if (error instanceof VoiceError) throw error;
                throw new VoiceError('download_unavailable', { retryable: true });
            }
            const filePath = validateTelegramFilePath(info.result?.file_path);
            if (Number(info.result?.file_size) > VOICE_LIMITS.bytes) throw new VoiceError('voice_limit');
            const input = path.join(directory, 'telegram.audio');
            await this.download(`https://api.telegram.org/file/bot${credentials.token}/${filePath}`, input);
            return await this.recognizer.transcribe(input, directory);
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    }

    async download(url, filename) {
        const parsed = new URL(url);
        if (parsed.origin !== 'https://api.telegram.org' || parsed.username || parsed.password || parsed.search || parsed.hash
            || !parsed.pathname.startsWith('/file/bot')) throw new VoiceError('invalid_audio');
        let response;
        try { response = await this.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) }); }
        catch { throw new VoiceError('download_unavailable', { retryable: true }); }
        if (!response.ok) throw new VoiceError('audio_unavailable', { retryable: response.status === 429 || response.status >= 500 });
        if (Number(response.headers.get('content-length')) > VOICE_LIMITS.bytes) {
            await response.body?.cancel().catch(() => {});
            throw new VoiceError('voice_limit');
        }
        const file = await fs.open(filename, 'wx', 0o600);
        let bytes = 0;
        try {
            if (!response.body) throw new VoiceError('invalid_audio');
            for await (const chunk of response.body) {
                const data = Buffer.from(chunk);
                bytes += data.length;
                if (bytes > VOICE_LIMITS.bytes) throw new VoiceError('voice_limit');
                let offset = 0;
                while (offset < data.length) offset += (await file.write(data, offset, data.length - offset)).bytesWritten;
            }
            if (!bytes) throw new VoiceError('invalid_audio');
        } catch (error) {
            if (error instanceof VoiceError) throw error;
            throw new VoiceError('download_unavailable', { retryable: true });
        } finally { await file.close(); }
    }
}
