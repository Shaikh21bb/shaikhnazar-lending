import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalVault } from '../companion/vault.mjs';

async function fixture(t, notes) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shaikh-retrieval-quality-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    for (const [relative, body] of Object.entries(notes)) {
        await fs.mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
        await fs.writeFile(path.join(directory, relative), body);
    }
    return new LocalVault(directory).initialize();
}

const thought = text => `---\nshaikh_id: "synthetic-job"\ncreated: "2026-10-27T12:00:00Z"\nsource: "telegram"\n---\n# Проверка Telegram\n${text}\n\n## Исходная мысль\n\n${text}\n`;

test('activity recall retrieves the captured thought instead of generic Telegram instructions and preferences', async t => {
    const vault = await fixture(t, {
        'SHAIKH Inbox/captured.md': thought('Проверка Telegram: сохранить эту мысль в Obsidian.'),
        'Memory/Important.md': '# Правила помощника\nАгент должен проверять подключение Telegram. Не выдумывай данные; уточни вопрос, если подтверждения нет.',
        'Memory/Preferences.md': '# Предпочтения\nПредпочитаю получать напоминания через Telegram. База находится на Mac.',
        'Daily/2026-09-20.md': '# День\nРабота с Telegram и чтение книги.',
    });
    const result = await vault.search('Что я проверял через Telegram?');
    assert.deepEqual(result.map(note => note.path), ['SHAIKH Inbox/captured.md']);
    assert.match(result[0].excerpt, /сохранить эту мысль в Obsidian/u);
});

test('Russian Telegram, Obsidian and Mac names resolve to the same explicit technical facts', async t => {
    const vault = await fixture(t, {
        'Captured.md': thought('Проверка Telegram: сохранить эту мысль в Obsidian. Распознавание работает на Mac.'),
        'Other.md': '# Кофе\nСегодня пробовал маковый пирог.',
    });
    assert.equal((await vault.search('Что я проверял через Телеграм?'))[0].path, 'Captured.md');
    assert.equal((await vault.search('Что сохранено в Обсидиане?'))[0].path, 'Captured.md');
    assert.equal((await vault.search('Где работает распознавание на Макбуке?'))[0].path, 'Captured.md');
});

test('an elliptical storage follow-up reuses the actual prior evidence without introducing generic memory files', async t => {
    const vault = await fixture(t, {
        'Captured.md': thought('Проверка Telegram: сохранить эту мысль в Obsidian.'),
        'Memory/Important.md': '# Общие правила\nИнформация из Telegram сохраняется в Obsidian. Агент должен быть внимательным.',
        'Memory/Preferences.md': '# Предпочтения\nTelegram используется для уведомлений.',
    });
    const result = await vault.search('А куда это сохранялось?', {
        history: [{ role: 'user', content: 'Что я проверял через Telegram?' }], sourcePaths: ['Captured.md'],
    });
    assert.deepEqual(result.map(note => note.path), ['Captured.md']);
});

test('a new topic after a conjunction does not inherit stale sources or the older of two user topics', async t => {
    const vault = await fixture(t, {
        'Alpha.md': '# Альфа\nБюджет Альфа — 20 условных единиц.',
        'Beta.md': '# Бета\nБюджет Бета — 50 условных единиц.',
        'Gamma.md': '# Гамма\nБюджет Гамма — 80 условных единиц.',
    });
    const context = { history: [{ role: 'user', content: 'Расскажи о Гамма' }, { role: 'user', content: 'Что известно о Альфа?' }], sourcePaths: ['Alpha.md', 'Gamma.md'] };
    const changed = await vault.search('А что известно о Бета?', context);
    assert.deepEqual(changed.map(note => note.path), ['Beta.md']);
    const followup = await vault.search('А какой бюджет?', context);
    assert.deepEqual(followup.map(note => note.path), ['Alpha.md']);
});

test('a follow-up may find a new source for the same subject when prior notes lack that detail', async t => {
    const vault = await fixture(t, {
        'Alpha.md': '# Альфа\nПроект Альфа связан с местным маяком.',
        'Alpha-budget.md': '# Бюджет Альфа\nНа проект Альфа предусмотрено 20 условных единиц.',
        'Beta-budget.md': '# Бюджет Бета\nНа проект Бета предусмотрено 50 условных единиц.',
    });
    const result = await vault.search('А какой бюджет?', { history: [{ role: 'user', content: 'Что известно о проекте Альфа?' }], sourcePaths: ['Alpha.md'] });
    assert.equal(result[0].path, 'Alpha-budget.md');
    assert.ok(result.every(note => note.path !== 'Beta-budget.md'));
});

test('explicitly named Memory notes remain accessible without a folder-level exclusion', async t => {
    const vault = await fixture(t, {
        'Memory/Important.md': '# Важное\nПредпочтительное время обзора — девять утра.',
        'Memory/Preferences.md': '# Предпочтения\nПисьма читаю вечером.',
        'Captured.md': thought('Проверка Telegram: сохранить эту мысль в Obsidian.'),
    });
    const result = await vault.search('Что указано в заметке Memory/Important.md?');
    assert.deepEqual(result.map(note => note.path), ['Memory/Important.md']);
});

test('matching generic workflow words alone cannot flood a specific project question', async t => {
    const notes = { 'Project.md': '# Орион\nПроверка проекта Орион назначена на ноябрь.' };
    for (let index = 0; index < 10; index++) notes[`Generic-${index}.md`] = `# Общая инструкция ${index}\nПроект работает, через Telegram идёт проверка и тестирование.`;
    const vault = await fixture(t, notes);
    const result = await vault.search('Когда проверка проекта Орион?');
    assert.deepEqual(result.map(note => note.path), ['Project.md']);
});

