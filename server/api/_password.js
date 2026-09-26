import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashPassword(password) {
    const salt = randomBytes(16).toString('base64url');
    const hash = await scrypt(String(password), salt, KEY_LENGTH);
    return `scrypt$${salt}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
    const value = String(stored || '');
    if (value.startsWith('scrypt$')) {
        const parts = value.split('$');
        if (parts.length !== 3 || !parts[1] || !parts[2]) return { valid: false, legacy: false };
        const expected = Buffer.from(parts[2], 'base64url');
        if (expected.length !== KEY_LENGTH) return { valid: false, legacy: false };
        const actual = await scrypt(String(password), parts[1], KEY_LENGTH);
        return { valid: timingSafeEqual(actual, expected), legacy: false };
    }
    const secret = process.env.AUTH_SECRET || 'local-development-only-change-me';
    const digest = input => createHmac('sha256', secret).update(String(input || '')).digest();
    return { valid: timingSafeEqual(digest(password), digest(value)), legacy: true };
}
