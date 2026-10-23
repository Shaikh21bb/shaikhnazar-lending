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
    assert.match(worker, /const VERSION = 'shaikh-sys-v\d+-[A-Za-z0-9-]+'/);
    assert.match(worker, /'\/js\/transaction-csv\.js'/);
    assert.match(worker, /c\.put\(cacheKeyFor\(e\.request\), copy\)/);
    assert.doesNotMatch(worker, /return cached \|\| network/);
});

test('initial load uses focused aggregate calls and locked workflows route to setup', async () => {
    const script = await readProjectFile('js/hub.js');
    const loadAll = functionSource(script, 'loadAll');
    const submitChat = functionSource(script, 'submitChat');
    const prepareWorkflow = functionSource(script, 'prepareWorkflow');

    assert.match(loadAll, /const tasks = \[loadOverview\(\), loadConnections\(\), loadGoogleCalendarStatus\(\)\]/);
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
    const [html, script] = await Promise.all([
        readProjectFile('hub.html'),
        readProjectFile('js/hub.js')
    ]);
    const open = functionSource(script, 'openMobileForm');
    const events = functionSource(script, 'bindEvents');

    assert.match(html, /id="note-form-title"/);
    assert.match(html, /id="event-form-title"/);
    assert.match(html, /id="transaction-form-title"/);
    assert.match(html, /id="form-overlay"[^>]*aria-label="Закрыть форму"/);
    assert.match(open, /wrap\.setAttribute\('aria-modal', 'true'\)/);
    assert.match(open, /wrap\.setAttribute\('aria-labelledby', heading\.id\)/);
    assert.match(open, /setDialogBackgroundInert\(wrap, true\)/);
    assert.match(open, /wrap\.querySelector\('\.record-form input/);
    assert.match(open, /focus\(\{ preventScroll: true \}\)/);
    assert.match(events, /event\.key !== 'Tab'/);
    assert.match(events, /document\.activeElement === first/);
    assert.match(events, /document\.activeElement === last/);
    assert.match(events, /dom\.formOverlay\.addEventListener\('click'/);
});

test('chat failures keep one request id and expose explicit retry and edit recovery', async () => {
    const script = await readProjectFile('js/hub.js');
    const submit = functionSource(script, 'submitChat');
    const send = functionSource(script, 'sendChatRun');
    const recovery = functionSource(script, 'chatRunTemplate');
    const restore = functionSource(script, 'restoreChatSession');

    assert.match(script, /CHAT_DRAFT_STORAGE_KEY/);
    assert.match(script, /CHAT_RUN_STORAGE_KEY/);
    assert.match(submit, /const requestId = globalThis\.crypto\?\.randomUUID/);
    assert.match(submit, /persistChatRun\(run\)/);
    assert.match(send, /body: \{ message: run\.message, requestId: run\.requestId \}/);
    assert.match(send, /state\.chatRun = \{ \.\.\.run, status: 'error', error: error\.message \}/);
    assert.match(recovery, /class="chat-run-error" role="alert"/);
    assert.match(recovery, /data-chat-retry/);
    assert.match(recovery, /data-chat-edit/);
    assert.match(restore, /status: 'error'/);
    assert.doesNotMatch(send, /role: 'assistant'.*content: error\.message/);
});

test('Telegram waiting state polls, survives focus changes, and explains code expiry', async () => {
    const [html, script] = await Promise.all([
        readProjectFile('hub.html'),
        readProjectFile('js/hub.js')
    ]);
    const telegram = functionSource(script, 'renderTelegramConnection');
    const countdown = functionSource(script, 'updateTelegramCountdown');
    const polling = functionSource(script, 'scheduleTelegramPolling');
    const events = functionSource(script, 'bindEvents');

    assert.match(html, /id="telegram-link-status"[^>]*role="status"/);
    assert.match(html, /id="telegram-copy"/);
    assert.match(html, /id="telegram-check"/);
    assert.match(telegram, /Ожидает подтверждения/);
    assert.match(telegram, /scheduleTelegramPolling\(\)/);
    assert.match(countdown, /Срок действия кода истёк/);
    assert.match(countdown, /setInterval/);
    assert.match(polling, /TELEGRAM_POLL_INTERVAL/);
    assert.match(events, /visibilitychange/);
    assert.match(events, /refreshOnForeground/);
});

test('client-facing labels describe the implemented search, ledger, and language scope', async () => {
    const [html, css] = await Promise.all([
        readProjectFile('hub.html'),
        readProjectFile('css/hub.css')
    ]);

    assert.match(html, /по тексту и ключевым словам/);
    assert.doesNotMatch(html, /найти их по смыслу/);
    assert.match(html, /Учтённый баланс/);
    assert.match(html, /по записанным операциям/);
    assert.match(html, /Язык ответов/);
    assert.match(css, /--faint: #7f7f8c/);
    assert.doesNotMatch(css, /font-size:\s*0\.[0-6](?:[0-9])?rem/);
});

test('finance CSV import previews locally, blocks invalid rows, and refreshes the overview after confirmation', async () => {
    const [html, script] = await Promise.all([
        readProjectFile('hub.html'),
        readProjectFile('js/hub.js')
    ]);
    const preview = functionSource(script, 'renderTransactionCsvImport');
    const select = functionSource(script, 'selectTransactionCsv');
    const submit = functionSource(script, 'submitTransactionCsvImport');
    const template = functionSource(script, 'downloadTransactionCsvTemplate');

    assert.match(script, /import \{ MAX_FILE_BYTES, parseTransactionCsv \} from '\.\/transaction-csv\.js'/);
    assert.match(html, /id="transaction-csv-file"[^>]*accept="\.csv,text\/csv,text\/plain"/);
    assert.match(html, /id="transaction-csv-preview"/);
    assert.match(html, /id="transaction-csv-submit"[^>]*disabled/);
    assert.match(html, /Файл сначала проверяется только в браузере/);
    assert.match(select, /if \(file\.size > MAX_FILE_BYTES\)/);
    assert.match(select, /parseTransactionCsv\(await file\.text\(\)\)/);
    assert.doesNotMatch(select, /api\(/);
    assert.match(preview, /current\.errors\.length === 0/);
    assert.match(preview, /пока файл не будет отправлен/);
    assert.match(submit, /api\('\/import', \{ method: 'POST', body: \{ action: 'transaction_csv', rows \} \}\)/);
    assert.match(submit, /await loadOverview\(\)/);
    assert.match(template, /shaikh-finance-template\.csv/);
});

test('Google Calendar card distinguishes setup, connection, sync, disconnect, and OAuth return states', async () => {
    const [html, script] = await Promise.all([
        readProjectFile('hub.html'),
        readProjectFile('js/hub.js')
    ]);
    const render = functionSource(script, 'renderGoogleCalendarConnection');
    const oauthReturn = functionSource(script, 'consumeGoogleCalendarReturn');
    const connect = functionSource(script, 'connectGoogleCalendar');
    const sync = functionSource(script, 'syncGoogleCalendar');
    const disconnect = functionSource(script, 'disconnectGoogleCalendar');

    assert.match(html, /id="google-calendar-state"/);
    assert.match(html, /id="google-calendar-connect"/);
    assert.match(html, /id="google-calendar-sync"/);
    assert.match(html, /id="google-calendar-disconnect"/);
    assert.match(html, /Только события календаря · без почты, файлов и контактов/);
    assert.match(script, /await api\('\/google-calendar'\)/);
    assert.match(render, /status\.configured/);
    assert.match(render, /status\.connected/);
    assert.match(render, /reconnectRequired/);
    assert.match(render, /Нужна настройка/);
    assert.match(connect, /window\.location\.assign\(`\$\{API_ROOT\}\/google-calendar\/start`\)/);
    assert.match(sync, /body: \{ action: 'sync' \}/);
    assert.match(disconnect, /body: \{ action: 'disconnect' \}/);
    assert.match(oauthReturn, /\['connected', 'error', 'setup_required'\]/);
    assert.match(oauthReturn, /url\.searchParams\.delete\('google'\)/);
});
