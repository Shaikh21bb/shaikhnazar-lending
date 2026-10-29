// Baileys checks transport addresses before normalizing device/agent suffixes.
// Only known non-personal surfaces are dropped here; the normalized chat still
// has to pass the strict personal-JID gate before any generation or send.
export const ignoreWhatsAppTransportJid = value => /@(?:g\.us|broadcast|newsletter)$/u.test(String(value));

export function whatsappMessageText(value) {
    let content = value;
    for (let depth = 0; depth <= 5; depth++) {
        if (!content || typeof content !== 'object' || content.protocolMessage || content.editedMessage) return null;
        if (typeof content.conversation === 'string') return content.conversation;
        if (typeof content.extendedTextMessage?.text === 'string') return content.extendedTextMessage.text;
        const wrapper = content.ephemeralMessage || content.viewOnceMessage || content.viewOnceMessageV2
            || content.viewOnceMessageV2Extension || content.documentWithCaptionMessage;
        if (!wrapper?.message || depth === 5) return null;
        content = wrapper.message;
    }
    return null;
}
