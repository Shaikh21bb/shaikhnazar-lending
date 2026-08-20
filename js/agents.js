document.addEventListener('DOMContentLoaded', () => {
    const AGENTS_TABLE = 'agents';
    const PROJECTS_TABLE = 'projects';
    const CHATS_TABLE = 'agent_chats';

    let projectsCache = [];
    let currentDialogsAgent = null;
    let currentChatId = null;
    let dialogsMessages = [];

    document.querySelectorAll('.nav-item:not(.disabled)').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            const view = item.getAttribute('href').slice(1);
            document.querySelectorAll('.dashboard-view').forEach(v => v.classList.remove('active-view'));
            const target = document.getElementById('view-' + view);
            if (target) target.classList.add('active-view');
        });
    });

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function platformLabel(p) {
        return p === 'telegram' ? 'Telegram' : 'WhatsApp';
    }

    const TELEGRAM_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>';
    const WHATSAPP_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/></svg>';

    function projectName(id) {
        const p = projectsCache.find(x => x.id === id);
        return p ? p.name : '';
    }

    /* ─── Projects (training) ─────────────────────────────────── */
    async function loadProjects() {
        const grid = document.getElementById('projects-grid');
        if (!grid) return;
        try {
            const { data, error } = await supabaseClient.from(PROJECTS_TABLE).select('*').order('created_at', { ascending: true });
            if (error) throw error;
            projectsCache = data || [];
            renderProjects();
        } catch (err) {
            projectsCache = [];
            grid.innerHTML = `
                <div class="agents-empty glass">
                    База знаний пока недоступна.<br>
                    Выполните SQL-миграцию из файла <strong>supabase-migration.sql</strong> в Supabase → SQL Editor.<br>
                    <span style="color:var(--faint); font-size:0.8rem;">${escapeHtml(err.message)}</span>
                </div>`;
        }
        loadAgents();
    }

    function renderProjects() {
        const grid = document.getElementById('projects-grid');
        if (!grid) return;
        if (projectsCache.length === 0) {
            grid.innerHTML = '<div class="agents-empty glass">Проектов пока нет. Добавьте проект с базой знаний — это то, на чём агенты будут «обучаться» и отвечать клиентам.</div>';
            return;
        }
        grid.innerHTML = '';
        projectsCache.forEach(p => grid.appendChild(buildProjectCard(p)));
    }

    function buildProjectCard(p) {
        const agentsCount = window.__agentsForProject ? window.__agentsForProject(p.id) : 0;
        const card = document.createElement('div');
        card.className = 'project-card';
        card.innerHTML = `
            <div class="project-card-top">
                <div class="project-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></div>
                <div style="flex:1; min-width:0;">
                    <div class="project-name">${escapeHtml(p.name)}</div>
                    ${p.description ? `<div class="project-desc">${escapeHtml(p.description)}</div>` : ''}
                </div>
            </div>
            <div class="project-knowledge-preview">${escapeHtml((p.knowledge || 'База знаний пуста — агент будет отвечать без обучения.').slice(0, 160))}${(p.knowledge || '').length > 160 ? '…' : ''}</div>
            <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
                ${agentsCount > 0 ? `<span class="project-chip">${agentsCount} агент(ов)</span>` : ''}
            </div>
            <div class="agent-card-actions">
                <button class="island island-sm js-project-edit">Редактировать</button>
                <button class="island island-sm island-danger js-project-delete">Удалить</button>
            </div>
        `;

        card.querySelector('.js-project-edit').addEventListener('click', () => openProjectModal(p));
        card.querySelector('.js-project-delete').addEventListener('click', async () => {
            if (!confirm(`Удалить проект «${p.name}»? Агенты, обученные на нём, останутся без обучения.`)) return;
            await supabaseClient.from(PROJECTS_TABLE).delete().eq('id', p.id);
            loadProjects();
        });
        return card;
    }

    window.__agentsForProject = (projectId) => 0;

    const projectModal = document.getElementById('project-modal');
    const projectForm = document.getElementById('project-form');
    const projectNameInput = document.getElementById('project-name');
    const projectDescInput = document.getElementById('project-desc');
    const projectKnowledgeInput = document.getElementById('project-knowledge');
    const projectIdInput = document.getElementById('project-id');
    const projectTitle = document.getElementById('project-modal-title');

    function openProjectModal(project) {
        projectForm.reset();
        projectIdInput.value = project ? project.id : '';
        projectNameInput.value = project ? project.name : '';
        projectDescInput.value = project ? (project.description || '') : '';
        projectKnowledgeInput.value = project ? (project.knowledge || '') : '';
        projectTitle.textContent = project ? 'Редактировать проект' : 'Новый проект';
        projectModal.classList.add('open');
        setTimeout(() => projectNameInput.focus(), 100);
    }

    function closeProjectModal() { projectModal.classList.remove('open'); }

    if (document.getElementById('project-add-btn')) {
        document.getElementById('project-add-btn').addEventListener('click', () => openProjectModal(null));
    }
    if (document.getElementById('project-modal-close')) {
        document.getElementById('project-modal-close').addEventListener('click', closeProjectModal);
    }
    if (projectModal) projectModal.addEventListener('click', e => { if (e.target === projectModal) closeProjectModal(); });

    if (projectForm) projectForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = projectNameInput.value.trim();
        if (!name) return;
        const payload = {
            name: name,
            description: projectDescInput.value.trim(),
            knowledge: projectKnowledgeInput.value
        };
        const id = projectIdInput.value;
        const { error } = id
            ? await supabaseClient.from(PROJECTS_TABLE).update(payload).eq('id', id)
            : await supabaseClient.from(PROJECTS_TABLE).insert(payload);
        if (error) { alert('Ошибка сохранения: ' + error.message); return; }
        closeProjectModal();
        loadProjects();
    });

    /* ─── Agents ──────────────────────────────────────────────── */
    let allAgents = [];

    async function loadAgents() {
        const grid = document.getElementById('agents-grid');
        if (!grid) return;
        const { data, error } = await supabaseClient.from(AGENTS_TABLE).select('*').order('created_at', { ascending: false });
        if (error) {
            grid.innerHTML = `<div class="agents-empty glass">Ошибка загрузки: ${escapeHtml(error.message)}</div>`;
            return;
        }
        allAgents = data || [];
        window.__agentsForProject = (projectId) => allAgents.filter(a => a.project_id === projectId).length;
        if (allAgents.length === 0) {
            grid.innerHTML = '<div class="agents-empty glass">Агентов пока нет. Нажмите «Добавить агента», чтобы подключить первого бота для Telegram.</div>';
            return;
        }
        grid.innerHTML = '';
        allAgents.forEach(agent => grid.appendChild(buildAgentCard(agent)));
    }

    function buildAgentCard(agent) {
        const isActive = agent.status === 'active';
        const isTelegram = agent.platform === 'telegram';
        const isConnected = !!agent.connected;

        const card = document.createElement('div');
        card.className = 'agent-card';
        card.innerHTML = `
            <div class="agent-card-top">
                <div class="agent-icon ${isTelegram ? 'agent-telegram' : 'agent-whatsapp'}">${isTelegram ? TELEGRAM_ICON : WHATSAPP_ICON}</div>
                <div style="flex:1; min-width:0;">
                    <div class="agent-name">${escapeHtml(agent.name || 'Без имени')}</div>
                    <div class="agent-meta">${platformLabel(agent.platform)} · ${escapeHtml(agent.token || 'нет токена')}</div>
                    ${isConnected ? '<div class="connected-badge">Бот подключён</div>' : ''}
                </div>
                <span class="agent-status ${isActive ? 'status-active' : 'status-paused'}">${isActive ? 'Активен' : 'Пауза'}</span>
            </div>

            ${isTelegram ? `
            <div class="agent-project-select-wrap">
                <select class="agent-project-select" data-id="${agent.id}">
                    <option value="">— без обучения —</option>
                    ${projectsCache.map(p => `<option value="${p.id}" ${agent.project_id === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
                </select>
            </div>
            <div class="agent-project-select-wrap">
                <select class="agent-project-select agent-lang-select" data-id="${agent.id}">
                    <option value="ru" ${agent.language !== 'kk' ? 'selected' : ''}>Язык ответов: Русский</option>
                    <option value="kk" ${agent.language === 'kk' ? 'selected' : ''}>Язык ответов: Қазақша</option>
                </select>
            </div>` : ''}

            <div class="agent-card-actions" style="flex-wrap:wrap;">
                ${isTelegram ? `<button class="island island-sm js-agent-dialogs">Диалоги</button>` : ''}
                ${isTelegram ? `<button class="island island-sm js-agent-broadcast">Рассылка</button>` : ''}
                <button class="island island-sm js-agent-toggle">${isActive ? 'Пауза' : 'Запустить'}</button>
                ${isTelegram && !isConnected
                    ? `<button class="island island-sm js-agent-connect">Подключить бота</button>`
                    : (isTelegram ? `<button class="island island-sm js-agent-connect">Отключить</button>` : '')}
                <button class="island island-sm island-danger js-agent-delete">Удалить</button>
            </div>
        `;

        card.querySelector('.js-agent-toggle').addEventListener('click', async () => {
            const next = isActive ? 'paused' : 'active';
            await supabaseClient.from(AGENTS_TABLE).update({ status: next }).eq('id', agent.id);
            loadAgents();
        });

        card.querySelector('.js-agent-delete').addEventListener('click', async () => {
            if (!confirm(`Удалить агента «${agent.name || ''}»?`)) return;
            await supabaseClient.from(AGENTS_TABLE).delete().eq('id', agent.id);
            loadAgents();
        });

        const connectBtn = card.querySelector('.js-agent-connect');
        if (connectBtn) connectBtn.addEventListener('click', async () => {
            connectBtn.disabled = true;
            connectBtn.textContent = '...';
            try {
                const res = await fetch('/api/telegram/connect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: agent.id, action: isConnected ? 'disconnect' : 'connect' })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Ошибка');
                alert(isConnected ? 'Бот отключён.' : `Бот подключён! Теперь напишите боту в Telegram — он ответит как обученный агент.`);
            } catch (err) {
                alert('Ошибка подключения: ' + err.message + '\nУбедитесь, что сайт задеплоен на Vercel (webhook нужен публичный HTTPS URL).');
            } finally {
                connectBtn.disabled = false;
                loadAgents();
            }
        });

        const projectSelect = card.querySelector('.agent-project-select');
        if (projectSelect) projectSelect.addEventListener('change', async () => {
            await supabaseClient.from(AGENTS_TABLE).update({ project_id: projectSelect.value || null }).eq('id', agent.id);
            loadAgents();
        });

        const langSelect = card.querySelector('.agent-lang-select');
        if (langSelect) langSelect.addEventListener('change', async () => {
            await supabaseClient.from(AGENTS_TABLE).update({ language: langSelect.value }).eq('id', agent.id);
            loadAgents();
        });

        const dialogsBtn = card.querySelector('.js-agent-dialogs');
        if (dialogsBtn) dialogsBtn.addEventListener('click', () => openDialogs(agent));

        const broadcastBtn = card.querySelector('.js-agent-broadcast');
        if (broadcastBtn) broadcastBtn.addEventListener('click', () => openBroadcast(agent));

        return card;
    }

    /* ─── Broadcast ───────────────────────────────────────────── */
    async function openBroadcast(agent) {
        const modal = document.getElementById('broadcast-modal');
        const agentIdInput = document.getElementById('broadcast-agent-id');
        const textInput = document.getElementById('broadcast-text');
        const hint = document.getElementById('broadcast-hint');
        const result = document.getElementById('broadcast-result');
        if (!modal || !agentIdInput) return;

        agentIdInput.value = agent.id;
        document.getElementById('broadcast-title').textContent = `Рассылка · ${agent.name || ''}`;
        textInput.value = '';
        result.style.display = 'none';
        result.innerHTML = '';

        const { data } = await supabaseClient
            .from(CHATS_TABLE)
            .select('chat_id')
            .eq('agent_id', agent.id);
        const recipients = new Set((data || []).map(r => r.chat_id)).size;
        hint.textContent = recipients
            ? `Сообщение придёт ${recipients} клиенту(-ам), которые писали этому агенту.`
            : 'Пока нет клиентов, которые писали этому агенту. Клиенты появятся после первых сообщений в бота.';

        modal.classList.add('open');
        setTimeout(() => textInput.focus(), 100);
    }

    const broadcastModal = document.getElementById('broadcast-modal');
    const broadcastForm = document.getElementById('broadcast-form');

    if (document.getElementById('broadcast-modal-close')) {
        document.getElementById('broadcast-modal-close').addEventListener('click', () => broadcastModal.classList.remove('open'));
    }
    if (broadcastModal) broadcastModal.addEventListener('click', e => { if (e.target === broadcastModal) broadcastModal.classList.remove('open'); });

    if (broadcastForm) broadcastForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const sendBtn = document.getElementById('broadcast-send');
        const result = document.getElementById('broadcast-result');
        const text = document.getElementById('broadcast-text').value.trim();
        const id = document.getElementById('broadcast-agent-id').value;
        if (!text) return;

        sendBtn.disabled = true;
        sendBtn.textContent = 'Отправляем...';
        result.style.display = 'block';
        result.innerHTML = '<div class="chat-empty" style="padding:0.8rem;"><span class="spinner"></span> Идёт отправка...</div>';

        try {
            const res = await fetch('/api/telegram/broadcast', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: id, text: text })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка');

            result.style.display = 'block';
            result.innerHTML = `<div class="stat-alert ${data.failed ? 'stat-alert-bad' : 'stat-alert-good'}" style="margin-top:0.8rem;">
                ${data.failed ? '⚠️' : '✅'} Отправлено: <b>${data.sent}</b> из <b>${data.total}</b>${data.failed ? `, ошибок: <b>${data.failed}</b>` : ''}
            </div>`;
            sendBtn.textContent = '✔ Отправлено';
            setTimeout(() => {
                broadcastModal.classList.remove('open');
                sendBtn.textContent = 'Отправить рассылку';
                sendBtn.disabled = false;
            }, 1800);
        } catch (err) {
            result.style.display = 'block';
            result.innerHTML = `<div class="stat-alert stat-alert-bad" style="margin-top:0.8rem;">Ошибка: ${escapeHtml(err.message)}</div>`;
            sendBtn.textContent = 'Отправить рассылку';
            sendBtn.disabled = false;
        }
    });

    /* ─── Dialogs ─────────────────────────────────────────────── */
    function openDialogs(agent) {
        currentDialogsAgent = agent;
        currentChatId = null;
        dialogsMessages = [];
        document.getElementById('dialogs-title').textContent = `Диалоги · ${agent.name || ''}`;
        document.getElementById('dialogs-modal').classList.add('open');
        renderDialogs();
    }

    async function renderDialogs() {
        const body = document.getElementById('dialogs-body');
        if (!currentDialogsAgent) return;

        const { data, error } = await supabaseClient
            .from(CHATS_TABLE)
            .select('*')
            .eq('agent_id', currentDialogsAgent.id)
            .order('created_at', { ascending: true });

        if (error) {
            body.innerHTML = `<div class="chat-empty">Ошибка загрузки диалогов: ${escapeHtml(error.message)}</div>`;
            return;
        }
        dialogsMessages = data || [];

        const sessions = {};
        dialogsMessages.forEach(m => {
            const key = m.chat_id;
            if (!sessions[key]) sessions[key] = { chatId: key, messages: [] };
            sessions[key].messages.push(m);
        });

        if (currentChatId && sessions[currentChatId]) currentChatId = currentChatId;
        else currentChatId = Object.keys(sessions)[0] || null;

        const list = Object.values(sessions).sort((a, b) => {
            const aLast = a.messages[a.messages.length - 1].created_at;
            const bLast = b.messages[b.messages.length - 1].created_at;
            return aLast < bLast ? 1 : -1;
        });

        body.innerHTML = `
            <div class="new-chat-row">
                <input type="text" class="new-chat-input" id="new-chat-id" placeholder="Chat ID клиента в Telegram (напр. 123456789)" list="known-chats">
                <datalist id="known-chats">${list.map(s => `<option value="${escapeHtml(s.chatId)}">`).join('')}</datalist>
                <button class="agent-btn" id="new-chat-go" style="flex:0 0 auto; padding:0.55rem 1rem;">Открыть</button>
                <button class="agent-btn" id="dialog-to-task" style="flex:0 0 auto; padding:0.55rem 1rem;" title="Создать задачу по этому клиенту">В задачу</button>
                <button class="agent-btn" id="dialogs-export" style="flex:0 0 auto; padding:0.55rem 1rem;" title="Скачать все диалоги в .txt">Экспорт</button>
            </div>
            <div class="dialogs-layout">
                <div class="dialogs-list" id="dialogs-list">
                    ${list.length === 0 ? '<div class="chat-empty">Пока нет диалогов.<br>Когда кто-то напишет боту — он появится здесь, и вы сможете отвечать прямо из дашборда.</div>' : list.map(s => `
                        <button class="chat-session ${s.chatId === currentChatId ? 'active' : ''}" data-chat="${escapeHtml(s.chatId)}">
                            <div class="chat-session-id">${escapeHtml(s.chatId)}</div>
                            <div class="chat-session-preview">${escapeHtml((s.messages[s.messages.length - 1].text || '').slice(0, 42))}</div>
                        </button>`).join('')}
                </div>
                <div class="dialogs-thread" id="dialogs-thread">${renderThreadHtml()}</div>
            </div>
        `;

        body.querySelectorAll('.chat-session').forEach(btn => {
            btn.addEventListener('click', () => {
                currentChatId = btn.dataset.chat;
                renderDialogs();
            });
        });

        const goBtn = document.getElementById('new-chat-go');
        const newChatId = document.getElementById('new-chat-id');
        if (goBtn && newChatId) goBtn.addEventListener('click', () => {
            const v = newChatId.value.trim();
            if (!v) return;
            currentChatId = v;
            renderDialogs();
        });

        const exportBtn = document.getElementById('dialogs-export');
        if (exportBtn) exportBtn.addEventListener('click', () => exportDialogs());

        const toTaskBtn = document.getElementById('dialog-to-task');
        if (toTaskBtn) toTaskBtn.addEventListener('click', () => {
            if (!currentChatId) { alert('Сначала выберите чат клиента слева.'); return; }
            if (typeof window.__openLeadTask !== 'function') {
                alert('Раздел задач недоступен.');
                return;
            }
            document.getElementById('dialogs-modal').classList.remove('open');
            window.__openLeadTask({ name: 'Клиент ' + currentChatId, contact: currentChatId });
        });

        const replyInput = document.getElementById('chat-reply-input');
        const replyBtn = document.getElementById('chat-reply-send');
        const sendReply = async () => {
            if (!replyInput) return;
            const text = replyInput.value.trim();
            if (!text) return;
            replyBtn.disabled = true;
            try {
                const res = await fetch('/api/telegram/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: currentDialogsAgent.id, chatId: currentChatId, text: text })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Ошибка');
                replyInput.value = '';
                renderDialogs();
            } catch (err) {
                alert('Ошибка отправки: ' + err.message);
                replyBtn.disabled = false;
            }
        };
        if (replyBtn) replyBtn.addEventListener('click', sendReply);
        if (replyInput) replyInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); } });
    }

    function exportDialogs() {
        if (!currentDialogsAgent || dialogsMessages.length === 0) {
            alert('Пока нет сообщений для экспорта.');
            return;
        }

        const sessions = {};
        dialogsMessages.forEach(m => {
            if (!sessions[m.chat_id]) sessions[m.chat_id] = [];
            sessions[m.chat_id].push(m);
        });

        const lines = [];
        lines.push(`SHAIKH Industries · Диалоги агента «${currentDialogsAgent.name || ''}»`);
        lines.push(`Экспорт: ${new Date().toLocaleString('ru-RU')}`);
        lines.push(`Клиентов: ${Object.keys(sessions).length} · Сообщений: ${dialogsMessages.length}`);
        lines.push('');

        Object.keys(sessions).sort((a, b) => {
            const aLast = sessions[a][sessions[a].length - 1].created_at;
            const bLast = sessions[b][sessions[b].length - 1].created_at;
            return aLast < bLast ? 1 : -1;
        }).forEach(chatId => {
            lines.push(`========================================`);
            lines.push(`КЛИЕНТ ${chatId} — ${sessions[chatId].length} сообщений`);
            lines.push(`----------------------------------------`);
            sessions[chatId].forEach(m => {
                const time = new Date(m.created_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
                const who = m.role === 'user' ? 'Клиент' : 'Агент';
                lines.push(`[${time}] ${who}: ${m.text}`);
            });
            lines.push('');
        });

        const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `dialogs_${(currentDialogsAgent.name || 'agent').replace(/[^\wа-яё-]/gi, '_')}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    }

    function renderThreadHtml() {
        if (!currentChatId) {
            return '<div class="chat-empty">Выберите чат слева или откройте чат по ID клиента.</div>';
        }
        const messages = dialogsMessages.filter(m => m.chat_id === currentChatId);
        const html = messages.map(m => `
            <div class="chat-msg ${m.role === 'user' ? 'chat-msg-user' : 'chat-msg-bot'}">
                ${escapeHtml(m.text)}
                <span class="chat-msg-time">${escapeHtml(new Date(m.created_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span>
            </div>`).join('');
        return `
            <div style="flex:1; display:flex; flex-direction:column; gap:0.7rem; overflow-y:auto; min-height:200px;">
                ${html || '<div class="chat-empty">Сообщений в этом чате ещё нет.</div>'}
            </div>
            <div class="chat-reply-row">
                <input type="text" class="chat-reply-input" id="chat-reply-input" placeholder="Ответить от имени агента...">
                <button class="agent-btn agent-btn-primary" id="chat-reply-send" style="flex:0 0 auto;">Отправить</button>
            </div>`;
    }

    if (document.getElementById('dialogs-modal-close')) {
        document.getElementById('dialogs-modal-close').addEventListener('click', () => {
            document.getElementById('dialogs-modal').classList.remove('open');
        });
    }
    const dialogsModal = document.getElementById('dialogs-modal');
    if (dialogsModal) dialogsModal.addEventListener('click', e => { if (e.target === dialogsModal) dialogsModal.classList.remove('open'); });

    /* ─── Add agent modal ─────────────────────────────────────── */
    const modal = document.getElementById('agent-modal');
    const addBtn = document.getElementById('agent-add-btn');
    const closeBtn = document.getElementById('agent-modal-close');
    const form = document.getElementById('agent-form');
    const platformInput = document.getElementById('agent-platform');
    const nameInput = document.getElementById('agent-name');
    const tokenInput = document.getElementById('agent-token');
    const hintEl = document.getElementById('agent-hint');

    function openModal() {
        form.reset();
        platformInput.value = 'telegram';
        document.querySelectorAll('.platform-btn').forEach(b => b.classList.toggle('active', b.dataset.platform === 'telegram'));
        hintEl.textContent = 'Токен бота от @BotFather в Telegram. После добавления нажмите «Подключить бота», чтобы активировать webhook.';
        modal.classList.add('open');
        setTimeout(() => nameInput.focus(), 100);
    }

    function closeModal() {
        modal.classList.remove('open');
    }

    if (addBtn) addBtn.addEventListener('click', openModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

    document.querySelectorAll('.platform-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const platform = btn.dataset.platform;
            platformInput.value = platform;
            document.querySelectorAll('.platform-btn').forEach(b => b.classList.toggle('active', b === btn));
            hintEl.textContent = platform === 'telegram'
                ? 'Токен бота от @BotFather в Telegram. После добавления нажмите «Подключить бота».'
                : 'WhatsApp-интеграция скоро. Сейчас поддержан только Telegram.';
        });
    });

    if (form) form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = nameInput.value.trim();
        const token = tokenInput.value.trim();
        if (!name || !token) return;

        const { error } = await supabaseClient.from(AGENTS_TABLE).insert({
            name: name,
            platform: platformInput.value,
            token: token,
            status: 'active'
        });

        if (error) {
            alert('Ошибка добавления: ' + error.message);
            return;
        }
        closeModal();
        loadAgents();
    });

    /* ─── Init ────────────────────────────────────────────────── */
    loadProjects();
});
