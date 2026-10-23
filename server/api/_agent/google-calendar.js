import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '../_lib.js';
import { decryptCredential, encryptCredential } from '../_credentials.js';

const PROVIDER = 'google_calendar';
const OAUTH_COOKIE = 'shaikh_google_calendar_oauth';
const OAUTH_TTL_SECONDS = 10 * 60;
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const GOOGLE_FETCH_TIMEOUT_MS = 8_000;
const GOOGLE_SYNC_BATCH_SIZE = 5;
const GOOGLE_SYNC_LIMIT = 5;
const GOOGLE_IMPORT_PAGE_SIZE = 250;
const GOOGLE_IMPORT_PAGE_LIMIT = 2;
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const encoded = value => encodeURIComponent(String(value));

function clean(value, limit = 4000) {
    return String(value ?? '').trim().slice(0, limit);
}

function oauthConfig() {
    return {
        clientId: clean(process.env.GOOGLE_CALENDAR_CLIENT_ID, 512),
        clientSecret: clean(process.env.GOOGLE_CALENDAR_CLIENT_SECRET, 512)
    };
}

function oauthSigningSecret() {
    const secret = clean(process.env.AUTH_SECRET, 4096);
    if (secret.length < 32) throw failure('AUTH_SECRET не настроен для Google Calendar.', 503);
    return secret;
}

function requestOrigin(req) {
    const configured = clean(process.env.PUBLIC_SITE_URL, 2048);
    if (configured) {
        try {
            const url = new URL(configured);
            if ((process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV) && url.protocol !== 'https:') {
                throw new Error('HTTPS required');
            }
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid origin');
            return url.origin;
        } catch {
            throw failure('PUBLIC_SITE_URL настроен неверно.', 503);
        }
    }

    // Never derive a production OAuth redirect from proxy-controlled headers.
    // Local fallback exists only to keep explicit localhost development usable.
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV) {
        throw failure('PUBLIC_SITE_URL не настроен для Google Calendar.', 503);
    }
    const host = req.headers?.['x-forwarded-host'] || req.headers?.host;
    const protocol = req.headers?.['x-forwarded-proto'] || (process.env.NODE_ENV === 'production' ? 'https' : 'http');
    if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host) || !['http', 'https'].includes(protocol)) {
        throw failure('Публичный адрес сайта недоступен.', 503);
    }
    return `${protocol}://${host}`;
}

function redirectUri(req) {
    return `${requestOrigin(req)}/api/hub/google-calendar/callback`;
}

function parseCookies(header = '') {
    return Object.fromEntries(String(header).split(';').map(part => {
        const index = part.indexOf('=');
        if (index < 0) return ['', ''];
        const key = part.slice(0, index).trim();
        try {
            return [key, decodeURIComponent(part.slice(index + 1).trim())];
        } catch {
            return [key, ''];
        }
    }).filter(([key]) => key));
}

function scopeSet(value) {
    const raw = String(value ?? '').trim();
    if (raw.length > 4000) return new Set(['invalid-scope-list']);
    return new Set(raw.split(/\s+/).filter(Boolean));
}

function hasOnlyCalendarScope(value) {
    const scopes = scopeSet(value);
    return scopes.size === 0 || (scopes.size === 1 && scopes.has(GOOGLE_SCOPE));
}

function safeGoogleCalendarLink(value) {
    try {
        const url = new URL(clean(value, 2048));
        if (url.protocol !== 'https:' || url.username || url.password
            || !(url.hostname === 'google.com' || url.hostname.endsWith('.google.com'))) return null;
        return url.toString();
    } catch {
        return null;
    }
}

function sign(value) {
    return createHmac('sha256', oauthSigningSecret()).update(value).digest('base64url');
}

