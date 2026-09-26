// Memory contains the client's own words, not model-invented profile facts.
export function rememberClient(previous = {}, text = '', displayName = '', previousQuestion = '') {
    const statements = Array.isArray(previous?.statements) ? previous.statements.filter(item => typeof item === 'string').slice(-8) : [];
    const value = String(text).trim().slice(0, 500);
    const personal = /(меня зовут|я (?:учитель|преподаю|работаю|из |живу)|мне (?:нуж|интерес)|у меня|менің атым|мен .{0,50}мұғалім)/iu.test(value);
    const answersProfileQuestion = /[?]/u.test(previousQuestion) && /(как вас|имя|предмет|класс|задач|нужн|интерес|препода|сынып|пән)/iu.test(previousQuestion);
    const statement = personal ? value : (value && answersProfileQuestion ? `На вопрос «${String(previousQuestion).slice(0, 200)}» клиент ответил: «${value.slice(0, 250)}»` : '');
    if (statement && !statements.includes(statement)) statements.push(statement);
    return { displayName: String(displayName || previous?.displayName || '').slice(0, 100), statements: statements.slice(-8) };
}

export function conversationalReply(answer, question = '') {
    const text = String(answer).replace(/^<think>[\s\S]*?<\/think>\s*/i, '').trim();
    if (!text || text.includes('<think>')) throw new Error('Local model returned no safe reply');
    const detailed = /подроб|деталь|по шаг|полный список|все возможности|толық|егжей/iu.test(question);
    const limit = detailed ? 1100 : 420;
    const sentences = text.split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z0-9«])/u).slice(0, detailed ? 6 : 2).join(' ');
    if (sentences.length <= limit) return sentences;
    const part = sentences.slice(0, limit);
    const boundary = Math.max(part.lastIndexOf('. '), part.lastIndexOf('? '), part.lastIndexOf('! '));
    if (boundary >= 60) return part.slice(0, boundary + 1);
    const space = part.lastIndexOf(' ');
    return part.slice(0, space > 0 ? space : limit) + '…';
}

export async function withChatPresence(socket, key, recipient, work, timers = { setInterval, clearInterval }) {
    // Do not change account privacy settings; read receipts can be hidden by WhatsApp.
    await socket.readMessages([key]).catch(() => {});
    const presence = value => socket.sendPresenceUpdate(value, recipient).catch(() => {});
    await presence('composing');
    const timer = timers.setInterval(() => { void presence('composing'); }, 8000);
    try { return await work(); }
    finally {
        timers.clearInterval(timer);
        await presence('paused');
    }
}
