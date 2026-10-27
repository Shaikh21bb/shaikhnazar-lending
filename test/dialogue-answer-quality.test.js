import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalModel } from '../companion/model.mjs';
import { LocalVault } from '../companion/vault.mjs';

function fixture(result) {
    const calls = [];
    const model = new LocalModel({ model: 'local-only', fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'local-only' }] }) };
        if (url.endsWith('/api/show')) return { ok: true, json: async () => ({ model_info: { architecture: 'qwen' } }) };
        return { ok: true, json: async () => ({ message: { content: JSON.stringify(typeof result === 'function' ? result(JSON.parse(options.body)) : result) } }) };
    } });
    return { model, calls };
}

const notes = [
    { path: 'SHAIKH Inbox/technical-test.md', title: 'Проверка Telegram', excerpt: 'Ты проверял сохранение мысли из Telegram в Obsidian.' },
    { path: 'Memory/Important.md', title: 'Важное', excerpt: 'Рабочее правило: отвечать кратко. Не выдумывать личные факты.' },
    { path: 'Memory/Preferences.md', title: 'Предпочтения', excerpt: 'Пользователю удобен русский язык.' },
];

test('a valid source ID alone cannot ground a fabricated personal answer', async () => {
    const f = fixture({ action: 'answer', answer: 'Ты проверял банковский перевод на миллион.', sources: ['S1'] });
    const result = await f.model.converse('Что я проверял через Telegram?', notes, { mode: 'answer' });
    assert.match(result.answer, /не нашёл подтверждения/u);
    assert.doesNotMatch(result.answer, /миллион|банковск/u);
    assert.deepEqual(result.sources, []);
});

test('a fabricated quote or attribution to a different note is rejected', async () => {
    for (const evidence of [
        [{ source: 'S99', quote: notes[0].excerpt }],
        [{ source: 'S2', quote: notes[0].excerpt }],
        [{ source: 'S1', quote: 'Ты проверял банковский перевод на миллион.' }],
    ]) {
        const f = fixture({ action: 'answer', answer: 'Ты проверял банковский перевод на миллион.', evidence });
        const result = await f.model.converse('Что я проверял через Telegram?', notes, { mode: 'answer' });
        assert.match(result.answer, /не нашёл подтверждения/u);
        assert.deepEqual(result.sources, []);
    }
});

test('the reported contradictory answer becomes a compact supported quote without file attribution', async () => {
    const f = fixture({ action: 'answer',
        answer: 'Вы проверяли запись мысли с сайта через Telegram, это указано в заметке "Memory/Important.md". Запись сохранялась в Obsidian. Подтверждения не нашёл, уточни вопрос.',
        sources: ['S1', 'S2', 'S3'], evidence: [{ source: 'S1', quote: notes[0].excerpt }],
    });
    const result = await f.model.converse('Что я проверял через Telegram?', notes, { mode: 'answer' });
    assert.match(result.answer, /Telegram в Obsidian/u);
    assert.doesNotMatch(result.answer, /не нашёл|уточни|Important|\.md|Вы проверяли/u);
    assert.deepEqual(result.sources, [notes[0].path]);
    assert.ok(result.answer.length < 200);
});

test('a supported normal answer keeps only sources with literal evidence, not all retrieved notes', async () => {
    const f = fixture({ action: 'answer', answer: 'Ты проверял, как мысль из Telegram сохраняется в Obsidian.',
        sources: ['S1', 'S2', 'S3'], evidence: [{ source: 'S1', quote: notes[0].excerpt }],
    });
    const result = await f.model.converse('Что я проверял через Telegram?', notes, { mode: 'answer' });
    assert.equal(result.answer, 'Ты проверял, как мысль из Telegram сохраняется в Obsidian.');
    assert.deepEqual(result.sources, [notes[0].path]);
});