test('the useful source set is capped at three and late matching passages remain available', async t => {
    const notes = {};
    for (let index = 0; index < 8; index++) notes[`Project-${index}.md`] = `# Кварц ${index}\n${'Вводная часть. '.repeat(800)}\nКварц: финальная сдача 17 ноября.\n`;
    const vault = await fixture(t, notes);
    const result = await vault.search('Кварц', { limit: 99 });
    assert.equal(result.length, 3);
    assert.ok(result.every(note => note.excerpt.includes('17 ноября') && note.excerpt.length <= 2600));
});

test('a first question about a generic attribute still retrieves its direct evidence without prior context', async t => {
    const vault = await fixture(t, { 'Проект.md': '# Проект\nКод проекта — Янтарь.' });
    const result = await vault.search('Какой код проекта?');
    assert.deepEqual(result.map(note => note.path), ['Проект.md']);
});

test('broad saved-thought recall does not require a prior topic or an exact saving verb in every note', async t => {
    const vault = await fixture(t, {
        'Recent.md': '---\ncreated: "2026-10-27T12:00:00Z"\n---\n# Маяк\nИдея местного маяка.',
        'Old.md': '---\ncreated: "2026-09-01T12:00:00Z"\n---\n# Туризм\nПлан туристического маршрута.',
        'Instructions.md': '# Инструкции\nАгент должен сохранять данные в Telegram.',
    });
    const result = await vault.search('Что я сохранял?');
    assert.equal(result[0].path, 'Recent.md');
    assert.ok(result.every(note => note.path !== 'Instructions.md'));
});

test('personal activity recall quotes the original thought rather than an unsupported AI paraphrase', async t => {
    const vault = await fixture(t, {
        'Captured.md': [
            '---', 'shaikh_id: "synthetic"', 'created: "2026-10-27T12:00:00Z"', 'source: "telegram"', '---',
            '# Проверка Telegram', 'AI_PARAPHRASE_FIXTURE: проверка Telegram прошла с неизвестным заказчиком.',
            '', '## Исходная мысль', '', 'Проверка Telegram: сохранить эту мысль в Obsidian.',
            'Вторая строка исходной мысли тоже должна сохраниться в источнике.',
            '', '## Связанные мысли', '[[Другой проект]]',
        ].join('\n'),
    });
    const result = await vault.search('Что я проверял через Telegram?');
    assert.match(result[0].excerpt, /сохранить эту мысль в Obsidian/u);
    assert.match(result[0].excerpt, /Вторая строка/u);
    assert.doesNotMatch(result[0].excerpt, /AI_PARAPHRASE_FIXTURE|Другой проект/u);
});

test('captured thoughts prove saving without an explicit save verb but do not prove an AI-invented activity', async t => {
    const vault = await fixture(t, {
        'Captured.md': [
            '---', 'shaikh_id: "synthetic"', 'created: "2026-10-27T12:00:00Z"', 'source: "telegram"', '---',
            '# Маяк', 'Проверка проекта Маяк прошла успешно — это неподтверждённый AI-пересказ.',
            '', '## Исходная мысль', '', 'Я хочу построить проект Маяк для местных туристов.',
        ].join('\n'),
    });
    const saved = await vault.search('Что я сохранил о проекте Маяк?');
    assert.equal(saved[0].path, 'Captured.md');
    assert.match(saved[0].excerpt, /Я хочу построить/u);
    assert.doesNotMatch(saved[0].excerpt, /прошла успешно/u);
    assert.deepEqual(await vault.search('Что я проверял по проекту Маяк?'), []);
});

test('captured evidence carries trusted storage and channel facts without inflating query matching', async t => {
    const vault = await fixture(t, {
        'Captured.md': thought('Проверка Telegram: сохранить эту мысль в Obsidian.'),
        'Other-captured.md': [
            '---', 'shaikh_id: "another-synthetic"', 'source: "telegram"', '---',
            '# Туризм', '## Исходная мысль', 'Идея маяка для туристов.',
        ].join('\n'),
        'Manual.md': '# Telegram\nОбычная ручная заметка без метаданных источника.',
    });
    const selected = await vault.search('Что я проверял через Telegram?');
    assert.deepEqual(selected.map(note => note.path), ['Captured.md']);
    assert.match(selected[0].excerpt, /^Место сохранения: Obsidian\.\nКанал записи: Telegram\.\n/u);
    assert.match(selected[0].excerpt, /Исходная мысль:\nПроверка Telegram/u);
    assert.ok(selected[0].excerpt.length <= 2600);
    assert.ok(!(await vault.search('Telegram')).some(note => note.path === 'Other-captured.md'));
    const manual = await vault.search('Manual.md');
    assert.doesNotMatch(manual[0].excerpt, /Место сохранения:|Канал записи:/u);
});

test('invalid captured source metadata cannot add a claimed Telegram channel to an excerpt', async t => {
    const vault = await fixture(t, {
        'Invalid.md': '---\nshaikh_id: "synthetic"\nsource: "telegram\\nINJECTED_PROVENANCE"\n---\n# Маяк\n## Исходная мысль\nМаяк для туристов.',
        'Prototype.md': '---\nshaikh_id: "synthetic"\nsource: "constructor"\n---\n# Прототип\n## Исходная мысль\nИдея прототипа.',
        'Website.md': '---\nshaikh_id: "synthetic-web"\nsource: website\n---\n# План\n## Исходная мысль\nПлан на завтра.',
    });
    assert.doesNotMatch((await vault.search('Invalid.md'))[0].excerpt, /Место сохранения:|Канал записи:/u);
    assert.doesNotMatch((await vault.search('Prototype.md'))[0].excerpt, /Место сохранения:|Канал записи:/u);
    assert.match((await vault.search('Website.md'))[0].excerpt, /Канал записи: сайт\./u);
});
