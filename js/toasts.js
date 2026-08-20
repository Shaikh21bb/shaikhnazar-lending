document.addEventListener('DOMContentLoaded', () => {
    const KEY = 'shaikh_last_seen_chat_at';
    const TASK_KEY = 'shaikh_known_tasks';
    const SEEDED_KEY = 'shaikh_tasks_seeded';
    let lastSeen = localStorage.getItem(KEY) || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let knownTasks = {};
    let seeded = localStorage.getItem(SEEDED_KEY) === '1';
    try { knownTasks = JSON.parse(localStorage.getItem(TASK_KEY) || '{}'); } catch (e) { knownTasks = {}; }
    let agentNames = {};

    function esc(str) {
        return String(str || '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    function ensureRoot() {
        let root = document.getElementById('toast-root');
        if (!root) {
            root = document.createElement('div');
            root.id = 'toast-root';
            root.className = 'toast-root';
            document.body.appendChild(root);
        }
        return root;
    }

    function dismiss(toast) {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }

    function showToast(title, body) {
        const root = ensureRoot();
        while (root.children.length >= 4) root.removeChild(root.firstChild);
        const t = document.createElement('div');
        t.className = 'toast';
        t.innerHTML = `
            <button class="toast-close">✕</button>
            <div class="toast-title">${esc(title)}</div>
            <div class="toast-body">${esc(body)}</div>
        `;
        root.appendChild(t);
        requestAnimationFrame(() => t.classList.add('show'));
        t.querySelector('.toast-close').addEventListener('click', () => dismiss(t));
        setTimeout(() => dismiss(t), 8000);
    }

    async function loadAgents() {
        const { data, error } = await supabaseClient.from('agents').select('id,name');
        if (!error && data) {
            agentNames = {};
            data.forEach(a => agentNames[a.id] = a.name);
        }
    }

    async function poll() {
        if (document.hidden) return;
        if (window.__roleReady) await window.__roleReady;
        const scope = window.__scope || {};
        const isManager = !!scope.isManager;

        let taskQuery = supabaseClient.from('tasks')
            .select('id,title,status,created_at')
            .order('created_at', { ascending: false })
            .limit(8);
        if (isManager && scope.chatId) taskQuery = taskQuery.eq('chat_id', scope.chatId);

        try {
            const [chatReq, taskReq] = await Promise.all([
                isManager
                    ? Promise.resolve({ data: [], error: null })
                    : supabaseClient.from('agent_chats')
                        .select('agent_id,chat_id,text,created_at')
                        .eq('role', 'user')
                        .order('created_at', { ascending: false })
                        .limit(10),
                taskQuery
            ]);

            const msgs = chatReq.data, mErr = chatReq.error, tasks = taskReq.data, tErr = taskReq.error;

            if (!mErr && msgs && msgs.length) {
                const fresh = msgs.filter(m => m.created_at && m.created_at > lastSeen);
                if (fresh.length) {
                    fresh.slice(0, 3).reverse().forEach(m => {
                        showToast(
                            `💬 ${agentNames[m.agent_id] || 'Агент'} — клиент ${m.chat_id}`,
                            (m.text || '').slice(0, 90) || 'Новое сообщение'
                        );
                    });
                    const newest = msgs[0].created_at;
                    if (newest && newest > lastSeen) {
                        lastSeen = newest;
                        localStorage.setItem(KEY, newest);
                    }
                }
            }

            if (!tErr && tasks && tasks.length) {
                tasks.forEach(t => {
                    const prev = knownTasks[t.id];
                    knownTasks[t.id] = t.status;
                    if (!seeded) return;
                    if (!prev && t.status !== 'done') {
                        showToast('📌 Новая задача', t.title || 'Задача');
                    } else if (prev && prev !== 'done' && t.status === 'done') {
                        showToast('🎉 Задача выполнена', t.title || 'Задача');
                    }
                });
                localStorage.setItem(TASK_KEY, JSON.stringify(knownTasks));
                if (!seeded) {
                    seeded = true;
                    localStorage.setItem(SEEDED_KEY, '1');
                }
            }
        } catch (e) {
            console.error('Toast poll error:', e.message);
        }
    }

    loadAgents();
    setTimeout(poll, 6000);
    setInterval(poll, 20000);

    window.addEventListener('online', () => showToast(
        __t('Соединение восстановлено', 'Байланыс қалпына келді'),
        __t('Данные снова обновляются.', 'Деректер қайта жаңартылады.')
    ));
    window.addEventListener('offline', () => showToast(
        __t('Офлайн', 'Офлайн'),
        __t('Нет соединения. Данные временно не обновляются.', 'Байланыс жоқ. Деректер уақытша жаңартылмайды.')
    ));
});