const clean = value => String(value || '').normalize('NFKC').trim();
const saveVerb = '(?:за\\s+помни(?:те|ть)?|запомни(?:те|ть)?|сохрани(?:те|ть)?|сохраняй|запиши(?:те)?|записать|помни|добавь(?:те)?\\s+(?:мысль|заметку|идею)|save|remember|note)';
const saveCommand = new RegExp(`^[«“"']?\\s*(?:(?:пожалуйста|смотри|слушай|так|ну|агент|давай|прошу|можешь|можете|нужно|надо|хочу|привет|здравствуй(?:те)?|да|ага)[,;:\\s]+){0,3}${saveVerb}(?![\\p{L}])(?:\\s*(?:это|мне|пожалуйста)(?![\\p{L}]))?\\s*[:;,—-]?\\s*`, 'iu');

export function saveRequest(value) {
    const text = clean(value);
    const named = text.match(/^(?:новая\s+)?(?:мысль|заметка|идея)\s*[:—-]\s*/iu);
    const command = named || text.match(saveCommand);
    if (!command) return { requested: false, content: '' };
    const content = text.slice(command[0].length).replace(/[»”"']\s*$/u, '').trim();
    return { requested: true, content: /^[\s.!?…]*$/u.test(content) || /^(?:это|эту\s+мысль|эту\s+заметку|эту\s+идею)[.!?]?$/iu.test(content) ? '' : content };
}

export const isExplicitSaveRequest = value => saveRequest(value).requested;

export function isDialogueQuestion(value) {
    const text = clean(value).replace(/^(?:(?:а|и|ну|так|смотри|слушай|пожалуйста|привет|здравствуй(?:те)?)[,;:\s]+){0,2}/iu, '');
    if (/[?？]/u.test(text)) return true;
    if (/^я\s+хочу[,]?\s+чтобы\s+ты(?![\p{L}])|^мне\s+(?:нужно|надо)\s+(?:узнать|понять|спросить)(?![\p{L}])/iu.test(text)) return true;
    return /^(?:что|кто|где|куда|откуда|когда|какой|какая|какие|какую|каков|чей|как|почему|зачем|сколько|расскажи|объясни|найди|покажи|помнишь|подробнее|подскажи|скажи|поясни|посоветуй|сравни|проанализируй|помоги|повтори|переведи|обсудим|поговорим|можешь|можете|не\s+(?:сохраняй|запоминай|записывай)|давай\s+(?:обсудим|поговорим)|напомни[,\s]+(?:что|как|когда|о\s+ч[её]м)|(?:я\s+)?(?:хочу|хотел|хотела)\s+(?:спросить|узнать|поговорить|обсудить)|what|who|where|when|which|how|why|tell|find|explain|more|can\s+you|could\s+you|неге|қалай|қайда|қай|қандай|қашан|кім)(?![\p{L}])/iu.test(text);
}

export function isDialogueFollowup(value) {
    const text = clean(value);
    return /^(?:а\s+дальше|и\s+дальше|давай\s+подробнее|подробнее|подробней|продолжи|ещ[её]|короче|чуть\s+короче|сделай\s+(?:короче|подробнее)|об\s+этом|о\s+н[её]м|почему\s+так|more|go\s+on)(?:[.!?\s]|$)/iu.test(text);
}

export function isSaveConfirmation(value) {
    return /^(?:да|ага|угу|конечно|верно|yes|sure)[.!]?$/iu.test(clean(value))
        || /^(?:да[,\s]+)?(?:сохрани(?:те|ть)?|запомни(?:те|ть)?|запиши(?:те)?|сделай\s+заметку)(?:\s+(?:это|е[её]|эту\s+мысль|эту\s+заметку))?[.!]?$/iu.test(clean(value));
}

export function isSaveRejection(value) {
    return /^(?:нет|не\s+надо|не\s+нужно|не\s+сохраняй|отмена|no|cancel)[.!]?$/iu.test(clean(value));
}

export function isDiscussionConfirmation(value) {
    return /^(?:нет[,\s]+)?(?:давай\s+|просто\s+)?(?:обсудим|поговорим|обсудить|обсуди)(?:\s+(?:это|е[её]))?[.!]?$/iu.test(clean(value));
}

export function dialogueIntent(value, { mode = 'auto', hasContext = false } = {}) {
    if (['ask', 'answer'].includes(mode)) return 'answer';
    if (['save', 'note'].includes(mode)) return 'save';
    const text = clean(value);
    const save = saveRequest(text);
    if (save.requested) return save.content ? 'save' : 'clarify';
    if (isDialogueQuestion(text)) return 'answer';
    // Recognized speech that resembles a slash command remains ordinary,
    // read-only dialogue data. Actual Telegram commands are routed server-side.
    if (/^\/[a-z]+(?:\s|$)/iu.test(text)) return 'answer';
    if (/^(?:(?:да|нет|ага|угу|ок(?:ей)?|хорошо|понятно|спасибо|благодарю|привет|здравствуй(?:те)?|добрый\s+(?:день|вечер)|thanks|thank\s+you|hi|hello)[,\s.!]*)+$/iu.test(text)) return 'answer';
    if (hasContext && isDialogueFollowup(text)) return 'answer';
    if (/^напомни(?![\p{L}])/iu.test(text)
        || /^(?:мне\s+)?(?:надо|нужно|необходимо|не\s+забыть|не\s+забудь)(?![\p{L}])\s+\S/iu.test(text)
        || /^(?:сегодня|завтра|послезавтра)(?![\p{L}])\s+\S/iu.test(text)) return 'save';
    // A clearly personal new thought can be saved; an unmarked statement is
    // ambiguous and must never be answered using a previous question's notes.
    if (/^(?:сегодня\s+)?я\s+(?:решил[а]?|думаю|считаю|планирую|понял[а]?|придумал[а]?)(?![\p{L}])|^мне\s+пришла\s+идея(?![\p{L}])|^у\s+меня\s+(?:(?:есть|появилась|новая)\s+)?(?:мысль|идея)(?![\p{L}])/iu.test(text)) return 'save';
    if (/^я\s+хочу(?![\p{L}])/iu.test(text) && !/(?:чтобы\s+ты|спросить|узнать|поговорить|обсудить|попросить\s+тебя)/iu.test(text)) return 'save';
    return 'clarify';
}
