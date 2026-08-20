document.addEventListener('DOMContentLoaded', () => {
    const grid = document.getElementById('stats-grid');
    const tasksBox = document.getElementById('stats-tasks');
    const dialogsBox = document.getElementById('stats-dialogs');
    const managersBox = document.getElementById('stats-managers');
    const recentBox = document.getElementById('stats-recent-scripts');
    const refreshBtn = document.getElementById('stats-refresh');
    const rangeSelect = document.getElementById('stats-range');
    if (!grid && !tasksBox) return;

    function rangeCutoff() {
        const v = rangeSelect ? rangeSelect.value : 'all';
        if (!v || v === 'all') return null;
        const now = new Date();
        if (v === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const days = { '7d': 7, '30d': 30, '90d': 90 }[v] || 0;
        return new Date(now.getTime() - days * 86400000);
    }

    function esc(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    function fmtDate(iso) {
        if (!iso) return '—';
        return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }

    function downloadCSV(filename, rows) {
        const csv = rows.map(r => r.map(cell => {
            const s = String(cell ?? '');
            return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        }).join(';')).join('\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    const exportBtn = document.getElementById('stats-export');
    if (exportBtn) {
        exportBtn.addEventListener('click', async () => {
            exportBtn.disabled = true;
            const label = exportBtn.querySelector('span');
            const old = label.textContent;
            label.textContent = 'Выгрузка...';
            try {
                const [{ data: tasks }, { data: chats }, { data: scripts }] = await Promise.all([
                    supabaseClient.from('tasks').select('id,title,manager,due_at,status,created_at'),
                    supabaseClient.from('agent_chats').select('agent_id,chat_id,role,text,created_at').order('created_at', { ascending: true }),
                    supabaseClient.from('scripts').select('lead_name,lead_contact,lead_need,script,created_at')
                ]);
                const cutoff = rangeCutoff();
                let tasksList = tasks || [];
                let chatsList = chats || [];
                let scriptsList = scripts || [];
                if (cutoff) {
                    tasksList = tasksList.filter(t => t.created_at && new Date(t.created_at) >= cutoff);
                    chatsList = chatsList.filter(c => c.created_at && new Date(c.created_at) >= cutoff);
                    scriptsList = scriptsList.filter(s => s.created_at && new Date(s.created_at) >= cutoff);
                }
                const agents = {};
                const { data: agentsAll } = await supabaseClient.from('agents').select('id,name');
                (agentsAll || []).forEach(a => agents[a.id] = a.name);

                downloadCSV(`shaikh_tasks_${new Date().toISOString().slice(0,10)}.csv`, [
                    ['ID', 'Задача', 'Менеджер', 'Дедлайн', 'Статус', 'Создана'],
                    ...(tasksList.map(t => [t.id, t.title, t.manager, t.due_at ? new Date(t.due_at).toLocaleString('ru-RU') : '', t.status, fmtDate(t.created_at)]))
                ]);

                const allChats = [['Дата', 'Агент', 'Роль', 'Chat ID', 'Текст'], ...(chatsList.map(c => [fmtDate(c.created_at), agents[c.agent_id] || c.agent_id, c.role, c.chat_id, c.text]))];
                try { downloadCSV(`shaikh_dialogs_${new Date().toISOString().slice(0,10)}.csv`, allChats); } catch (e) { console.error(e); }

                downloadCSV(`shaikh_scripts_${new Date().toISOString().slice(0,10)}.csv`, [
                    ['Лид', 'Контакт', 'Потребность', 'Текст скрипта', 'Дата'],
                    ...(scriptsList.map(s => [s.lead_name, s.lead_contact, s.lead_need, s.script, fmtDate(s.created_at)]))
                ]);

                alert('Скачано 3 файла: задачи, диалоги, скрипты.');
            } catch (e) {
                alert('Ошибка выгрузки: ' + (e && e.message ? e.message : e));
            } finally {
                exportBtn.disabled = false;
                label.textContent = old;
            }
        });
    }

    function buildCard(label, value, sub) {
        return `<div class="stat-card glass">
            <div class="stat-label">${esc(label)}</div>
            <div class="stat-value">${esc(String(value))}</div>
            ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}
        </div>`;
    }

    const isSameDay = (a, b) =>
        a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

    async function load() {
        const now = new Date();

        const [agentsR, projectsR, managersR, scriptsR, scriptsRecentR, tasksR, chatsR, msgsR] = await Promise.all([
            supabaseClient.from('agents').select('id'),
            supabaseClient.from('projects').select('id'),
            supabaseClient.from('managers').select('id'),
            supabaseClient.from('scripts').select('id'),
            supabaseClient.from('scripts').select('id,lead_name,created_at').order('created_at', { ascending: false }).limit(6),
            supabaseClient.from('tasks').select('*'),
            supabaseClient.from('agent_chats').select('chat_id,agent_id'),
            supabaseClient.from('agent_chats').select('id', { count: 'exact', head: true })
        ]);

        const agents = agentsR.data || [];
        const projects = projectsR.data || [];
        const managers = managersR.data || [];
        let scripts = scriptsR.data || [];
        let scriptsRecent = scriptsRecentR.data || [];
        let tasks = tasksR.data || [];
        let chats = chatsR.data || [];
        let msgCount = msgsR.count || 0;

        const cutoff = rangeCutoff();
        if (cutoff) {
            tasks = tasks.filter(t => t.created_at && new Date(t.created_at) >= cutoff);
            chats = chats.filter(c => c.created_at && new Date(c.created_at) >= cutoff);
            scripts = scripts.filter(s => s.created_at && new Date(s.created_at) >= cutoff);
            scriptsRecent = scriptsRecent.filter(s => s.created_at && new Date(s.created_at) >= cutoff);
            msgCount = tasks.length; // msgCount head query is global; keep cardinal using tasks when filtered
        }

        // ─── Cards ──────────────────────────────────────────
        grid.innerHTML = [
            buildCard('Агентов', agents.length, 'Telegram-боты'),
            buildCard('Проектов', projects.length, 'обучение агентов'),
            buildCard('Менеджеров', managers.length, 'получают задачи'),
            buildCard('Скриптов', scripts.length, 'в библиотеке'),
            buildCard('Диалогов', new Set(chats.map(c => c.chat_id)).size, 'уникальных клиентов'),
            buildCard('Сообщений', msgCount, 'в переписках агентов')
        ].join('');

        // ─── Tasks overview ────────────────────────────────
        const pending = tasks.filter(t => t.status === 'pending');
        const confirmed = tasks.filter(t => t.status === 'confirmed');
        const done = tasks.filter(t => t.status === 'done');
        const active = tasks.filter(t => t.status !== 'done');
        const overdue = active.filter(t => t.due_at && new Date(t.due_at) < now);
        const dueToday = active.filter(t => t.due_at && isSameDay(new Date(t.due_at), now));

        const doneRate = tasks.length ? Math.round((done.length / tasks.length) * 100) : 0;

        let taskHtml = `
            <h3 style="margin: 0 0 1rem;">Задачи</h3>
            <div class="stat-task-row">
                <span>Всего</span><b>${tasks.length}</b>
                <span>В работе</span><b>${pending.length + confirmed.length}</b>
                <span>Выполнено</span><b>${done.length}</b>
            </div>
            <div class="stat-bar"><div class="stat-bar-fill" style="width:${doneRate}%"></div></div>
            <div class="stat-bar-label">Выполнено ${doneRate}%</div>
        `;
        taskHtml += `<div class="stat-alerts">`;
        if (overdue.length) {
            taskHtml += `<div class="stat-alert stat-alert-bad">⚠️ Просрочено: <b>${overdue.length}</b> — задачи с прошлым дедлайном</div>`;
        } else {
            taskHtml += `<div class="stat-alert stat-alert-good">✓ Просроченных нет</div>`;
        }
        taskHtml += dueToday.length
            ? `<div class="stat-alert">🕒 Дедлайн сегодня: <b>${dueToday.length}</b></div>`
            : '';
        taskHtml += pending.length
            ? `<div class="stat-alert">⏳ Не подтверждено менеджером: <b>${pending.length}</b></div>`
            : '';
        taskHtml += `</div>`;
        tasksBox.innerHTML = taskHtml;

        // ─── Tasks by manager ───────────────────────────────
        if (managersBox) {
            const byManager = {};
            tasks.forEach(t => {
                const key = t.manager || 'Без менеджера';
                if (!byManager[key]) byManager[key] = { total: 0, done: 0, pending: 0, confirmed: 0, overdue: 0 };
                byManager[key].total++;
                if (t.status === 'done') byManager[key].done++;
                else if (t.status === 'confirmed') byManager[key].confirmed++;
                else byManager[key].pending++;
                if (t.status !== 'done' && t.due_at && new Date(t.due_at) < now) byManager[key].overdue++;
            });
            managers.forEach(m => {
                const key = m.name || 'Без менеджера';
                if (!byManager[key]) byManager[key] = { total: 0, done: 0, pending: 0, confirmed: 0, overdue: 0 };
            });

            const rows = Object.entries(byManager).sort((a, b) =>
                (b[1].overdue - a[1].overdue) || (b[1].total - a[1].total));

            if (rows.length === 0) {
                managersBox.innerHTML = '<div class="agents-empty">Задач пока нет.</div>';
            } else {
                managersBox.innerHTML = rows.map(([name, s]) => {
                    const rate = s.total ? Math.round((s.done / s.total) * 100) : 0;
                    const status = s.overdue
                        ? `<span class="stat-alert stat-alert-bad" style="padding:0.15rem 0.5rem;">⚠ ${s.overdue} просрочено</span>`
                        : '<span style="color:#22c55e; font-size:0.8rem;">✓ без просрочек</span>';
                    return `
                        <div style="display:flex; align-items:center; gap:0.8rem; padding:0.5rem 0; border-bottom:1px solid rgba(148,163,184,0.08); flex-wrap:wrap;">
                            <span style="min-width:130px; font-size:0.9rem;">${esc(name)}</span>
                            <div class="stat-bar" style="flex:1; min-width:140px;">
                                <div class="stat-bar-fill" style="width:${rate}%; ${rate >= 70 ? '' : 'background:linear-gradient(90deg,#f59e0b,#d97706);'}"></div>
                            </div>
                            <span style="font-size:0.8rem; color:var(--muted, #9aa3b2); min-width:170px;">
                                ${s.done}/${s.total} выполнено · ${rate}% · ${s.pending} ожидают · ${s.confirmed} в работе
                            </span>
                            ${status}
                        </div>`;
                }).join('');
            }
        }

        // ─── Dialogs by agent ──────────────────────────────
        if (dialogsBox) {
            const byAgent = {};
            chats.forEach(c => {
                const key = c.agent_id || 'unknown';
                if (!byAgent[key]) byAgent[key] = new Set();
                byAgent[key].add(c.chat_id);
            });

            const { data: agentsAll } = await supabaseClient.from('agents').select('id,name');
            const nameOf = {};
            (agentsAll || []).forEach(a => nameOf[a.id] = a.name);

            const keys = Object.keys(byAgent);
            dialogsBox.innerHTML = keys.length
                ? `<h3 style="margin: 0 0 1rem;">Диалоги по агентам</h3>`
                  + keys.map(k => `
                    <div class="stat-dialog-row">
                        <span class="stat-dialog-name">${esc(nameOf[k] || 'Агент')}</span>
                        <span class="stat-dialog-count">${byAgent[k].size} клиентов</span>
                    </div>`).join('')
                : `<h3 style="margin: 0 0 1rem;">Диалоги</h3><div class="agents-empty">Переписки появятся, когда клиенты напишут вашим агентам.</div>`;
        }

        // ─── Recent scripts ────────────────────────────────
        if (recentBox) {
            recentBox.innerHTML = scriptsRecent.length
                ? scriptsRecent.map(s => `
                    <div class="stat-script-row">
                        <div style="flex:1; min-width:0;">
                            <div class="stat-script-offer">${esc(s.lead_name || 'Без названия')}</div>
                            <div class="stat-script-meta">${fmtDate(s.created_at)}</div>
                        </div>
                    </div>`).join('')
                : '<div class="agents-empty">Скрипты появятся после первой генерации.</div>';
        }
    }

    load();
    setInterval(load, 60000);
    if (rangeSelect) rangeSelect.addEventListener('change', load);
    if (refreshBtn) refreshBtn.addEventListener('click', () => { load(); refreshBtn.textContent = 'Обновляю...'; setTimeout(() => { refreshBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><polyline points="21 3 21 8 16 8"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><polyline points="3 21 3 16 8 16"/></svg> Обновить'; }, 1000); });
});