import test from 'node:test';
import assert from 'node:assert/strict';
import { generateEnvelopeKeyPair, encryptEnvelope, decryptEnvelope, validateEnvelope, validatePublicKey } from '../lib/private-envelope.mjs';

test('thought and reply envelopes round-trip across separate device/session keys', async () => {
    const device = await generateEnvelopeKeyPair();
    const browser = await generateEnvelopeKeyPair();
    const text = 'Моя приватная мысль про проект';
    const envelope = await encryptEnvelope(device.publicKey, { text, replyPublicKey: browser.publicKey });
    assert.equal(JSON.stringify(envelope).includes(text), false);
    const request = await decryptEnvelope(device.privateKey, envelope);
    assert.equal(request.text, text);
    const reply = await encryptEnvelope(request.replyPublicKey, { note: { title: 'Проект' } });
    assert.deepEqual(await decryptEnvelope(browser.privateKey, reply), { note: { title: 'Проект' } });
    await assert.rejects(decryptEnvelope(browser.privateKey, envelope));
});

test('tampering, plaintext fields and malformed ciphertext are rejected', async () => {
    const pair = await generateEnvelopeKeyPair();
    const envelope = await encryptEnvelope(pair.publicKey, { text: 'private' });
    assert.throws(() => validateEnvelope({ ...envelope, text: 'leak' }));
    assert.throws(() => validatePublicKey(pair.privateKey));
    assert.throws(() => validateEnvelope({ ...envelope, iv: 'AA==' }));
    const altered = { ...envelope, ciphertext: (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1) };
    await assert.rejects(decryptEnvelope(pair.privateKey, altered));
});