function signedEnvelope(value) {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${payload}.${sign(payload)}`;
}

function readEnvelope(raw) {
    const [payload, signature, ...extra] = clean(raw, 8000).split('.');
    if (!payload || !signature || extra.length) return null;
    const expected = Buffer.from(sign(payload));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
    try {
        const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!value.exp || value.exp <= Math.floor(Date.now() / 1000)) return null;
        return value;
    } catch {
        return null;
    }
}

function oauthCookie(value, maxAge = OAUTH_TTL_SECONDS) {
    const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV ? '; Secure' : '';
    return `${OAUTH_COOKIE}=${encodeURIComponent(value)}; Path=/api/hub/google-calendar/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function sendRedirect(res, location) {
    res.statusCode = 302;
    res.setHeader('Location', location);
    if (typeof res.send === 'function') return res.send('');
    return res.end?.('');
}

async function secretRow(agentId) {
    const result = await db(
        `personal_agent_secrets?select=secret_box,updated_at&agent_id=eq.${encoded(agentId)}&provider=eq.${PROVIDER}&limit=1`
    );
    if (!result.res.ok) throw failure('Статус Google Calendar временно недоступен.', 503);
    return result.body?.[0] || null;
}

function decodeTokenRow(agentId, row, { validateScope = true } = {}) {
    const tokens = JSON.parse(decryptCredential(agentId, PROVIDER, row.secret_box));
    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) throw new Error('Invalid token payload');
    const normalized = {
        accessToken: clean(tokens.accessToken, 4096),
        refreshToken: clean(tokens.refreshToken, 4096),
        expiresAt: Number(tokens.expiresAt) || 0,
        tokenType: 'Bearer',
        scope: clean(tokens.scope || GOOGLE_SCOPE, 2000),
        updatedAt: row.updated_at
    };
    if ((!normalized.accessToken && !normalized.refreshToken)
        || (validateScope && !hasOnlyCalendarScope(normalized.scope))) {
        throw new Error('Invalid token payload');
    }
    return normalized;
}

async function readTokens(agentId, { required = true } = {}) {
    const row = await secretRow(agentId);
    if (!row) {
        if (required) throw failure('Сначала подключите Google Calendar.', 409);
        return null;
    }
    try {
        return decodeTokenRow(agentId, row);
    } catch {
        throw failure('Подключение Google Calendar повреждено. Подключите его заново.', 409);
    }
}

async function saveTokens(agentId, tokens) {
    const safeTokens = {
        accessToken: clean(tokens.accessToken, 4096),
        refreshToken: clean(tokens.refreshToken, 4096),
        expiresAt: Number(tokens.expiresAt) || 0,
        tokenType: 'Bearer',
        scope: clean(tokens.scope || GOOGLE_SCOPE, 2000)
    };
    if ((!safeTokens.accessToken && !safeTokens.refreshToken) || !hasOnlyCalendarScope(safeTokens.scope)) {
        throw failure('Google не предоставил безопасный доступ к событиям календаря.', 502);
    }
    const result = await db('personal_agent_secrets?on_conflict=agent_id,provider', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
            agent_id: agentId,
            provider: PROVIDER,
            secret_box: encryptCredential(agentId, PROVIDER, JSON.stringify(safeTokens)),
            key_version: 1,
            last_four: 'OAuth',
            updated_at: new Date().toISOString()
        })
    });
    if (!result.res.ok) throw failure('Не удалось сохранить подключение Google Calendar.', 503);
    return safeTokens;
}

async function deleteTokens(agentId) {
    const result = await db(
        `personal_agent_secrets?agent_id=eq.${encoded(agentId)}&provider=eq.${PROVIDER}`,
        { method: 'DELETE' }
    );
    if (!result.res.ok) throw failure('Не удалось отключить Google Calendar.', 503);
}

async function revokeGoogleToken(token) {
    if (!token) return null;
    try {
        const response = await fetch(GOOGLE_REVOKE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token }),
            signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS)
        });
        // Google's endpoint returns 400 for an already-invalid token. In both
        // cases the credential can no longer authorize Calendar requests.
        return response.ok || response.status === 400;
    } catch {
        return false;
    }
}

function tokenPayload(data, previous = {}) {
    const requestedExpiry = Number(data.expires_in);
    const expiresIn = Number.isFinite(requestedExpiry)
        ? Math.min(Math.max(requestedExpiry, 60), 24 * 60 * 60)
        : 3600;
    return {
        accessToken: clean(data.access_token, 4096) || previous.accessToken || '',
        refreshToken: clean(data.refresh_token, 4096) || previous.refreshToken || '',
        expiresAt: Date.now() + expiresIn * 1000,
        tokenType: 'Bearer',
        scope: clean(data.scope, 2000) || previous.scope || GOOGLE_SCOPE
    };
}

