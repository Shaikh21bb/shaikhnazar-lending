document.addEventListener('DOMContentLoaded', () => {
    window.__scope = { isManager: false, chatId: null, agentId: null, name: '' };
    window.__deny = false;

    window.__roleReady = (async () => {
        let user;
        try {
            const response = await fetch('/api/auth/session', { cache: 'no-store' });
            if (!response.ok) return;
            user = (await response.json()).user;
        } catch (e) { console.error('Session lookup error:', e.message); return; }
        const login = user?.login || '';

        // The signed server session, not localStorage, decides owner access.
        if (user?.role === 'owner') return;

        // Менеджер — по совпадению логина с именем менеджера
        try {
            const { data: managers } = await supabaseClient.from('managers').select('id,name,chat_id,agent_id');
            const m = (managers || []).find(x =>
                String(x.name || '').trim().toLowerCase() === String(login).trim().toLowerCase());
            if (m) {
                window.__scope = { isManager: true, chatId: m.chat_id, agentId: m.agent_id, name: m.name };
                applyManagerUi();
                return;
            }
        } catch (e) { console.error('Manager lookup error:', e.message); }

        // Аккаунт есть, но не привязан ни к админу, ни к менеджеру
        window.__deny = true;
        blockAccess();
    })();

    function applyManagerUi() {
        document.querySelectorAll('.nav-item[href="#analyzer"], .nav-item[href="#agents"], .nav-item[href="#stats"]')
            .forEach(el => el.style.display = 'none');
        const mgrSection = document.getElementById('managers-section');
        if (mgrSection) mgrSection.style.display = 'none';
        const chip = document.getElementById('user-email');
        if (chip && chip.textContent) chip.textContent += ' · менеджер';
        setTimeout(() => {
            const t = document.querySelector('.nav-item[href="#tasks"]');
            if (t) t.click();
        }, 300);
    }

    function blockAccess() {
        const main = document.querySelector('.app-content');
        document.querySelectorAll('.topbar-nav, .mobile-dock, .topbar-right').forEach(el => el.style.display = 'none');
        if (main) {
            main.innerHTML = `
                <div style="padding:2rem; text-align:center;">
                    <h2>Доступ ограничен</h2>
                    <p>Ваш аккаунт не привязан к менеджеру.<br>Обратитесь к администратору.</p>
                    <br>
                    <button class="island island-sm" onclick="localStorage.removeItem('auth_token');localStorage.removeItem('auth_email');location.href='login.html';">Выйти</button>
                </div>`;
        }
    }
});
