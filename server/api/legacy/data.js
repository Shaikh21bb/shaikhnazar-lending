import { requireLegacyDashboardSession, requireSameOrigin } from '../_auth.js';
import { db, readJsonBody } from '../_lib.js';

const OPERATIONS = new Set(['select', 'insert', 'update', 'delete']);
const INPUT_KEYS = new Set([
    'table', 'operation', 'columns', 'filters', 'orders', 'limit',
    'count', 'head', 'payload', 'returning'
]);
const SENSITIVE_KEYS = new Set([
    'token',
    'webhook_secret',
    'webhook_secret_hash',
    'telegram_webhook_secret_hash',
    'telegram_connection_nonce',
    'telegram_connection_expires_at'
]);

const TABLES = Object.freeze({
    agents: table({
        columns: [
            'id', 'name', 'platform', 'connected', 'status', 'language',
            'project_id', 'created_at', 'agent_type', 'ai_enabled'
        ],
        writable: [
            'name', 'platform', 'token', 'connected', 'status', 'language',
            'project_id', 'agent_type', 'ai_enabled'
        ],
        managerOperations: ['select']
    }),
    projects: table({
        columns: ['id', 'name', 'description', 'knowledge', 'created_at'],
        writable: ['name', 'description', 'knowledge']
    }),
    agent_chats: table({
        columns: [
            'id', 'agent_id', 'customer_id', 'channel', 'chat_id', 'role',
            'text', 'created_at', 'external_message_id', 'tool_name', 'metadata'
        ],
        writable: [
            'agent_id', 'customer_id', 'channel', 'chat_id', 'role', 'text',
            'external_message_id', 'tool_name', 'metadata'
        ],
        managerOperations: ['select']
    }),
    managers: table({
        columns: ['id', 'name', 'chat_id', 'agent_id', 'created_at'],
        writable: ['name', 'chat_id', 'agent_id'],
        managerOperations: ['select']
    }),
    tasks: table({
        columns: [
            'id', 'title', 'description', 'due_at', 'manager', 'chat_id',
            'agent_id', 'status', 'lead_name', 'lead_contact', 'remind_confirm',
            'remind_due', 'remind_overdue', 'created_at', 'customer_id',
            'source', 'channel', 'external_chat_id', 'auto_send',
            'processing_at', 'sent_at', 'last_error'
        ],
        writable: [
            'title', 'description', 'due_at', 'manager', 'chat_id', 'agent_id',
            'status', 'lead_name', 'lead_contact', 'remind_confirm', 'remind_due',
            'remind_overdue', 'customer_id', 'source', 'channel',
            'external_chat_id', 'auto_send', 'processing_at', 'sent_at',
            'last_error'
        ],
        managerWritable: [
            'title', 'description', 'due_at', 'manager', 'chat_id', 'agent_id',
            'status', 'lead_name', 'lead_contact', 'remind_confirm', 'remind_due',
            'remind_overdue'
        ],
        managerOperations: ['select', 'insert', 'update', 'delete']
    }),
    scripts: table({
        columns: ['id', 'lead_name', 'lead_contact', 'lead_need', 'script', 'created_at'],
        writable: ['lead_name', 'lead_contact', 'lead_need', 'script']
    })
});

function table({ columns, writable, managerWritable = [], managerOperations = [] }) {
    return Object.freeze({
        columns: Object.freeze(columns),
        columnSet: new Set(columns),
        writable: new Set(writable),
        managerWritable: new Set(managerWritable),
        managerOperations: new Set(managerOperations)
    });
}

class RequestError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function parseColumns(value, config, label = 'columns') {
    if (value === undefined || value === null || value === '*') return [...config.columns];
    const entries = Array.isArray(value)
        ? value
        : String(value).split(',').map(column => column.trim()).filter(Boolean);
    if (!entries.length || entries.some(column => typeof column !== 'string' || !config.columnSet.has(column))) {
        throw new RequestError(400, `Invalid ${label}`);
    }
    return [...new Set(entries)];
}

function parseFilters(value, config) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new RequestError(400, 'Invalid filters');
    return value.map(filter => {
        if (!isPlainObject(filter)
            || !config.columnSet.has(filter.column)
            || filter.operator !== 'eq'
            || (typeof filter.value === 'object' && filter.value !== null)
            || (typeof filter.value === 'string' && filter.value.length > 4096)) {
            throw new RequestError(400, 'Invalid filter');
        }
        return { column: filter.column, operator: 'eq', value: filter.value };
    });
}

function parseOrders(value, config) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new RequestError(400, 'Invalid orders');
    return value.map(order => {
        if (!isPlainObject(order)
            || !config.columnSet.has(order.column)
            || (order.ascending !== undefined && typeof order.ascending !== 'boolean')) {
            throw new RequestError(400, 'Invalid order');
        }
        return { column: order.column, ascending: order.ascending !== false };
    });
}

function parseLimit(value) {
    if (value === undefined || value === null) return null;
    if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
        throw new RequestError(400, 'Invalid limit');
    }
    return value;
}

