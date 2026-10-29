import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireWorker = createRequire(new URL('../worker/package.json', import.meta.url));
let decodeMessageNode;
try {
    const baileys = await import(pathToFileURL(requireWorker.resolve('@whiskeysockets/baileys')).href);
    decodeMessageNode = baileys.decodeMessageNode;
    assert.equal(typeof decodeMessageNode, 'function', 'installed WhatsApp package must export its real wire decoder');
} catch (error) {
    if (!['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(error.code)) throw error;
}
const options = { skip: !decodeMessageNode && 'Optional WhatsApp worker dependencies are absent; run npm ci --prefix worker.' };
const ownerPn = '77771234567:4@s.whatsapp.net';
const ownerLid = '123456789012345:4@lid';
const strangerPn = '77779876543:2@s.whatsapp.net';
const strangerLid = '987654321098765:2@lid';

function stanza(from, participant) {
    return { tag: 'message', attrs: { from, ...(participant ? { participant } : {}),
        id: 'synthetic-peer-control', t: '1761720300', category: 'peer' }, content: [] };
}

test('real wire decoder recognizes owner PN participant in a LID-routed peer stanza', options, () => {
    const decoded = decodeMessageNode(stanza(ownerLid, ownerPn), ownerPn, ownerLid);
    assert.equal(decoded.fullMessage.key.fromMe, true);
});

test('real wire decoder recognizes owner LID participant in a PN-routed peer stanza', options, () => {
    const decoded = decodeMessageNode(stanza(ownerPn, ownerLid), ownerPn, ownerLid);
    assert.equal(decoded.fullMessage.key.fromMe, true);
});

test('real wire decoder still distinguishes both owner identities from non-owner senders', options, () => {
    for (const from of [ownerPn, ownerLid]) {
        assert.equal(decodeMessageNode(stanza(from), ownerPn, ownerLid).fullMessage.key.fromMe, true);
    }
    for (const [from, participant] of [[strangerPn], [strangerLid], [ownerPn, strangerLid], [ownerLid, strangerPn]]) {
        assert.equal(decodeMessageNode(stanza(from, participant), ownerPn, ownerLid).fullMessage.key.fromMe, false);
    }
    const forged = stanza(strangerPn);
    forged.attrs.recipient = ownerLid;
    assert.throws(() => decodeMessageNode(forged, ownerPn, ownerLid), /msg not from me/);
});
