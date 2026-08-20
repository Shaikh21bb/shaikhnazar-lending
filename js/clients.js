document.addEventListener('DOMContentLoaded', () => {
    const listEl = document.getElementById('clients-list');
    const refreshBtn = document.getElementById('clients-refresh');
    if (!listEl) return;

    function esc(str) {
        return String(str || '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    function timeAgo(iso) {
        if (!iso) return '';
        const diff = Date.now() - new Date(iso).getTime();
        const m = Math.floor(diff / 60000);
        if (m < 1) return 'только что';
        if (m < 60) return `${m} мин назад`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h} ч назад`;
        const d = Math.floor(h / 24);
        return `${d} дн назад`;
    }

    function switchTo(view) {
        const item = document.querySelector(`.nav-item[href="#${view}"]`);
        if (item) item.click();
    }

    async function load() {
        const [{ data: chats, error: cErr }, { data: agents, error: aErr }] = await Promise.all([
            supabaseClient.from('agent_chats')
                .select('agent_id,chat_id,text,role,created_at')
                .order('created_at', { ascending: false })
                .limit(600),
            supabaseClient.from('agents').select('id,name')
        ]);

        if (cErr || aErr) {
            listEl.innerHTML = `<div class="agents-empty">Ошибка загрузки: ${esc((cErr && cErr.message) || (aErr && aErr.message))}</div>`;
            return;
        }

        const agentName = {};
        (agents || []).forEach(a => agentName[a.id] = a.name);

        const byChat = {};
        (chats || []).forEach(m => {
            const key = m.chat_id;
            if (!byChat[key]) byChat[key] = { chatId: key, last: m, count: 0, agentId: m.agent_id };
            byChat[key].count++;
            byChat[key].last = m;
            byChat[key].agentId = m.agent_id;
        });

        const list = Object.values(byChat).sort((a, b) =>
            (a.last.created_at < b.last.created_at) ? 1 : -1);

        if (list.length === 0) {
            listEl.innerHTML = '<div class="agents-empty">Клиентов пока нет. Когда кто-то напишет вашему агенту в Telegram — он появится здесь.</div>';
            return;
        }

        listEl.innerHTML = `
            <div class="client-row client-row-head">
                <div>Клиент</div>
                <div style="text-align:right;">Действия</div>
            </div>
            ${list.map(c => `
                <div class="client-row">
                    <div class="client-info">
                        <div class="client-id">💬 ${esc(c.chatId)} <span class="client-agent">· ${esc(agentName[c.agentId] || 'Агент')}</span></div>
                        <div class="client-msg">${esc((c.last.text || '').slice(0, 120))}</div>
                        <div class="client-meta">${c.count} сообщений · ${timeAgo(c.last.created_at)}</div>
                    </div>
                    <div class="client-actions">
                        <button class="island island-sm js-client-reply" data-agent="${esc(c.agentId)}" data-chat="${esc(c.chatId)}">Ответить</button>
                        <button class="island island-sm js-client-task" data-chat="${esc(c.chatId)}">Задача</button>
                        <button class="island island-sm js-client-script" data-chat="${esc(c.chatId)}">Скрипт</button>
                    </div>
                </div>`).join('')}
        `;

        listEl.querySelectorAll('.js-client-reply').forEach(btn => {
            btn.addEventListener('click', () => {
                const agent = { id: btn.dataset.agent, name: agentName[btn.dataset.agent] || 'Агент' };
                switchTo('agents');
                window.__openAgentDialog(agent, btn.dataset.chat);
            });
        });

        listEl.querySelectorAll('.js-client-task').forEach(btn => {
            btn.addEventListener('click', () => {
                const chatId = btn.dataset.chat;
                window.__openLeadTask({ name: 'Клиент ' + chatId, contact: chatId });
            });
        });

        listEl.querySelectorAll('.js-client-script').forEach(btn => {
            btn.addEventListener('click', () => {
                window.__generateScript();
            });
        });
    }

    load();
    if (refreshBtn) refreshBtn.addEventListener('click', load);
});