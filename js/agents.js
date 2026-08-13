document.addEventListener('DOMContentLoaded', () => {
    const AGENTS_TABLE = 'agents';

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

    const TELEGRAM_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>';
    const WHATSAPP_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/></svg>';

    function platformLabel(p) {
        return p === 'telegram' ? 'Telegram' : 'WhatsApp';
    }

    async function loadAgents() {
        const grid = document.getElementById('agents-grid');
        if (!grid) return;
        const { data, error } = await supabaseClient.from(AGENTS_TABLE).select('*').order('created_at', { ascending: false });
        if (error) {
            grid.innerHTML = `<div class="agents-empty glass">Ошибка загрузки: ${escapeHtml(error.message)}</div>`;
            return;
        }
        if (!data || data.length === 0) {
            grid.innerHTML = `<div class="agents-empty glass">Агентов пока нет. Нажмите «Добавить агента», чтобы подключить первого бота для Telegram или WhatsApp.</div>`;
            return;
        }
        grid.innerHTML = '';
        data.forEach(agent => grid.appendChild(buildAgentCard(agent)));
    }

    function buildAgentCard(agent) {
        const isTelegram = agent.platform === 'telegram';
        const isActive = agent.status === 'active';

        const card = document.createElement('div');
        card.className = 'agent-card glass';
        card.innerHTML = `
            <div class="agent-card-top">
                <div class="agent-icon ${isTelegram ? 'agent-telegram' : 'agent-whatsapp'}">${isTelegram ? TELEGRAM_ICON : WHATSAPP_ICON}</div>
                <div>
                    <div class="agent-name">${escapeHtml(agent.name || 'Без имени')}</div>
                    <div class="agent-meta">${platformLabel(agent.platform)}</div>
                </div>
                <span class="agent-status ${isActive ? 'status-active' : 'status-paused'}">${isActive ? 'Активен' : 'Пауза'}</span>
            </div>
            <div class="agent-meta">${escapeHtml(agent.token || '')}</div>
            <div class="agent-card-actions">
                <button class="island island-sm js-agent-toggle">${isActive ? 'Поставить на паузу' : 'Запустить'}</button>
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

        return card;
    }

    /* ─── Add agent modal ─── */
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
        hintEl.textContent = 'Токен бота от @BotFather в Telegram';
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
                ? 'Токен бота от @BotFather в Telegram'
                : 'Номер WhatsApp в международном формате (например +77001112233)';
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

    loadAgents();
});
