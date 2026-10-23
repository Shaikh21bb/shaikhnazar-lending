import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const failure = (message, status = 400) => Object.assign(new Error(message), { status });

function masterSecret() {
    const dedicated = process.env.CREDENTIALS_ENCRYPTION_KEY || '';
    const production = Boolean(process.env.VERCEL_ENV) || process.env.NODE_ENV === 'production';
    const secret = dedicated || (production ? '' : (process.env.AUTH_SECRET || ''));
    if (secret.length < 32) {
        throw failure('Сервер не готов к безопасному хранению подключений.', 503);
    }
    return secret;
}

function encryptionKey(subjectId, provider) {
    const salt = Buffer.from(String(subjectId), 'utf8');
    const info = `shaikh/credential/${String(provider)}/v1`;
    return Buffer.from(hkdfSync('sha256', masterSecret(), salt, info, 32));
}

export function encryptCredential(subjectId, provider, plainText) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey(subjectId, provider), iv);
    cipher.setAAD(Buffer.from(`${subjectId}:${provider}:1`, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
    return [1, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptCredential(subjectId, provider, box) {
    const parts = String(box || '').split('.');
    if (parts.length !== 4 || parts[0] !== '1') {
        throw failure('Сохранённое подключение повреждено. Подключите его заново.', 503);
    }
    try {
        const decipher = createDecipheriv(
            'aes-256-gcm',
            encryptionKey(subjectId, provider),
            Buffer.from(parts[1], 'base64url')
        );
        decipher.setAAD(Buffer.from(`${subjectId}:${provider}:1`, 'utf8'));
        decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
        return Buffer.concat([
            decipher.update(Buffer.from(parts[3], 'base64url')),
            decipher.final()
        ]).toString('utf8');
    } catch {
        throw failure('Не удалось прочитать подключение. Подключите его заново.', 503);
    }
}

