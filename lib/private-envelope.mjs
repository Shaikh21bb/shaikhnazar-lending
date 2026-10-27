// Shared by the browser, the server and the Mac companion. Only the Mac owns
// the vault decryption key; a browser session owns its separate reply key.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_CIPHERTEXT = 512 * 1024;

function cryptoApi() {
    if (!globalThis.crypto?.subtle) throw new Error('Web Crypto requires HTTPS or localhost');
    return globalThis.crypto;
}

function base64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(binary);
}

function bytes(value, maxBytes) {
    if (typeof value !== 'string' || !value || value.length > Math.ceil(maxBytes / 3) * 4
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid encrypted envelope');
    let decoded;
    try { decoded = atob(value); } catch { throw new Error('Invalid encrypted envelope'); }
    if (decoded.length > maxBytes) throw new Error('Encrypted envelope is too large');
    return Uint8Array.from(decoded, char => char.charCodeAt(0));
}

export function validatePublicKey(jwk) {
    if (!jwk || jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string'
        || jwk.n.length < 342 || jwk.n.length > 684 || jwk.e !== 'AQAB'
        || !/^[A-Za-z0-9_-]+$/.test(jwk.n) || 'd' in jwk || 'p' in jwk || 'q' in jwk) {
        throw new Error('Expected an RSA public key (2048–4096 bits)');
    }
    return { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RSA-OAEP-256', ext: true, key_ops: ['encrypt'] };
}

export function validateEnvelope(envelope) {
    if (!envelope || envelope.v !== 1 || Object.keys(envelope).some(key => !['v', 'wrappedKey', 'iv', 'ciphertext'].includes(key))) {
        throw new Error('Invalid encrypted envelope');
    }
    const wrapped = bytes(envelope.wrappedKey, 512);
    if (![256, 384, 512].includes(wrapped.length) || bytes(envelope.iv, 12).length !== 12
        || bytes(envelope.ciphertext, MAX_CIPHERTEXT).length < 16) throw new Error('Invalid encrypted envelope');
    return envelope;
}

export async function generateEnvelopeKeyPair() {
    const api = cryptoApi();
    const pair = await api.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
    return {
        publicKey: await api.subtle.exportKey('jwk', pair.publicKey),
        privateKey: await api.subtle.exportKey('jwk', pair.privateKey)
    };
}

export async function encryptEnvelope(publicJwk, payload) {
    const api = cryptoApi();
    const serialized = encoder.encode(JSON.stringify(payload));
    if (serialized.length > MAX_CIPHERTEXT - 16) throw new Error('Message is too large');
    const recipient = await api.subtle.importKey('jwk', validatePublicKey(publicJwk), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const key = await api.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const iv = api.getRandomValues(new Uint8Array(12));
    const ciphertext = await api.subtle.encrypt({ name: 'AES-GCM', iv }, key, serialized);
    const rawKey = await api.subtle.exportKey('raw', key);
    const wrappedKey = await api.subtle.encrypt({ name: 'RSA-OAEP' }, recipient, rawKey);
    return { v: 1, wrappedKey: base64(new Uint8Array(wrappedKey)), iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
}

export async function decryptEnvelope(privateJwk, envelope) {
    validateEnvelope(envelope);
    const api = cryptoApi();
    const recipient = await api.subtle.importKey('jwk', privateJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
    const rawKey = await api.subtle.decrypt({ name: 'RSA-OAEP' }, recipient, bytes(envelope.wrappedKey, 512));
    const key = await api.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const clear = await api.subtle.decrypt({ name: 'AES-GCM', iv: bytes(envelope.iv, 12) }, key, bytes(envelope.ciphertext, MAX_CIPHERTEXT));
    return JSON.parse(decoder.decode(clear));
}