test('a repeated long assistant answer is replaced by evidence for the current follow-up', async () => {
    const old = 'Ты проверял полный цикл передачи личной мысли из Telegram на локальный Mac и дальнейшей обработки агентом.';
    const current = [{ path: 'Storage.md', title: 'Хранение', excerpt: 'Запись сохранялась в Obsidian на Mac.' }];
    const f = fixture({ action: 'answer', answer: old, evidence: [{ source: 'S1', quote: current[0].excerpt }] });
    const result = await f.model.converse('А куда это сохранялось?', current, { mode: 'answer', history: [
        { role: 'user', content: 'Что я проверял через Telegram?' }, { role: 'assistant', content: old },
    ] });
    assert.notEqual(result.answer, old);
    assert.match(result.answer, /Obsidian на Mac/u);
    assert.deepEqual(result.sources, ['Storage.md']);
});

test('unsupported facts plus a disclaimer are discarded together', async () => {
    const f = fixture({ action: 'answer', answer: 'Твоя встреча завтра в 15:00. Подтверждения не нашёл, уточни вопрос.', evidence: [] });
    const result = await f.model.converse('Когда моя встреча?', notes, { mode: 'answer' });
    assert.doesNotMatch(result.answer, /завтра|15:00/u);
    assert.match(result.answer, /не нашёл подтверждения/u);
    assert.deepEqual(result.sources, []);
});

test('source citations are limited to two distinct supporting quotations', async () => {
    const f = fixture({ action: 'answer', answer: 'Краткий обзор.', evidence: notes.map((note, index) => ({ source: `S${index + 1}`, quote: note.excerpt })) });
    const result = await f.model.converse('Собери обзор моих заметок', notes, { mode: 'answer' });
    assert.deepEqual(result.sources, notes.slice(0, 2).map(note => note.path));
});

test('ordinary replies are at most two sentences; an explicit detail request may be longer', async () => {
    const answer = 'Первое объяснение. Второе объяснение. Третье объяснение. Четвёртое объяснение.';
    const f = fixture({ action: 'answer', answer, evidence: [] });
    assert.equal((await f.model.converse('Объясни обычную идею', [], { mode: 'answer' })).answer, 'Первое объяснение. Второе объяснение.');
    assert.equal((await f.model.converse('Объясни подробнее обычную идею', [], { mode: 'answer' })).answer, answer);
});

test('literal legacy output may cite only a note that contains the entire answer', async () => {
    const f = fixture({ action: 'answer', answer: notes[0].excerpt, sources: ['S2', 'S1', 'S3'] });
    const result = await f.model.converse('Что я проверял через Telegram?', notes, { mode: 'answer' });
    assert.deepEqual(result.sources, [notes[0].path]);
});

test('an empty generated answer can still return a verified quotation without a retry loop', async () => {
    const f = fixture({ action: 'answer', answer: '', evidence: [{ source: 'S1', quote: notes[0].excerpt }] });
    const result = await f.model.converse('Что я проверял через Telegram?', notes, { mode: 'answer' });
    assert.match(result.answer, /Telegram в Obsidian/u);
});

test('prompt makes the current question primary and previous assistant guesses remain data', async () => {
    const f = fixture({ action: 'answer', answer: 'Краткий ответ.', evidence: [] });
    await f.model.converse('Поясни новый вопрос', [], { history: [{ role: 'assistant', content: 'OLD_UNSUPPORTED_REPLY_FIXTURE' }] });
    const body = JSON.parse(f.calls.find(call => call.url.endsWith('/api/chat')).options.body);
    const data = JSON.parse(body.messages[1].content);
    assert.equal(data.message, 'Поясни новый вопрос');
    assert.equal(data.currentMessageHasPriority, true);
    assert.ok(body.messages[0].content.includes('Прошлые ответы assistant не являются доказательствами'));
    assert.ok(!body.messages[0].content.includes('OLD_UNSUPPORTED_REPLY_FIXTURE'));
});