async function tokenRequest(body) {
    let response;
    try {
        response = await fetch(GOOGLE_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(body),
            signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS)
        });
    } catch {
        throw failure('Google сейчас недоступен. Попробуйте позже.', 503);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = failure('Google не подтвердил подключение. Запустите его заново.', 400);
        error.oauthCode = clean(payload.error, 80);
        throw error;
    }
    return payload;
}

async function refreshTokens(agentId, previous) {
    const config = oauthConfig();
    if (!config.clientId || !config.clientSecret) throw failure('Google Calendar ещё не настроен владельцем сайта.', 503);
    if (!previous.refreshToken) throw failure('Google Calendar нужно подключить заново.', 409);
    let payload;
    try {
        payload = await tokenRequest({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            refresh_token: previous.refreshToken,
            grant_type: 'refresh_token'
        });
    } catch (error) {
        if (error.oauthCode === 'invalid_grant') {
            await deleteTokens(agentId).catch(() => {});
            throw failure('Доступ Google Calendar отозван. Подключите календарь заново.', 409);
        }
        throw error;
    }
    return saveTokens(agentId, tokenPayload(payload, previous));
}

async function googleFetch(agentId, path, options = {}, forceRefresh = false) {
    let tokens = await readTokens(agentId);
    if (forceRefresh || !tokens.accessToken || tokens.expiresAt <= Date.now() + 60_000) {
        tokens = await refreshTokens(agentId, tokens);
    }
    const response = await fetch(`${GOOGLE_CALENDAR_API}${path}`, {
        ...options,
        signal: options.signal || AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
        headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    if (response.status === 401 && !forceRefresh) return googleFetch(agentId, path, options, true);
    return response;
}

export function googleCalendarConfigured() {
    const config = oauthConfig();
    return Boolean(config.clientId && config.clientSecret);
}

export async function googleCalendarStatus(agentId) {
    const row = await secretRow(agentId);
    let connected = false;
    let reconnectRequired = false;
    if (row) {
        try {
            const tokens = decodeTokenRow(agentId, row);
            connected = Boolean(tokens.accessToken || tokens.refreshToken);
        } catch {
            reconnectRequired = true;
        }
    }
    return {
        configured: googleCalendarConfigured(),
        connected,
        reconnectRequired,
        updatedAt: row?.updated_at || null,
        scope: 'События календаря'
    };
}

export async function beginGoogleCalendarAuth(req, res, session, agent) {
    const config = oauthConfig();
    if (!config.clientId || !config.clientSecret) {
        return sendRedirect(res, '/hub.html?google=setup_required#connections');
    }
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const envelope = signedEnvelope({
        state,
        verifier,
        accountId: session.sub,
        agentId: agent.id,
        exp: Math.floor(Date.now() / 1000) + OAUTH_TTL_SECONDS
    });
    const query = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri(req),
        response_type: 'code',
        scope: GOOGLE_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256'
    });
    res.setHeader('Set-Cookie', oauthCookie(envelope));
    return sendRedirect(res, `${GOOGLE_AUTH_URL}?${query}`);
}

export async function finishGoogleCalendarAuth(req, res, session, agent) {
    res.setHeader('Set-Cookie', oauthCookie('', 0));
    let origin;
    try {
        origin = requestOrigin(req);
    } catch {
        return sendRedirect(res, '/hub.html?google=error#connections');
    }
    const successUrl = `${origin}/hub.html?google=connected#connections`;
    const failureUrl = `${origin}/hub.html?google=error#connections`;
    if (req.query?.error || !req.query?.code || !req.query?.state) return sendRedirect(res, failureUrl);

    const envelope = readEnvelope(parseCookies(req.headers?.cookie || '')[OAUTH_COOKIE]);
    if (!envelope || envelope.state !== req.query.state || envelope.accountId !== session.sub || envelope.agentId !== agent?.id) {
        return sendRedirect(res, failureUrl);
    }
    const config = oauthConfig();
    if (!config.clientId || !config.clientSecret) return sendRedirect(res, failureUrl);
    try {
        const payload = await tokenRequest({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code: clean(req.query.code, 4096),
            code_verifier: envelope.verifier,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri(req)
        });
        if (!hasOnlyCalendarScope(payload.scope)) {
            await revokeGoogleToken(clean(payload.refresh_token, 4096) || clean(payload.access_token, 4096));
            throw failure('Google вернул более широкий доступ, чем разрешён сайтом.', 400);
        }
        if (!clean(payload.access_token, 4096) || !clean(payload.refresh_token, 4096)) {
            await revokeGoogleToken(clean(payload.refresh_token, 4096) || clean(payload.access_token, 4096));
            throw failure('Google не выдал автономный доступ. Подключите календарь ещё раз.', 400);
        }
        // A newly authorized grant replaces any old or corrupt credential. We
        // deliberately do not retain an earlier refresh token with unknown
        // historical scopes.
        try {
            await saveTokens(envelope.agentId, tokenPayload({ ...payload, scope: payload.scope || GOOGLE_SCOPE }));
        } catch (error) {
            await revokeGoogleToken(clean(payload.refresh_token, 4096));
            throw error;
        }
        return sendRedirect(res, successUrl);
    } catch (error) {
        console.error('Google Calendar OAuth callback failed:', error.message);
        return sendRedirect(res, failureUrl);
    }
}

