// Authenticated compatibility facade for the legacy owner dashboard.
//
// The old UI was written against supabase-js and used a public database key in
// the browser. Keep its small query-builder surface, but send every operation to
// the signed same-origin server route instead. The server owns the table/column
// allowlist and never returns provider credentials.
(function installLegacyDataClient() {
    class LegacyQuery {
        constructor(table) {
            this.request = {
                table,
                operation: 'select',
                columns: '*',
                filters: [],
                orders: [],
                limit: null,
                count: null,
                head: false,
                payload: null,
                returning: false
            };
            this.singleRow = false;
        }

        select(columns = '*', options = {}) {
            this.request.columns = String(columns || '*');
            if (this.request.operation !== 'select') this.request.returning = true;
            this.request.count = options?.count || null;
            this.request.head = options?.head === true;
            return this;
        }

        insert(payload) {
            this.request.operation = 'insert';
            this.request.payload = payload;
            return this;
        }

        update(payload) {
            this.request.operation = 'update';
            this.request.payload = payload;
            return this;
        }

        delete() {
            this.request.operation = 'delete';
            return this;
        }

        eq(column, value) {
            this.request.filters.push({ column, operator: 'eq', value });
            return this;
        }

        order(column, options = {}) {
            this.request.orders.push({ column, ascending: options?.ascending !== false });
            return this;
        }

        limit(value) {
            const numeric = Number(value);
            this.request.limit = Number.isSafeInteger(numeric) ? numeric : null;
            return this;
        }

        single() {
            this.singleRow = true;
            this.request.returning = true;
            this.request.limit = 1;
            return this;
        }

        async execute() {
            try {
                const response = await fetch('/api/legacy/data', {
                    method: 'POST',
                    credentials: 'same-origin',
                    cache: 'no-store',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify(this.request)
                });
                const payload = await response.json().catch(() => ({}));
                if (!response.ok || payload.error) {
                    return {
                        data: null,
                        count: null,
                        error: { message: payload.error || 'Не удалось загрузить данные панели.' }
                    };
                }
                const rows = payload.data ?? null;
                if (this.singleRow) {
                    if (!Array.isArray(rows) || rows.length !== 1) {
                        return { data: null, count: payload.count ?? null, error: { message: 'Запись не найдена.' } };
                    }
                    return { data: rows[0], count: payload.count ?? null, error: null };
                }
                return { data: rows, count: payload.count ?? null, error: null };
            } catch (_) {
                return { data: null, count: null, error: { message: 'Нет связи с сервером.' } };
            }
        }

        then(resolve, reject) { return this.execute().then(resolve, reject); }
        catch(reject) { return this.execute().catch(reject); }
        finally(callback) { return this.execute().finally(callback); }
    }

    window.supabaseClient = {
        from(table) { return new LegacyQuery(String(table || '')); }
    };
})();
