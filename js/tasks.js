document.addEventListener('DOMContentLoaded', () => {
    const TASKS_TABLE = 'tasks';
    const MANAGERS_TABLE = 'managers';

    let managersCache = [];
    let agentsCache = [];
    let tasksCache = [];
    let calendarMonth = new Date();
    let editingTaskId = null;

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    const STATUS_LABEL = { pending: 'Запланировано', confirmed: 'Подтверждено', done: 'Выполнено' };
    function statusClass(s) {
        return { pending: 'st-pending', confirmed: 'st-confirmed', done: 'st-done' }[s] || 'st-pending';
    }

    function fmtDate(iso) {
        if (!iso) return '—';
        return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }

    function toLocalInputValue(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    /* ─── Loaders ─────────────────────────────────────────────── */
    async function loadManagers() {
        const grid = document.getElementById('managers-list');
        if (!grid) return;
        const { data, error } = await supabaseClient.from(MANAGERS_TABLE).select('*').order('created_at', { ascending: true });
        if (error) {
            grid.innerHTML = `<div class="agents-empty glass">Ошибка: ${escapeHtml(error.message)}<br>Выполните supabase-migration-2.sql в Supabase SQL Editor.</div>`;
            return;
        }
        managersCache = data || [];
        renderManagers();
    }

    function renderManagers() {
        const grid = document.getElementById('managers-list');
        if (!grid) return;
        if (managersCache.length === 0) {
            grid.innerHTML = '<div class="agents-empty glass">Менеджеров пока нет. Добавьте менеджера и его Telegram chat ID — ему будут приходить задачи от агента.</div>';
            return;
        }
        grid.innerHTML = '';
        managersCache.forEach(m => {
            const card = document.createElement('div');
            card.className = 'project-card';
            card.innerHTML = `
                <div class="project-card-top">
                    <div class="project-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
                    <div style="flex:1; min-width:0;">
                        <div class="project-name">${escapeHtml(m.name)}</div>
                        <div class="project-desc" style="font-family:var(--font-mono); font-size:0.72rem;">chat ID: ${escapeHtml(m.chat_id || '—')}</div>
                        ${m.agent_id ? `<div class="project-desc">🤖 Агент: ${escapeHtml(agentName(m.agent_id))}</div>` : ''}
                    </div>
                </div>
                <div class="agent-card-actions">
                    <button class="island island-sm island-danger js-manager-delete">Удалить</button>
                </div>
            `;
            card.querySelector('.js-manager-delete').addEventListener('click', async () => {
                if (!confirm(`Удалить менеджера «${m.name}»?`)) return;
                await supabaseClient.from(MANAGERS_TABLE).delete().eq('id', m.id);
                loadManagers();
            });
            grid.appendChild(card);
        });
    }

    async function loadAgents() {
        const { data, error } = await supabaseClient.from('agents').select('*').order('created_at', { ascending: false });
        if (!error) agentsCache = data || [];
    }

    async function loadTasks() {
        if (window.__roleReady) await window.__roleReady;
        let req = supabaseClient.from(TASKS_TABLE).select('*').order('created_at', { ascending: true });
        if (window.__scope && window.__scope.isManager && window.__scope.chatId) {
            req = req.eq('chat_id', window.__scope.chatId);
        }
        const { data, error } = await req;
        if (error) return;
        tasksCache = data || [];
        renderCalendar();
        renderTasksList();
    }

    /* ─── Calendar ────────────────────────────────────────────── */
    function renderCalendar() {
        const cal = document.getElementById('calendar');
        if (!cal) return;

        const now = new Date();
        const overdueCount = tasksCache.filter(t =>
            t.status !== 'done' && t.due_at && new Date(t.due_at) < now).length;
        document.querySelectorAll('.tasks-badge').forEach(b => {
            b.textContent = overdueCount > 99 ? '99+' : overdueCount;
            b.classList.toggle('show', overdueCount > 0);
        });

        const byDay = {};
        tasksCache.forEach(t => {
            if (!t.due_at) return;
            const d = new Date(t.due_at);
            const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
            if (!byDay[key]) byDay[key] = [];
            byDay[key].push(t);
        });

        const year = calendarMonth.getFullYear();
        const month = calendarMonth.getMonth();
        const today = new Date();
        const todayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
        const monthName = calendarMonth.toLocaleString('ru-RU', { month: 'long', year: 'numeric' });
        const first = new Date(year, month, 1);
        const startDow = (first.getDay() + 6) % 7; // Monday-first
        const daysInMonth = new Date(year, month + 1, 0).getDate();

        let cells = '';
        for (let i = 0; i < startDow; i++) cells += '<div class="cal-cell cal-empty"></div>';
        for (let d = 1; d <= daysInMonth; d++) {
            const key = `${year}-${month}-${d}`;
            const dayTasks = byDay[key] || [];
            const isToday = key === todayKey;
            const pending = dayTasks.filter(t => t.status !== 'done');
            const open = dayTasks.filter(t => t.status === 'done');
            const overdue = dayTasks.filter(t => t.status !== 'done' && t.due_at && new Date(t.due_at) < now);
            cells += `
                <div class="cal-cell ${isToday ? 'cal-today' : ''}" data-day="${d}">
                    <div class="cal-day-num">${d}</div>
                    ${pending.length ? `<div class="cal-dot ${overdue.length ? 'cal-dot-overdue' : 'cal-dot-open'}"></div>` : ''}
                    ${open.length ? `<div class="cal-dot cal-dot-done"></div>` : ''}
                    ${pending.length ? `<div class="cal-count">${pending.length}</div>` : ''}
                </div>`;
        }

        cal.innerHTML = `
            <div class="cal-head">
                <button class="island island-sm" id="cal-prev">‹</button>
                <div class="cal-month">${escapeHtml(monthName)}</div>
                <button class="island island-sm" id="cal-next">›</button>
            </div>
            <div class="cal-grid">
                ${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(d => `<div class="cal-dow">${d}</div>`).join('')}
                ${cells}
            </div>
            <div class="cal-legend">
                <span><span class="cal-dot cal-dot-open"></span> активные</span>
                <span><span class="cal-dot cal-dot-done"></span> выполнено</span>
            </div>
        `;

        document.getElementById('cal-prev').addEventListener('click', () => { calendarMonth = new Date(year, month - 1, 1); renderCalendar(); });
        document.getElementById('cal-next').addEventListener('click', () => { calendarMonth = new Date(year, month + 1, 1); renderCalendar(); });
        cal.querySelectorAll('.cal-cell:not(.cal-empty)').forEach(cell => {
            cell.addEventListener('click', () => {
                const day = Number(cell.dataset.day);
                const d = new Date(year, month, day);
                const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
                openDayTasks(byDay[key] || [], d);
            });
        });
    }

    function openDayTasks(dayTasks, date) {
        const list = document.getElementById('tasks-list');
        if (!list) return;
        const p = n => String(n).padStart(2, '0');
        const dateKey = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
        const filtered = tasksCache.filter(t => t.due_at && new Date(t.due_at).getFullYear() === date.getFullYear()
            && new Date(t.due_at).getMonth() === date.getMonth() && new Date(t.due_at).getDate() === date.getDate());
        list.innerHTML = `<div class="tasks-filter-info">Задачи на ${escapeHtml(date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }))} <button class="island island-sm" id="clear-day-filter" style="margin-left:0.5rem;">Показать все</button></div>`;
        if (dayTasks.length === 0) {
            list.innerHTML += '<div class="agents-empty glass">На этот день задач нет.</div>';
        } else {
            dayTasks.slice().sort((a, b) => (a.due_at || '') < (b.due_at || '') ? -1 : 1).forEach(t => list.appendChild(buildTaskCard(t)));
        }
        document.getElementById('clear-day-filter').addEventListener('click', () => { renderCalendar(); renderTasksList(); });
    }

    /* ─── Tasks list ──────────────────────────────────────────── */
    function renderTasksList() {
        const list = document.getElementById('tasks-list');
        if (!list) return;
        list.innerHTML = '';
        if (tasksCache.length === 0) {
            list.innerHTML = '<div class="agents-empty glass">Задач пока нет. Создайте первую задачу и назначьте менеджера — агент уведомит его в Telegram.</div>';
            return;
        }
        const sorted = tasksCache.slice().sort((a, b) => {
            if (!a.due_at) return 1;
            if (!b.due_at) return -1;
            return a.due_at < b.due_at ? -1 : 1;
        });
        sorted.forEach(t => list.appendChild(buildTaskCard(t)));
    }

    function buildTaskCard(t) {
        const isOverdue = t.status !== 'done' && t.due_at && new Date(t.due_at) < new Date();
        const card = document.createElement('div');
        card.className = 'task-card' + (isOverdue ? ' task-overdue' : '');
        card.innerHTML = `
            <div class="task-card-top">
                <div class="task-title">${escapeHtml(t.title)}</div>
                <span class="task-status ${statusClass(t.status)}">${STATUS_LABEL[t.status] || t.status}</span>
            </div>
            ${t.description ? `<div class="task-desc">${escapeHtml(t.description)}</div>` : ''}
            ${isOverdue ? `<div class="task-overdue-badge">⚠️ Просрочено</div>` : ''}
            <div class="task-meta-row">
                <span>🕒 ${fmtDate(t.due_at)}</span>
                ${t.manager ? `<span>👤 ${escapeHtml(t.manager)}</span>` : ''}
                ${t.lead_name ? `<span>🎯 ${escapeHtml(t.lead_name)}${t.lead_contact ? ' · ' + escapeHtml(t.lead_contact) : ''}</span>` : ''}
            </div>
            <div class="agent-card-actions" style="flex-wrap:wrap;">
                ${t.status !== 'done' ? `<button class="island island-sm js-task-notify">Уведомить</button>` : ''}
                ${t.status === 'pending' ? `<button class="island island-sm js-task-confirm">Подтвердить</button>` : ''}
                ${t.status !== 'done' ? `<button class="island island-sm js-task-done">Готово</button>` : ''}
                <button class="island island-sm js-task-edit">Изменить</button>
                <button class="island island-sm island-danger js-task-delete">Удалить</button>
            </div>
        `;

        card.querySelector('.js-task-notify').addEventListener('click', async () => {
            const btn = card.querySelector('.js-task-notify');
            btn.disabled = true;
            btn.textContent = '...';
            try {
                const res = await fetch('/api/telegram/task', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ taskId: t.id })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Ошибка');
                alert('Уведомление отправлено менеджеру в Telegram.');
            } catch (err) {
                alert('Ошибка: ' + err.message);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Уведомить';
            }
        });

        const setStatus = async (status) => {
            await supabaseClient.from(TASKS_TABLE).update({ status }).eq('id', t.id);
            loadTasks();
        };
        card.querySelector('.js-task-confirm').addEventListener('click', () => setStatus('confirmed'));
        card.querySelector('.js-task-done').addEventListener('click', () => setStatus('done'));
        card.querySelector('.js-task-edit').addEventListener('click', () => openTaskModal(t));
        card.querySelector('.js-task-delete').addEventListener('click', async () => {
            if (!confirm('Удалить задачу?')) return;
            await supabaseClient.from(TASKS_TABLE).delete().eq('id', t.id);
            loadTasks();
        });

        return card;
    }

    /* ─── Task modal ──────────────────────────────────────────── */
    const taskModal = document.getElementById('task-modal');
    const taskForm = document.getElementById('task-form');
    const taskTitleInput = document.getElementById('task-title');
    const taskDateInput = document.getElementById('task-due');
    const taskManagerInput = document.getElementById('task-manager');
    const taskAgentInput = document.getElementById('task-agent');

    if (taskManagerInput && taskAgentInput) {
        taskManagerInput.addEventListener('change', () => {
            const m = managersCache.find(x => x.name === taskManagerInput.value);
            if (m && m.agent_id) {
                taskAgentInput.value = m.agent_id;
            }
        });
    }
    const taskDescInput = document.getElementById('task-desc');
    const taskIdInput = document.getElementById('task-id');
    const taskLeadInput = document.getElementById('task-lead');

    window.__openLeadTask = (lead) => {
        openTaskModal(null, {
            title: `Перезвонить клиенту: ${lead.name || ''}`,
            lead: lead
        });
    };

    function openTaskModal(task, prefill) {
        taskForm.reset();
        taskIdInput.value = task ? task.id : '';
        taskTitleInput.value = task ? task.title : (prefill && prefill.title) || '';
        taskDateInput.value = task ? toLocalInputValue(task.due_at) : '';
        taskDescInput.value = task ? (task.description || '') : '';
        taskManagerInput.value = task ? (task.manager || '') : '';
        taskAgentInput.value = task ? (task.agent_id || '') : '';
        taskLeadInput.value = task ? JSON.stringify({ name: task.lead_name, contact: task.lead_contact }) : (prefill && prefill.lead ? JSON.stringify(prefill.lead) : '');

        taskManagerInput.innerHTML = '';
        const scopeMgr = (window.__scope && window.__scope.isManager) ? window.__scope.name : null;
        const allowedManagers = scopeMgr ? managersCache.filter(m => m.name === scopeMgr) : managersCache;
        if (allowedManagers.length === 0) {
            allowedManagers.push({ name: scopeMgr || '', chat_id: '' });
        }
        allowedManagers.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.name;
            opt.textContent = `${m.name}${m.chat_id ? ' (chat: ' + m.chat_id + ')' : ''}`;
            taskManagerInput.appendChild(opt);
        });
        if (task && task.manager) taskManagerInput.value = task.manager;
        else if (scopeMgr) taskManagerInput.value = scopeMgr;

        taskAgentInput.innerHTML = '';
        const telegramAgents = agentsCache.filter(a => a.platform === 'telegram');
        if (telegramAgents.length === 0) {
            taskAgentInput.innerHTML = '<option value="">— сначала добавьте Telegram-агента —</option>';
        } else {
            taskAgentInput.innerHTML = '<option value="">— выберите агента для уведомления —</option>';
            telegramAgents.forEach(a => {
                const opt = document.createElement('option');
                opt.value = a.id;
                opt.textContent = a.name || 'Агент';
                taskAgentInput.appendChild(opt);
            });
        }
        if (task && task.agent_id) taskAgentInput.value = task.agent_id;

        document.getElementById('task-modal-title').textContent = task ? 'Изменить задачу' : 'Новая задача';
        taskModal.classList.add('open');
    }

    function closeTaskModal() { taskModal.classList.remove('open'); }

    if (document.getElementById('task-add-btn')) {
        document.getElementById('task-add-btn').addEventListener('click', () => openTaskModal(null));
    }
    if (document.getElementById('task-modal-close')) {
        document.getElementById('task-modal-close').addEventListener('click', closeTaskModal);
    }
    if (taskModal) taskModal.addEventListener('click', e => { if (e.target === taskModal) closeTaskModal(); });

    if (taskForm) taskForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = taskTitleInput.value.trim();
        if (!title) return;
        const managerName = taskManagerInput.value;
        const manager = managersCache.find(m => m.name === managerName);
        const lead = taskLeadInput.value ? JSON.parse(taskLeadInput.value) : null;

        const payload = {
            title: title,
            description: taskDescInput.value.trim(),
            due_at: taskDateInput.value ? new Date(taskDateInput.value).toISOString() : null,
            manager: managerName || null,
            chat_id: manager ? manager.chat_id : null,
            agent_id: taskAgentInput.value || null,
            status: 'pending',
            lead_name: lead ? lead.name : null,
            lead_contact: lead ? lead.contact : null
        };

        const id = taskIdInput.value;
        const { data, error } = id
            ? await supabaseClient.from(TASKS_TABLE).update(payload).eq('id', id).select()
            : await supabaseClient.from(TASKS_TABLE).insert(payload).select();
        if (error) { alert('Ошибка сохранения: ' + error.message); return; }

        closeTaskModal();
        const task = data && data[0];

        if (!id && task && task.agent_id && task.chat_id) {
            try {
                await fetch('/api/telegram/task', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ taskId: task.id })
                });
            } catch (err) { console.error('Notify error:', err); }
        }

        loadTasks();
    });

    /* ─── Managers modal ──────────────────────────────────────── */
    const managerModal = document.getElementById('manager-modal');
    const managerForm = document.getElementById('manager-form');
    const managerNameInput = document.getElementById('manager-name');
    const managerChatInput = document.getElementById('manager-chat');
    const managerAgentInput = document.getElementById('manager-agent');

    function agentName(id) {
        const a = agentsCache.find(x => x.id === id);
        return a ? a.name : '';
    }

    async function populateManagerAgents() {
        if (!managerAgentInput) return;
        if (agentsCache.length === 0) await loadAgents();
        const telegramAgents = agentsCache.filter(a => a.platform === 'telegram');
        managerAgentInput.innerHTML = '<option value="">— без агента —</option>';
        telegramAgents.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a.id;
            opt.textContent = a.name || 'Агент';
            managerAgentInput.appendChild(opt);
        });
    }

    if (document.getElementById('manager-add-btn')) {
        document.getElementById('manager-add-btn').addEventListener('click', () => {
            managerForm.reset();
            managerAgentInput.value = '';
            managerModal.classList.add('open');
            populateManagerAgents();
        });
    }
    if (document.getElementById('manager-modal-close')) {
        document.getElementById('manager-modal-close').addEventListener('click', () => managerModal.classList.remove('open'));
    }
    if (managerModal) managerModal.addEventListener('click', e => { if (e.target === managerModal) managerModal.classList.remove('open'); });

    if (managerForm) managerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = managerNameInput.value.trim();
        const chatId = managerChatInput.value.trim();
        if (!name) return;
        const { error } = await supabaseClient.from(MANAGERS_TABLE).insert({
            name,
            chat_id: chatId || null,
            agent_id: managerAgentInput.value || null
        });
        if (error) { alert('Ошибка: ' + error.message); return; }
        managerModal.classList.remove('open');
        loadManagers();
    });

    /* ─── Init ────────────────────────────────────────────────── */
    loadAgents();
    loadManagers();
    loadTasks();
});
