import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readProjectFile = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function functionSource(source, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} must exist`);
    const next = source.indexOf('\nfunction ', start + 1);
    return source.slice(start, next === -1 ? source.length : next);
}

test('Agent Hub exposes activation steps, result-first recipes, and role presets', async () => {
    const [html, script] = await Promise.all([
        readProjectFile('hub.html'),
        readProjectFile('js/hub.js')
    ]);

    assert.match(html, /id="activation-panel"/);
    assert.match(html, /id="activation-progress"/);
    assert.match(html, /id="activation-steps"/);

    const workflows = [...html.matchAll(/<button\s+class="workflow-card"[^>]*\bdata-workflow\b[^>]*\bdata-prompt="[^"]+"/g)];
    assert.equal(workflows.length, 6);
    assert.match(html, /Сохранить мысль/);
    assert.match(html, /Учесть расход/);
    assert.match(html, /Собрать план дня/);
    assert.match(html, /Обзор недели/);

    const presets = [...html.matchAll(/data-agent-preset="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(presets, ['personal', 'business', 'content', 'study']);
    assert.match(html, /<select name="language" id="profile-language">/);

    const activation = functionSource(script, 'renderActivation');
    assert.match(activation, /label: 'Выберите роль'/);
    assert.match(activation, /label: 'Подключите AI'/);
    assert.match(activation, /label: 'Запустите сценарий'/);
});

test('history copy is honest and action receipts remain navigable buttons', async () => {
    const [html, script] = await Promise.all([
        readProjectFile('hub.html'),
        readProjectFile('js/hub.js')
    ]);

    assert.match(html, /id="clear-chat-button"[^>]*>Скрыть историю<\/button>/);
    assert.doesNotMatch(html, /id="clear-chat-button"[^>]*>Очистить/);
    assert.match(script, /state\.hiddenHistory = true/);
    assert.match(script, /История появится после нового сообщения или обновления страницы/);
    assert.match(html, /id="chat-lock-cta"/);

    const messages = functionSource(script, 'messageTemplate');
    assert.match(messages, /<button class="action-chip" type="button" data-result-view="\$\{target\}"/);
    assert.match(messages, /message\.channel === 'telegram' \? 'Telegram' : 'Сайт'/);

    const labels = functionSource(script, 'actionLabel');
    assert.match(labels, /list_notes: 'Заметки найдены'/);
    assert.match(labels, /list_events: 'Планы показаны'/);
    assert.match(labels, /finance_summary: 'Финансы рассчитаны'/);
});

test('Hub cache-busting versions stay aligned', async () => {
    const [html, worker] = await Promise.all([
        readProjectFile('hub.html'),
        readProjectFile('sw.js')
    ]);

    const cssVersion = html.match(/css\/hub\.css\?v=([A-Za-z0-9_-]+)/)?.[1];
    const jsVersion = html.match(/js\/hub\.js\?v=([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(cssVersion, 'hub.css must have a cache-busting version');
    assert.equal(jsVersion, cssVersion);
    assert.match(worker, /const VERSION = 'shaikh-sys-v12-agent-hub'/);
    assert.match(worker, /c\.put\(cacheKeyFor\(e\.request\), copy\)/);
    assert.doesNotMatch(worker, /return cached \|\| network/);
});

test('initial load uses two aggregate calls and locked workflows route to setup', async () => {
    const script = await readProjectFile('js/hub.js');
    const loadAll = functionSource(script, 'loadAll');
    const submitChat = functionSource(script, 'submitChat');
    const prepareWorkflow = functionSource(script, 'prepareWorkflow');

    assert.match(loadAll, /const tasks = \[loadOverview\(\), loadConnections\(\)\]/);
    assert.doesNotMatch(loadAll, /loadRecords\(/);
    assert.match(loadAll, /dom\.notesSearch\.value = ''/);

    assert.match(submitChat, /if \(!activationState\(\)\.aiReady\) \{\s*openSetupTarget\('openrouter-card'\)/);
    assert.match(prepareWorkflow, /if \(!activationState\(\)\.aiReady\) \{\s*openSetupTarget\('openrouter-card'\)/);
    assert.match(prepareWorkflow, /dom\.chatInput\.value = prompt/);
});

test('loading buttons restore their original icon markup', async () => {
    const script = await readProjectFile('js/hub.js');
    const loading = functionSource(script, 'setButtonLoading');

    assert.match(loading, /button\.dataset\.previousMarkup = button\.innerHTML/);
    assert.match(loading, /button\.innerHTML = button\.dataset\.previousMarkup/);
    assert.match(loading, /delete button\.dataset\.previousMarkup/);
});

test('older records remain reachable through search, pagination, and calendar history', async () => {
    const [html, script] = await Promise.all([
        readProjectFile('hub.html'),
        readProjectFile('js/hub.js')
    ]);

    assert.match(html, /id="event-filter"/);
    assert.match(html, /<option value="past">Прошедшие<\/option>/);
    assert.match(html, /последних заметок, ближайших событий и расходов за последние 7 дней/);
    assert.doesNotMatch(html, /заметок, событий и расходов за последние 7 дней/);

    const records = functionSource(script, 'loadRecords');
    assert.match(records, /new URLSearchParams\(\{ kind, limit: String\(limit\), offset: String\(offset\) \}\)/);
    assert.match(records, /query\.set\('search', searchTerm\)/);
    assert.match(records, /eventMode = kind === 'event'/);
    assert.match(records, /page !== state\.paging\[kind\]/);
    assert.match(records, /eventMode !== state\.eventMode/);
    assert.match(script, /data-load-more="\$\{kind\}"/);
    assert.match(script, /state\.eventMode = dom\.eventFilter\.value === 'past' \? 'past' : 'upcoming'/);
});

test('dashboard metrics stay independent from filtered record views', async () => {
    const script = await readProjectFile('js/hub.js');
    const today = functionSource(script, 'renderToday');
    const activation = functionSource(script, 'activationState');

    assert.match(today, /state\.dashboardRecords\.event/);
    assert.match(today, /state\.dashboardRecords\.transaction/);
    assert.match(today, /state\.dashboardRecords\.note/);
    assert.doesNotMatch(today, /state\.records\./);
    assert.match(activation, /state\.dashboardRecords\.note\.length/);
});

test('mobile record sheets move and contain keyboard focus', async () => {
    const script = await readProjectFile('js/hub.js');
    const open = functionSource(script, 'openMobileForm');
    const events = functionSource(script, 'bindEvents');

    assert.match(open, /wrap\.setAttribute\('aria-modal', 'true'\)/);
    assert.match(open, /wrap\.querySelector\('\.record-form input/);
    assert.match(open, /focus\(\{ preventScroll: true \}\)/);
    assert.match(events, /event\.key !== 'Tab'/);
    assert.match(events, /document\.activeElement === first/);
    assert.match(events, /document\.activeElement === last/);
});