export async function disconnectGoogleCalendar(agentId) {
    let tokens = null;
    const row = await secretRow(agentId);
    if (row) {
        try {
            tokens = decodeTokenRow(agentId, row, { validateScope: false });
        } catch {
            // A damaged local credential must not make the disconnect action
            // impossible. There is no usable token to revoke in this case.
        }
    }
    const token = tokens?.refreshToken || tokens?.accessToken;
    const revoked = await revokeGoogleToken(token);
    await deleteTokens(agentId);
    return { ok: true, connected: false, remoteRevoked: revoked };
}

function safeTimeZone(value) {
    const candidate = clean(value, 80) || 'Asia/Almaty';
    try {
        new Intl.DateTimeFormat('en', { timeZone: candidate }).format();
        return candidate;
    } catch {
        return 'Asia/Almaty';
    }
}

function nextIsoDate(value) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime())) return '';
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
}

function isoDateInTimeZone(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function addIsoDays(value, days) {
    const date = new Date(`${value}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function googleEventBody(record) {
    const start = new Date(record.event_at || record.eventAt);
    if (!Number.isFinite(start.getTime())) throw failure('У события неверная дата.');
    const googleMetadata = record.metadata?.googleCalendar || {};
    let startPayload;
    let endPayload;
    if (googleMetadata.allDay && /^\d{4}-\d{2}-\d{2}$/.test(clean(googleMetadata.startDate, 10))) {
        const originalStartDate = clean(googleMetadata.startDate, 10);
        const requestedEnd = clean(googleMetadata.endDate, 10);
        const originalEndDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedEnd) && requestedEnd > originalStartDate
            ? requestedEnd
            : nextIsoDate(originalStartDate);
        const span = Math.min(Math.max(Math.round(
            (new Date(`${originalEndDate}T00:00:00.000Z`) - new Date(`${originalStartDate}T00:00:00.000Z`)) / 86_400_000
        ), 1), 3650);
        const startDate = isoDateInTimeZone(start, safeTimeZone(googleMetadata.timeZone || process.env.BUSINESS_TIMEZONE));
        const endDate = addIsoDays(startDate, span);
        startPayload = { date: startDate };
        endPayload = { date: endDate };
    } else {
        const requestedEnd = new Date(googleMetadata.endDateTime || '');
        const end = Number.isFinite(requestedEnd.getTime()) && requestedEnd > start
            ? requestedEnd
            : new Date(start.getTime() + 60 * 60 * 1000);
        const timeZone = safeTimeZone(googleMetadata.timeZone || process.env.BUSINESS_TIMEZONE);
        startPayload = { dateTime: start.toISOString(), timeZone };
        endPayload = { dateTime: end.toISOString(), timeZone };
    }
    const body = {
        summary: clean(record.title, 240),
        description: clean(record.body, 12000),
        start: startPayload,
        end: endPayload
    };
    // Do not overwrite another integration's private extended properties on
    // Google-originated events. The deterministic source key already links
    // those rows. Locally-created events get a private marker for de-duplication.
    if (googleMetadata.origin !== 'google') {
        body.extendedProperties = { private: { shaikhRecordId: clean(record.id, 80) } };
    }
    return body;
}

function recordContentHash(record) {
    return createHash('sha256').update(JSON.stringify(googleEventBody(record))).digest('hex');
}

async function updateGoogleMetadata(agentId, record, googleEvent) {
    const eventId = clean(googleEvent.id, 1024);
    if (!eventId) throw failure('Google Calendar вернул событие без идентификатора.', 502);
    const syncedAt = new Date().toISOString();
    const eventBody = googleEventBody(record);
    const allDayDates = eventBody.start?.date
        ? { startDate: eventBody.start.date, endDate: eventBody.end.date }
        : {};
    const metadata = {
        ...(record.metadata && typeof record.metadata === 'object' ? record.metadata : {}),
        googleCalendar: {
            ...(record.metadata?.googleCalendar || {}),
            eventId,
            htmlLink: safeGoogleCalendarLink(googleEvent.htmlLink),
            contentHash: recordContentHash(record),
            ...allDayDates,
            syncedAt
        }
    };
    const result = await db(
        `personal_agent_records?id=eq.${encoded(record.id)}&agent_id=eq.${encoded(agentId)}`,
        { method: 'PATCH', body: JSON.stringify({ metadata, updated_at: syncedAt }) }
    );
    if (!result.res.ok) throw failure('Событие создано в Google, но отметка синхронизации не сохранилась.', 503);
}

export async function syncGoogleCalendarEvent(agentId, record) {
    if (!record || record.kind !== 'event' || record.status === 'deleted') return { skipped: true };
    if (record.agent_id !== agentId) throw failure('Событие не принадлежит этому агенту.', 403);
    if (!await readTokens(agentId, { required: false })) return { skipped: true, connected: false };
    const eventId = clean(record.metadata?.googleCalendar?.eventId, 1024);
    const path = eventId
        ? `/calendars/primary/events/${encoded(eventId)}`
        : '/calendars/primary/events';
    let response = await googleFetch(agentId, path, {
        method: eventId ? 'PATCH' : 'POST',
        body: JSON.stringify(googleEventBody(record))
    });
    if (eventId && response.status === 404 && record.metadata?.googleCalendar?.origin !== 'google') {
        response = await googleFetch(agentId, '/calendars/primary/events', {
            method: 'POST', body: JSON.stringify(googleEventBody(record))
        });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw failure('Google Calendar не синхронизировал событие.', response.status === 429 ? 429 : 502);
    await updateGoogleMetadata(agentId, record, payload);
    return { synced: true, eventId: payload.id, htmlLink: safeGoogleCalendarLink(payload.htmlLink) };
}

export async function removeGoogleCalendarEvent(agentId, record) {
    if (record?.agent_id !== agentId) throw failure('Событие не принадлежит этому агенту.', 403);
    const eventId = clean(record?.metadata?.googleCalendar?.eventId, 1024);
    if (!eventId || !await readTokens(agentId, { required: false })) return { skipped: true };
    const response = await googleFetch(agentId, `/calendars/primary/events/${encoded(eventId)}`, { method: 'DELETE' });
    if (!response.ok && ![404, 410].includes(response.status)) {
        throw failure('Google Calendar не удалил связанное событие.', response.status === 429 ? 429 : 502);
    }
    const removedAt = new Date().toISOString();
    const metadata = {
        ...(record.metadata && typeof record.metadata === 'object' ? record.metadata : {}),
        googleCalendar: {
            ...(record.metadata?.googleCalendar || {}),
            removedAt
        }
    };
    const marked = await db(
        `personal_agent_records?id=eq.${encoded(record.id)}&agent_id=eq.${encoded(agentId)}`,
        { method: 'PATCH', body: JSON.stringify({ metadata, updated_at: removedAt }) }
    );
    if (!marked.res.ok) throw failure('Событие удалено из Google, но локальная отметка не сохранилась.', 503);
    return { removed: true };
}

export async function syncGoogleCalendar(agentId) {
    let tokens = await readTokens(agentId, { required: false });
    if (!tokens) return { ok: false, connected: false, synced: 0, failed: 0, remaining: 0, total: 0 };
    if (!tokens.accessToken || tokens.expiresAt <= Date.now() + 60_000) {
        tokens = await refreshTokens(agentId, tokens);
    }
    const recordsResult = await db(
        `personal_agent_records?select=*&agent_id=eq.${encoded(agentId)}&kind=eq.event&order=updated_at.desc&limit=250`
    );
    if (!recordsResult.res.ok) throw failure('Не удалось подготовить события к синхронизации.', 503);
    let synced = 0;
    let removed = 0;
    let failed = 0;
    const records = recordsResult.body || [];
    const dirtyRecords = records.filter(record => {
        if (record.status === 'deleted') {
            return Boolean(record.metadata?.googleCalendar?.eventId && !record.metadata?.googleCalendar?.removedAt);
        }
        try {
            return recordContentHash(record) !== clean(record.metadata?.googleCalendar?.contentHash, 64);
        } catch {
            return true;
        }
    });
    const selectedRecords = dirtyRecords.slice(0, GOOGLE_SYNC_LIMIT);
    for (let index = 0; index < selectedRecords.length; index += GOOGLE_SYNC_BATCH_SIZE) {
        const results = await Promise.allSettled(
            selectedRecords.slice(index, index + GOOGLE_SYNC_BATCH_SIZE).map(record => (
                record.status === 'deleted'
                    ? removeGoogleCalendarEvent(agentId, record)
                    : syncGoogleCalendarEvent(agentId, record)
            ))
        );
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value.synced) synced += 1;
            if (result.status === 'fulfilled' && result.value.removed) removed += 1;
            if (result.status === 'rejected') {
                failed += 1;
                console.error('Google Calendar event sync failed:', result.reason?.message || 'Unknown error');
            }
        }
    }
    return {
        ok: failed === 0,
        complete: failed === 0 && dirtyRecords.length <= selectedRecords.length,
        synced,
        removed,
        failed,
        remaining: Math.max(0, dirtyRecords.length - selectedRecords.length),
        total: dirtyRecords.length
    };
}

function googleSourceKey(eventId) {
    return `google:${createHash('sha256').update(eventId).digest('hex')}`;
}

function googleItemRow(agentId, item) {
    const eventId = clean(item?.id, 1024);
    const startDateTime = clean(item?.start?.dateTime, 100);
    const startDate = clean(item?.start?.date, 10);
    if (!eventId || item?.status === 'cancelled' || item?.extendedProperties?.private?.shaikhRecordId) return null;

    let eventAt;
    if (startDateTime) {
        const parsed = new Date(startDateTime);
        if (!Number.isFinite(parsed.getTime())) return null;
        eventAt = parsed.toISOString();
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
        // The product currently uses Almaty as its display timezone. Keep a
        // representative morning instant while preserving exact all-day dates
        // separately, so a later push cannot turn the event into a timed one.
        const parsed = new Date(`${startDate}T09:00:00+05:00`);
        if (!Number.isFinite(parsed.getTime())) return null;
        eventAt = parsed.toISOString();
    } else {
        return null;
    }

    const importedAt = new Date().toISOString();
    const allDay = Boolean(startDate && !startDateTime);
    const endDateTime = clean(item?.end?.dateTime, 100);
    const endDate = clean(item?.end?.date, 10);
    const row = {
        agent_id: agentId,
        kind: 'event',
        title: clean(item.summary || 'Событие Google Calendar', 240),
        body: clean(item.description, 12000),
        amount: null,
        currency: 'KZT',
        category: null,
        transaction_type: null,
        event_at: eventAt,
        occurred_at: null,
        status: 'active',
        source_message_key: googleSourceKey(eventId),
        metadata: {
            source: 'google_calendar',
            googleCalendar: {
                origin: 'google',
                eventId,
                htmlLink: safeGoogleCalendarLink(item.htmlLink),
                allDay,
                startDate: allDay ? startDate : null,
                endDate: allDay && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : null,
                endDateTime: !allDay && Number.isFinite(new Date(endDateTime).getTime())
                    ? new Date(endDateTime).toISOString()
                    : null,
                timeZone: !allDay ? safeTimeZone(item?.start?.timeZone || item?.end?.timeZone) : null,
                syncedAt: importedAt
            }
        },
        updated_at: importedAt
    };
    row.metadata.googleCalendar.contentHash = recordContentHash(row);
    return row;
}

async function existingGoogleRecords(agentId, keys) {
    const records = new Map();
    const chunks = [];
    for (let index = 0; index < keys.length; index += 40) chunks.push(keys.slice(index, index + 40));
    const results = await Promise.all(chunks.map(chunk => db(
        `personal_agent_records?select=*&agent_id=eq.${encoded(agentId)}&source_message_key=in.(${chunk.map(encoded).join(',')})`
    )));
    for (const result of results) {
        if (!result.res.ok) throw failure('Не удалось проверить ранее импортированные события.', 503);
        for (const record of result.body || []) records.set(record.source_message_key, record);
    }
    return records;
}

function hasUnsyncedLocalChange(record) {
    const syncedHash = clean(record?.metadata?.googleCalendar?.contentHash, 64);
    if (!syncedHash) return false;
    try {
        return recordContentHash(record) !== syncedHash;
    } catch {
        return true;
    }
}

export async function importGoogleCalendar(agentId) {
    const timeMin = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const items = [];
    let pageToken = '';
    let truncated = false;
    for (let page = 0; page < GOOGLE_IMPORT_PAGE_LIMIT; page += 1) {
        const params = new URLSearchParams({
            singleEvents: 'true',
            orderBy: 'startTime',
            showDeleted: 'true',
            maxResults: String(GOOGLE_IMPORT_PAGE_SIZE),
            timeMin,
            timeMax
        });
        if (pageToken) params.set('pageToken', pageToken);
        const response = await googleFetch(agentId, `/calendars/primary/events?${params}`);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw failure('Не удалось получить события Google Calendar.', response.status === 429 ? 429 : 502);
        if (Array.isArray(payload.items)) items.push(...payload.items);
        pageToken = clean(payload.nextPageToken, 2048);
        if (!pageToken) break;
        truncated = page === GOOGLE_IMPORT_PAGE_LIMIT - 1;
    }

    const uniqueItems = [...new Map(items.map(item => [clean(item?.id, 1024), item]).filter(([id]) => id)).values()];
    const rows = [...new Map(
        uniqueItems.map(item => googleItemRow(agentId, item)).filter(Boolean)
            .map(row => [row.source_message_key, row])
    ).values()];
    const cancelledKeys = uniqueItems.filter(item => (
        item?.status === 'cancelled'
        && !item?.extendedProperties?.private?.shaikhRecordId
    )).map(item => googleSourceKey(clean(item.id, 1024)));
    if (!rows.length && !cancelledKeys.length) {
        return { ok: true, imported: 0, updated: 0, deleted: 0, total: 0, truncated };
    }
    const existing = await existingGoogleRecords(agentId, [...new Set([
        ...rows.map(row => row.source_message_key),
        ...cancelledKeys
    ])]);
    let skippedDeleted = 0;
    let skippedLocalChanges = 0;
    let imported = 0;
    let updated = 0;
    const rowsToSave = rows.filter(row => {
        const current = existing.get(row.source_message_key);
        if (!current) {
            imported += 1;
            return true;
        }
        if (current.status === 'deleted') {
            skippedDeleted += 1;
            return false;
        }
        if (hasUnsyncedLocalChange(current)) {
            skippedLocalChanges += 1;
            return false;
        }
        updated += 1;
        return true;
    });

    const keysToDelete = cancelledKeys.filter(key => {
        const current = existing.get(key);
        if (!current || current.status === 'deleted' || hasUnsyncedLocalChange(current)) return false;
        return current.metadata?.googleCalendar?.origin === 'google' || current.metadata?.source === 'google_calendar';
    });

    const saveResults = await Promise.all(Array.from(
        { length: Math.ceil(rowsToSave.length / 100) },
        (_, index) => rowsToSave.slice(index * 100, index * 100 + 100)
    ).map(chunk => db('personal_agent_records?on_conflict=agent_id,source_message_key', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(chunk),
        timeoutMs: 20_000
    })));
    const deleteResults = await Promise.all(Array.from(
        { length: Math.ceil(keysToDelete.length / 40) },
        (_, index) => keysToDelete.slice(index * 40, index * 40 + 40)
    ).map(chunk => db(
        `personal_agent_records?agent_id=eq.${encoded(agentId)}&source_message_key=in.(${chunk.map(encoded).join(',')})`,
        {
            method: 'PATCH',
            body: JSON.stringify({ status: 'deleted', updated_at: new Date().toISOString() }),
            timeoutMs: 12_000
        }
    )));
    if ([...saveResults, ...deleteResults].some(result => !result.res.ok)) {
        throw failure('Не удалось сохранить события Google Calendar.', 503);
    }
    return {
        ok: true,
        imported,
        updated,
        deleted: keysToDelete.length,
        skippedDeleted,
        skippedLocalChanges,
        total: rows.length + cancelledKeys.length,
        truncated
    };
}