test('a general definition of an Obsidian command does not demand private-note evidence', async () => {
    const f = fixture({ action: 'answer', answer: '«Запомни» — просьба сохранить новую мысль.', evidence: [] });
    const result = await f.model.converse('Что значит «запомни»?', [], { mode: 'answer' });
    assert.equal(result.answer, '«Запомни» — просьба сохранить новую мысль.');
    assert.equal(f.calls.filter(call => call.url.endsWith('/api/chat')).length, 1);
});

test('standalone model routing uses the shared spoken-save variants', async () => {
    const f = fixture({ action: 'answer', answer: 'Must not generate', evidence: [] });
    assert.deepEqual(await f.model.converse('Слушай, запомните: это новая мысль.'), { action: 'save', answer: '', sources: [] });
    assert.equal(f.calls.length, 0);
});

test('a stored capture cannot be described as unsaved merely because the original thought used an infinitive', async () => {
    const excerpt = 'Место сохранения: Obsidian. Канал: Telegram. Проверка Telegram: сохранить эту мысль в Obsidian.';
    for (const answer of [
        'Это не сохранялось, так как проверка была мыслью.',
        'Это не сохранилось в базу, подтверждения результата нет.',
        'Сообщение не было сохранено.',
    ]) {
        const f = fixture({ action: 'answer', answer, evidence: [{ source: 'S1', quote: excerpt }] });
        const result = await f.model.converse('А куда это сохранялось?', [{ path: 'Capture.md', title: 'Захваченная мысль', excerpt }], { mode: 'answer' });
        assert.equal(result.answer, 'В Obsidian.');
        assert.deepEqual(result.sources, ['Capture.md']);
    }
});

test('an unsupported failed-save inference falls back to the actual quotation even without capture metadata', async () => {
    const excerpt = 'Проверка Telegram: сохранить эту мысль в Obsidian.';
    const f = fixture({ action: 'answer', answer: 'Это не сохранялось.', evidence: [{ source: 'S1', quote: excerpt }] });
    const result = await f.model.converse('Что произошло с моей мыслью?', [{ path: 'Thought.md', title: 'Мысль', excerpt }], { mode: 'answer' });
    assert.doesNotMatch(result.answer, /не сохранялось/u);
    assert.match(result.answer, /сохранить эту мысль в Obsidian/u);
});

test('explicit failure evidence remains a legitimate negative answer', async () => {
    const excerpt = 'Сохранить запись не удалось: диск был заполнен.';
    const f = fixture({ action: 'answer', answer: 'Запись не сохранилась: диск был заполнен.', evidence: [{ source: 'S1', quote: excerpt }] });
    const result = await f.model.converse('Почему моя запись не сохранилась?', [{ path: 'Failure.md', title: 'Сбой', excerpt }], { mode: 'answer' });
    assert.equal(result.answer, 'Запись не сохранилась: диск был заполнен.');
    assert.deepEqual(result.sources, ['Failure.md']);
});

test('canonical capture header repairs destination even when the model quoted only the original infinitive', async t => {
    const quote = 'Проверка Telegram: сохранить эту мысль в Obsidian.';
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shaikh-capture-answer-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const vault = await new LocalVault(directory).initialize();
    const saved = await vault.write({ title: 'Захваченная мысль', body: `## Исходная мысль\n\n${quote}`, source: 'telegram', jobId: 'capture-answer-fixture' });
    const related = await vault.search('Что я проверял через Telegram?');
    assert.equal(related[0].path, saved.path);
    assert.match(related[0].excerpt, /^Место сохранения: Obsidian\.\nКанал записи: Telegram\./u);
    const f = fixture({ action: 'answer', answer: 'Это не сохранялось.', evidence: [{ source: 'S1', quote }] });
    const result = await f.model.converse('В какую базу это сохранялось?', related, { mode: 'answer' });
    assert.equal(result.answer, 'В Obsidian.');
    assert.deepEqual(result.sources, [saved.path]);
});