function parsePayload(value, writable, required) {
    if (value === undefined || value === null) {
        if (required) throw new RequestError(400, 'Payload is required');
        return null;
    }
    if (!isPlainObject(value) || Object.keys(value).length === 0) {
        throw new RequestError(400, 'Invalid payload');
    }
    for (const key of Object.keys(value)) {
        if (!writable.has(key)) throw new RequestError(400, 'Invalid payload field');
    }
    return { ...value };
}

function parseRequest(body) {
    if (!isPlainObject(body)) throw new RequestError(400, 'Invalid request');
    if (Object.keys(body).some(key => !INPUT_KEYS.has(key))) {
        throw new RequestError(400, 'Unknown request field');
    }

    const config = TABLES[body.table];
    if (!config) throw new RequestError(400, 'Invalid table');
    const operation = body.operation || 'select';
    if (!OPERATIONS.has(operation)) throw new RequestError(400, 'Invalid operation');

    const columns = parseColumns(body.columns, config);
    const filters = parseFilters(body.filters, config);
    const orders = parseOrders(body.orders, config);
    const limit = parseLimit(body.limit);
    const count = body.count === undefined || body.count === null ? null : body.count;
    if (count !== null && count !== 'exact') throw new RequestError(400, 'Invalid count');
    const head = body.head === true;
    if (body.head !== undefined && body.head !== null && typeof body.head !== 'boolean') {
        throw new RequestError(400, 'Invalid head');
    }

    let returning = null;
    if (body.returning === true) returning = columns;
    else if (body.returning !== undefined && body.returning !== null && body.returning !== false) {
        returning = parseColumns(body.returning, config, 'returning');
    }

    if (operation === 'select') {
        if (body.payload !== undefined && body.payload !== null) {
            throw new RequestError(400, 'Select does not accept a payload');
        }
    } else {
        if (head || count !== null || orders.length) {
            throw new RequestError(400, 'Invalid mutation options');
        }
        if ((operation === 'update' || operation === 'delete') && filters.length === 0) {
            throw new RequestError(400, 'Update and delete require filters');
        }
    }

    return {
        table: body.table,
        config,
        operation,
        columns,
        filters,
        orders,
        limit,
        count,
        head,
        payloadValue: body.payload,
        returning
    };
}

export async function legacyManagerAssignment(session) {
    const account = await db(
        `managers_auth?select=manager_id&id=eq.${encodeURIComponent(session.sub)}&limit=1`
    );
    // The first production schema did not have manager_id. Keep the exact-name
    // fallback during the staged deploy, then prefer the explicit FK as soon as
    // the hardening migration has added and backfilled it.
    const managerColumnUnavailable = !account.res.ok
        && account.res.status === 400
        && /manager_id/i.test(JSON.stringify(account.body || {}))
        && /(does not exist|could not find|42703|pgrst204)/i.test(JSON.stringify(account.body || {}));
    if (!account.res.ok && !managerColumnUnavailable) {
        throw new RequestError(503, 'Manager scope unavailable');
    }

    const managerId = account.res.ok ? account.body?.[0]?.manager_id : null;
    let manager;
    if (managerId) {
        const linked = await db(
            `managers?select=id,name,chat_id,agent_id&id=eq.${encodeURIComponent(managerId)}&limit=1`
        );
        if (!linked.res.ok) throw new RequestError(503, 'Manager scope unavailable');
        manager = linked.body?.[0];
    } else if (managerColumnUnavailable) {
        const legacy = await db('managers?select=id,name,chat_id,agent_id&limit=1000');
        if (!legacy.res.ok) throw new RequestError(503, 'Manager scope unavailable');
        const login = String(session.login || '').trim().toLowerCase();
        const matches = (legacy.body || []).filter(
            row => String(row.name || '').trim().toLowerCase() === login
        );
        // Compatibility is fail-closed: a duplicate legacy name is not a
        // stable tenant assignment and must be linked explicitly by owner.
        if (matches.length > 1) throw new RequestError(403, 'Manager assignment required');
        manager = matches[0];
    }

    if (!manager) throw new RequestError(403, 'Manager assignment required');
    return manager;
}

function forceFilter(filters, column, value) {
    const requested = filters.filter(filter => filter.column === column);
    if (requested.some(filter => String(filter.value) !== String(value))) {
        throw new RequestError(403, 'Requested data is outside the manager scope');
    }
    return [
        ...filters.filter(filter => filter.column !== column),
        { column, operator: 'eq', value }
    ];
}

function forcePayloadValue(payload, column, value) {
    if (Object.hasOwn(payload, column)
        && payload[column] !== null
        && String(payload[column]) !== String(value)) {
        throw new RequestError(403, 'Requested data is outside the manager scope');
    }
    payload[column] = value;
}

