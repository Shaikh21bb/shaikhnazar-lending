import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SECRET = 'google-calendar-test-auth-secret-that-is-long-enough';
process.env.PUBLIC_SITE_URL = 'https://shaikh.digital';
process.env.CREDENTIALS_ENCRYPTION_KEY = 'google-calendar-test-encryption-key-that-is-long-enough';
process.env.SUPABASE_URL = 'https://calendar-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'calendar-test-service-role';

const {
    beginGoogleCalendarAuth,
    finishGoogleCalendarAuth,
    googleCalendarConfigured,
    importGoogleCalendar,
    syncGoogleCalendar,
    syncGoogleCalendarEvent
} = await import('../server/api/_agent/google-calendar.js');
const { decryptCredential, encryptCredential } = await import('../server/api/_credentials.js');

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';

function response() {
    return {
        headers: {},
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
        send(value) { this.body = value; return this; }
    };
}

test('Google Calendar OAuth requests offline event-only access with PKCE', async () => {
    const previousId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
    const previousSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    try {
        process.env.GOOGLE_CALENDAR_CLIENT_ID = 'calendar-client.apps.googleusercontent.com';
        process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 'calendar-client-secret';
        const res = response();
        await beginGoogleCalendarAuth(
            { headers: { host: 'shaikh.digital' } },
            res,
            { sub: ACCOUNT_ID },
            { id: AGENT_ID }
        );
        assert.equal(res.statusCode, 302);
        const location = new URL(res.headers.location);
        assert.equal(location.origin, 'https://accounts.google.com');
        assert.equal(location.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar.events');
        assert.equal(location.searchParams.get('access_type'), 'offline');
        assert.equal(location.searchParams.get('prompt'), 'consent');
        assert.equal(location.searchParams.has('include_granted_scopes'), false);
        assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
        assert.ok(location.searchParams.get('code_challenge'));
        assert.ok(location.searchParams.get('state'));
        assert.match(res.headers['set-cookie'], /HttpOnly/);
        assert.match(res.headers['set-cookie'], /SameSite=Lax/);
        assert.doesNotMatch(res.headers.location, /calendar-client-secret/);
    } finally {
        if (previousId === undefined) delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
        else process.env.GOOGLE_CALENDAR_CLIENT_ID = previousId;
        if (previousSecret === undefined) delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
        else process.env.GOOGLE_CALENDAR_CLIENT_SECRET = previousSecret;
    }
});

test('Google Calendar stays honestly unavailable until owner credentials exist', async () => {
    const previousId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
    const previousSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    try {
        delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
        delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
        assert.equal(googleCalendarConfigured(), false);
        const res = response();
        await beginGoogleCalendarAuth(
            { headers: { host: 'shaikh.digital' } },
            res,
            { sub: ACCOUNT_ID },
            { id: AGENT_ID }
        );
        assert.equal(res.statusCode, 302);
        assert.equal(res.headers.location, '/hub.html?google=setup_required#connections');
        assert.equal(res.headers['set-cookie'], undefined);
    } finally {
        if (previousId === undefined) delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
        else process.env.GOOGLE_CALENDAR_CLIENT_ID = previousId;
        if (previousSecret === undefined) delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
        else process.env.GOOGLE_CALENDAR_CLIENT_SECRET = previousSecret;
    }
});

async function oauthAttempt() {
    const res = response();
    await beginGoogleCalendarAuth(
        { headers: { host: 'shaikh.digital' } },
        res,
        { sub: ACCOUNT_ID },
        { id: AGENT_ID }
    );
    const location = new URL(res.headers.location);
    return {
        cookie: res.headers['set-cookie'].split(';', 1)[0],
        state: location.searchParams.get('state')
    };
}

test('OAuth callback is bound to both the signed-in account and current agent', async () => {
    process.env.GOOGLE_CALENDAR_CLIENT_ID = 'calendar-client.apps.googleusercontent.com';
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 'calendar-client-secret';
    const attempt = await oauthAttempt();
    const originalFetch = global.fetch;
    let fetches = 0;
    global.fetch = async () => {
        fetches += 1;
        throw new Error('Callback must fail before an outbound request');
    };
    try {
        const res = response();
        await finishGoogleCalendarAuth({
            headers: { cookie: attempt.cookie },
            query: { code: 'authorization-code', state: attempt.state }
        }, res, { sub: ACCOUNT_ID }, { id: '33333333-3333-4333-8333-333333333333' });
        assert.equal(res.statusCode, 302);
        assert.match(res.headers.location, /google=error/);
        assert.equal(fetches, 0);

        const malformed = response();
        await finishGoogleCalendarAuth({
            headers: { cookie: 'shaikh_google_calendar_oauth=%E0%A4%A' },
            query: { code: 'authorization-code', state: attempt.state }
        }, malformed, { sub: ACCOUNT_ID }, { id: AGENT_ID });
        assert.match(malformed.headers.location, /google=error/);
        assert.equal(fetches, 0);
    } finally {
        global.fetch = originalFetch;
    }
});

test('OAuth callback exchanges PKCE server-side and stores only encrypted narrow-scope tokens', async () => {
    process.env.GOOGLE_CALENDAR_CLIENT_ID = 'calendar-client.apps.googleusercontent.com';
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 'calendar-client-secret';
    const attempt = await oauthAttempt();
    const originalFetch = global.fetch;
    let tokenRequestBody;
    let savedRow;
    global.fetch = async (url, options = {}) => {
        const href = String(url);
        if (href === 'https://oauth2.googleapis.com/token') {
            tokenRequestBody = new URLSearchParams(options.body);
            return new Response(JSON.stringify({
                access_token: 'google-access-token',
                refresh_token: 'google-refresh-token',
                expires_in: 3600,
                token_type: 'Bearer',
                scope: 'https://www.googleapis.com/auth/calendar.events'
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (href.includes('/rest/v1/personal_agent_secrets?on_conflict=')) {
            savedRow = JSON.parse(options.body);
            assert.equal(options.headers.Authorization, 'Bearer calendar-test-service-role');
            return new Response('', { status: 201 });
        }
        throw new Error(`Unexpected request: ${href}`);
    };
    try {
        const res = response();
        await finishGoogleCalendarAuth({
            headers: { cookie: attempt.cookie },
            query: { code: 'authorization-code', state: attempt.state }
        }, res, { sub: ACCOUNT_ID }, { id: AGENT_ID });
        assert.match(res.headers.location, /google=connected/);
        assert.equal(tokenRequestBody.get('client_secret'), 'calendar-client-secret');
        assert.equal(tokenRequestBody.get('grant_type'), 'authorization_code');
        assert.ok(tokenRequestBody.get('code_verifier'));
        assert.equal(savedRow.agent_id, AGENT_ID);
        assert.equal(savedRow.provider, 'google_calendar');
        assert.doesNotMatch(savedRow.secret_box, /google-(?:access|refresh)-token/);
        const stored = JSON.parse(decryptCredential(AGENT_ID, 'google_calendar', savedRow.secret_box));
        assert.equal(stored.accessToken, 'google-access-token');
        assert.equal(stored.refreshToken, 'google-refresh-token');
        assert.equal(stored.scope, 'https://www.googleapis.com/auth/calendar.events');
    } finally {
        global.fetch = originalFetch;
    }
});

test('OAuth callback rejects and revokes a grant with broader scopes', async () => {
    process.env.GOOGLE_CALENDAR_CLIENT_ID = 'calendar-client.apps.googleusercontent.com';
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 'calendar-client-secret';
    const attempt = await oauthAttempt();
    const originalFetch = global.fetch;
    const originalConsoleError = console.error;
    let revokedToken = '';
    let databaseWrites = 0;
    global.fetch = async (url, options = {}) => {
        const href = String(url);
        if (href === 'https://oauth2.googleapis.com/token') {
            return new Response(JSON.stringify({
                access_token: 'broad-access-token',
                refresh_token: 'broad-refresh-token',
                expires_in: 3600,
                scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive'
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (href === 'https://oauth2.googleapis.com/revoke') {
            revokedToken = new URLSearchParams(options.body).get('token');
            return new Response('', { status: 200 });
        }
        databaseWrites += 1;
        throw new Error(`Unexpected request: ${href}`);
    };
    console.error = () => {};
    try {
        const res = response();
        await finishGoogleCalendarAuth({
            headers: { cookie: attempt.cookie },
            query: { code: 'authorization-code', state: attempt.state }
        }, res, { sub: ACCOUNT_ID }, { id: AGENT_ID });
        assert.match(res.headers.location, /google=error/);
        assert.equal(revokedToken, 'broad-refresh-token');
        assert.equal(databaseWrites, 0);
    } finally {
        global.fetch = originalFetch;
        console.error = originalConsoleError;
    }
});

function storedGoogleSecret() {
    return encryptCredential(AGENT_ID, 'google_calendar', JSON.stringify({
        accessToken: 'stored-google-access',
        refreshToken: 'stored-google-refresh',
        expiresAt: Date.now() + 60 * 60 * 1000,
        tokenType: 'Bearer',
        scope: 'https://www.googleapis.com/auth/calendar.events'
    }));
}

test('calendar import is tenant-scoped, bounded, duplicate-aware, and preserves all-day semantics', async () => {
    const originalFetch = global.fetch;
    let upsertRows = [];
    let existingRows = [];
    let upsertCalls = 0;
    let remoteStatus = 'confirmed';
    let deletePatch = null;
    let googleUrl;
    global.fetch = async (url, options = {}) => {
        const href = String(url);
        if (href.includes('/rest/v1/personal_agent_secrets?select=')) {
            assert.match(href, new RegExp(`agent_id=eq\\.${AGENT_ID}`));
            return new Response(JSON.stringify([{ secret_box: storedGoogleSecret(), updated_at: new Date().toISOString() }]), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        if (href.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events?')) {
            googleUrl = new URL(href);
            return new Response(JSON.stringify({
                items: [{
                    id: 'all-day-event',
                    status: remoteStatus,
                    summary: 'All day',
                    description: 'Remote description',
                    htmlLink: 'javascript:alert(1)',
                    start: { date: '2026-11-05' },
                    end: { date: '2026-11-06' }
                }]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (href.includes('/rest/v1/personal_agent_records?select=*')) {
            assert.match(href, new RegExp(`agent_id=eq\\.${AGENT_ID}`));
            return new Response(JSON.stringify(existingRows), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (href.includes('/rest/v1/personal_agent_records?on_conflict=')) {
            upsertRows = JSON.parse(options.body);
            upsertCalls += 1;
            existingRows = upsertRows.map((row, index) => ({
                id: `55555555-5555-4555-8555-${String(index + 1).padStart(12, '0')}`,
                ...row
            }));
            return new Response('', { status: 201 });
        }
        if (href.includes('/rest/v1/personal_agent_records?agent_id=eq.') && options.method === 'PATCH') {
            deletePatch = JSON.parse(options.body);
            return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${href}`);
    };
    try {
        const result = await importGoogleCalendar(AGENT_ID);
        assert.equal(result.imported, 1);
        assert.equal(result.updated, 0);
        assert.equal(result.truncated, false);
        assert.equal(googleUrl.origin, 'https://www.googleapis.com');
        assert.equal(googleUrl.searchParams.get('maxResults'), '250');
        assert.equal(googleUrl.searchParams.get('showDeleted'), 'true');
        assert.ok(googleUrl.searchParams.get('timeMin'));
        assert.ok(googleUrl.searchParams.get('timeMax'));
        assert.equal(upsertRows[0].agent_id, AGENT_ID);
        assert.equal(upsertRows[0].metadata.googleCalendar.allDay, true);
        assert.equal(upsertRows[0].metadata.googleCalendar.startDate, '2026-11-05');
        assert.equal(upsertRows[0].metadata.googleCalendar.endDate, '2026-11-06');
        assert.equal(upsertRows[0].metadata.googleCalendar.htmlLink, null);
        assert.match(upsertRows[0].metadata.googleCalendar.contentHash, /^[a-f0-9]{64}$/);
        assert.match(upsertRows[0].source_message_key, /^google:[a-f0-9]{64}$/);

        const repeated = await importGoogleCalendar(AGENT_ID);
        assert.equal(repeated.imported, 0);
        assert.equal(repeated.updated, 1);
        assert.equal(upsertCalls, 2);

        existingRows[0].title = 'Unsynced local edit';
        const localWins = await importGoogleCalendar(AGENT_ID);
        assert.equal(localWins.imported, 0);
        assert.equal(localWins.updated, 0);
        assert.equal(localWins.skippedLocalChanges, 1);
        assert.equal(upsertCalls, 2);

        existingRows[0].title = 'All day';
        remoteStatus = 'cancelled';
        const cancelled = await importGoogleCalendar(AGENT_ID);
        assert.equal(cancelled.deleted, 1);
        assert.equal(deletePatch.status, 'deleted');
    } finally {
        global.fetch = originalFetch;
    }
});

test('an invalid refresh grant removes the unusable local credential and requests reconnect', async () => {
    process.env.GOOGLE_CALENDAR_CLIENT_ID = 'calendar-client.apps.googleusercontent.com';
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 'calendar-client-secret';
    const expiredSecret = encryptCredential(AGENT_ID, 'google_calendar', JSON.stringify({
        accessToken: 'expired-google-access',
        refreshToken: 'revoked-google-refresh',
        expiresAt: Date.now() - 1,
        tokenType: 'Bearer',
        scope: 'https://www.googleapis.com/auth/calendar.events'
    }));
    const originalFetch = global.fetch;
    let deletes = 0;
    global.fetch = async (url, options = {}) => {
        const href = String(url);
        if (href.includes('/rest/v1/personal_agent_secrets?select=')) {
            return new Response(JSON.stringify([{ secret_box: expiredSecret, updated_at: new Date().toISOString() }]), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        if (href === 'https://oauth2.googleapis.com/token') {
            assert.equal(new URLSearchParams(options.body).get('refresh_token'), 'revoked-google-refresh');
            return new Response(JSON.stringify({ error: 'invalid_grant' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        if (href.includes('/rest/v1/personal_agent_secrets?agent_id=eq.')) {
            assert.equal(options.method, 'DELETE');
            deletes += 1;
            return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${href}`);
    };
    try {
        const record = {
            id: '66666666-6666-4666-8666-666666666666',
            agent_id: AGENT_ID,
            kind: 'event',
            status: 'active',
            title: 'Needs refresh',
            body: '',
            event_at: '2026-11-05T10:00:00.000Z',
            metadata: {}
        };
        await assert.rejects(
            syncGoogleCalendarEvent(AGENT_ID, record),
            error => error.status === 409 && /заново/.test(error.message)
        );
        assert.equal(deletes, 1);
    } finally {
        global.fetch = originalFetch;
    }
});

test('Google-originated all-day updates stay all-day and cannot redirect Calendar requests', async () => {
    const originalFetch = global.fetch;
    let googleRequest;
    global.fetch = async (url, options = {}) => {
        const href = String(url);
        if (href.includes('/rest/v1/personal_agent_secrets?select=')) {
            return new Response(JSON.stringify([{ secret_box: storedGoogleSecret(), updated_at: new Date().toISOString() }]), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        if (href.startsWith('https://www.googleapis.com/calendar/v3/')) {
            googleRequest = { url: new URL(href), options };
            return new Response(JSON.stringify({ id: '../../hostile?id=1', htmlLink: 'https://calendar.google.com/calendar/event?eid=safe' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        if (href.includes('/rest/v1/personal_agent_records?id=eq.')) {
            return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${href}`);
    };
    try {
        const record = {
            id: '44444444-4444-4444-8444-444444444444',
            agent_id: AGENT_ID,
            kind: 'event',
            status: 'active',
            title: 'Updated all-day event',
            body: '',
            event_at: '2026-11-06T04:00:00.000Z',
            metadata: {
                googleCalendar: {
                    origin: 'google',
                    eventId: '../../hostile?id=1',
                    allDay: true,
                    startDate: '2026-11-05',
                    endDate: '2026-11-06'
                }
            }
        };
        await syncGoogleCalendarEvent(AGENT_ID, record);
        assert.equal(googleRequest.url.origin, 'https://www.googleapis.com');
        assert.match(googleRequest.url.pathname, /events\/\.\.%2F\.\.%2Fhostile%3Fid%3D1$/);
        assert.equal(googleRequest.url.search, '');
        const body = JSON.parse(googleRequest.options.body);
        assert.deepEqual(body.start, { date: '2026-11-06' });
        assert.deepEqual(body.end, { date: '2026-11-07' });
        assert.equal(body.extendedProperties, undefined);
    } finally {
        global.fetch = originalFetch;
    }
});

test('bounded sync propagates a tenant-owned local deletion once and marks it complete', async () => {
    const originalFetch = global.fetch;
    const deletedRecord = {
        id: '77777777-7777-4777-8777-777777777777',
        agent_id: AGENT_ID,
        kind: 'event',
        status: 'deleted',
        title: 'Deleted locally',
        body: '',
        event_at: '2026-11-05T10:00:00.000Z',
        metadata: { googleCalendar: { eventId: 'google-event-to-delete', origin: 'google' } }
    };
    let remoteDeletes = 0;
    let removalMetadata;
    global.fetch = async (url, options = {}) => {
        const href = String(url);
        if (href.includes('/rest/v1/personal_agent_secrets?select=')) {
            return new Response(JSON.stringify([{ secret_box: storedGoogleSecret(), updated_at: new Date().toISOString() }]), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        if (href.includes('/rest/v1/personal_agent_records?select=*') && href.includes('kind=eq.event')) {
            return new Response(JSON.stringify([deletedRecord]), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        if (href === 'https://www.googleapis.com/calendar/v3/calendars/primary/events/google-event-to-delete') {
            assert.equal(options.method, 'DELETE');
            remoteDeletes += 1;
            return new Response(null, { status: 204 });
        }
        if (href.includes('/rest/v1/personal_agent_records?id=eq.')) {
            removalMetadata = JSON.parse(options.body).metadata.googleCalendar;
            return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${href}`);
    };
    try {
        const result = await syncGoogleCalendar(AGENT_ID);
        assert.equal(result.ok, true);
        assert.equal(result.removed, 1);
        assert.equal(result.synced, 0);
        assert.equal(remoteDeletes, 1);
        assert.ok(removalMetadata.removedAt);
    } finally {
        global.fetch = originalFetch;
    }
});
