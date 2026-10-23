import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readProjectFile = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('login identifies the private Agent Hub in Russian and Kazakh', async () => {
    const login = await readProjectFile('login.html');

    assert.match(login, /Вход в SHAIKH Agent Hub/);
    assert.match(login, /Закрытый клиентский кабинет/);
    assert.match(login, /SHAIKH Agent Hub жүйесіне кіру/);
    assert.match(login, /Жабық клиенттік кабинетіңіз/);
    assert.match(login, /document\.documentElement\.lang = lang/);
});

test('service worker normalizes versioned same-origin CSS and JS cache keys', async () => {
    const worker = await readProjectFile('sw.js');

    assert.match(worker, /const VERSION = 'shaikh-sys-v\d+-[A-Za-z0-9-]+'/);
    assert.match(worker, /'\/js\/transaction-csv\.js'/);
    assert.match(worker, /function cacheKeyFor\(request\)/);
    assert.match(worker, /url\.pathname\.startsWith\('\/css\/'\)/);
    assert.match(worker, /url\.pathname\.startsWith\('\/js\/'\)/);
    assert.match(worker, /url\.search = ''/);
    assert.match(worker, /c\.put\(cacheKeyFor\(e\.request\), copy\)/);
    assert.equal((worker.match(/if \(res\.ok\)/g) || []).length, 2);
});

test('legacy dashboard uses the authenticated server facade without a public database key', async () => {
    const [client, dashboard, login] = await Promise.all([
        readProjectFile('js/supabase.js'),
        readProjectFile('dashboard.html'),
        readProjectFile('login.html')
    ]);

    assert.match(client, /fetch\('\/api\/legacy\/data'/);
    assert.match(client, /credentials: 'same-origin'/);
    assert.doesNotMatch(client, /sb_publishable_|supabase\.createClient|SUPABASE_KEY/);
    assert.doesNotMatch(dashboard, /@supabase\/supabase-js/);
    assert.doesNotMatch(login, /@supabase\/supabase-js|js\/supabase\.js/);
});