async function applyManagerScope(request, session) {
    if (!request.config.managerOperations.has(request.operation)) {
        throw new RequestError(403, 'Operation is not available to managers');
    }
    const manager = await legacyManagerAssignment(session);

    if (request.table === 'managers') {
        request.filters = forceFilter(request.filters, 'id', manager.id);
        return;
    }
    if (request.table === 'agents') {
        if (!manager.agent_id) {
            request.empty = true;
            return;
        }
        request.filters = forceFilter(request.filters, 'id', manager.agent_id);
        return;
    }
    if (request.table === 'agent_chats') {
        if (!manager.agent_id) {
            request.empty = true;
            return;
        }
        request.filters = forceFilter(request.filters, 'agent_id', manager.agent_id);
        return;
    }
    if (request.table === 'tasks') {
        if (!manager.chat_id) {
            if (request.operation === 'select') {
                request.empty = true;
                return;
            }
            throw new RequestError(403, 'Manager chat assignment required');
        }
        request.filters = forceFilter(request.filters, 'chat_id', manager.chat_id);
        if (manager.agent_id) {
            request.filters = forceFilter(request.filters, 'agent_id', manager.agent_id);
        }
        if (request.operation === 'insert' || request.operation === 'update') {
            forcePayloadValue(request.payload, 'chat_id', manager.chat_id);
            forcePayloadValue(request.payload, 'manager', manager.name);
            forcePayloadValue(request.payload, 'agent_id', manager.agent_id || null);
        }
    }
}

function filterValue(filter) {
    if (filter.value === null) return 'is.null';
    return `eq.${String(filter.value)}`;
}

function buildPath(request) {
    const params = new URLSearchParams();
    const selected = request.operation === 'select' ? request.columns : request.returning;
    if (selected) params.set('select', selected.join(','));
    for (const filter of request.filters) params.append(filter.column, filterValue(filter));
    if (request.orders.length) {
        params.set('order', request.orders.map(order => `${order.column}.${order.ascending ? 'asc' : 'desc'}`).join(','));
    }
    if (request.operation === 'select' && request.limit !== null) params.set('limit', String(request.limit));
    return `${request.table}?${params.toString()}`;
}

function sanitize(value) {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !SENSITIVE_KEYS.has(key))
        .map(([key, entry]) => [key, sanitize(entry)]));
}

function projectResponse(value, columns) {
    if (Array.isArray(value)) return value.map(row => projectResponse(row, columns));
    if (!isPlainObject(value) || !columns) return sanitize(value);
    return Object.fromEntries(columns
        .filter(column => Object.hasOwn(value, column))
        .map(column => [column, sanitize(value[column])]));
}

function exactCount(response) {
    const range = response.headers?.get?.('content-range') || '';
    const match = range.match(/\/(\d+|\*)$/);
    return match && match[1] !== '*' ? Number(match[1]) : null;
}

function methodFor(operation, head) {
    if (operation === 'select') return head ? 'HEAD' : 'GET';
    if (operation === 'insert') return 'POST';
    if (operation === 'update') return 'PATCH';
    return 'DELETE';
}

function sendError(res, status, message) {
    return res.status(status).json({ data: null, error: message });
}

export default async function handler(req, res) {
    res.setHeader?.('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
        res.setHeader?.('Allow', 'POST');
        return sendError(res, 405, 'Method not allowed');
    }

    const session = await requireLegacyDashboardSession(req, res, ['owner', 'manager']);
    if (!session) return;

    let request;
    try {
        request = parseRequest(await readJsonBody(req));
        if (request.operation !== 'select' && !requireSameOrigin(req, res)) return;

        const writable = session.role === 'manager'
            ? request.config.managerWritable
            : request.config.writable;
        if (session.role === 'manager' && !request.config.managerOperations.has(request.operation)) {
            throw new RequestError(403, 'Operation is not available to managers');
        }
        request.payload = parsePayload(
            request.payloadValue,
            writable,
            request.operation === 'insert' || request.operation === 'update'
        );

        if (session.role === 'manager') await applyManagerScope(request, session);
        if (request.empty) {
            const response = { data: request.head ? null : [], error: null };
            if (request.count === 'exact') response.count = 0;
            return res.status(200).json(response);
        }

        const options = {
            method: methodFor(request.operation, request.head),
            headers: {}
        };
        if (request.count === 'exact') options.headers.Prefer = 'count=exact';
        if (request.operation !== 'select') {
            options.headers.Prefer = request.returning ? 'return=representation' : 'return=minimal';
            if (request.payload) options.body = JSON.stringify(request.payload);
        }

        const result = await db(buildPath(request), options);
        if (!result.res.ok) {
            console.error('Legacy data request failed:', request.table, request.operation, result.res.status);
            const status = [400, 404, 409, 422].includes(result.res.status) ? result.res.status : 502;
            throw new RequestError(status, 'Database operation failed');
        }

        const response = {
            data: request.head
                ? null
                : projectResponse(
                    result.body,
                    request.operation === 'select' ? request.columns : request.returning
                ),
            error: null
        };
        if (request.count === 'exact') response.count = exactCount(result.res);
        return res.status(200).json(response);
    } catch (error) {
        if (error instanceof RequestError) return sendError(res, error.status, error.message);
        console.error('Legacy data proxy failed:', error.message);
        return sendError(res, 503, 'Data service unavailable');
    }
}
