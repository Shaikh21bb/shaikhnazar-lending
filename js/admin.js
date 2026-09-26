document.addEventListener('DOMContentLoaded', async () => {
    const overlay = document.getElementById('master-overlay');
    const createForm = document.getElementById('create-manager-form');
    const loginInput = document.getElementById('new-login');
    const passInput = document.getElementById('new-pass');
    const createBtn = document.getElementById('create-btn');
    const managerList = document.getElementById('manager-list');
    const totalCount = document.getElementById('total-count');

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[char]));
    }

    async function request(method, body) {
        const response = await fetch('/api/admin/accounts', {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
            cache: 'no-store'
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось выполнить действие');
        return data;
    }

    try {
        const response = await fetch('/api/auth/session', { cache: 'no-store' });
        if (!response.ok || (await response.json()).user?.role !== 'owner') {
            throw new Error('Войдите под аккаунтом владельца');
        }
        overlay.style.display = 'none';
    } catch (error) {
        overlay.querySelector('h2').textContent = error.message;
        return;
    }

    async function loadManagers() {
        managerList.innerHTML = '<div class="loading">Загрузка аккаунтов...</div>';
        try {
            const [{ accounts }, managersResult] = await Promise.all([
                request('GET'),
                supabaseClient.from('managers').select('name')
            ]);
            const names = new Set((managersResult.data || []).map(m => String(m.name || '').trim().toLowerCase()));
            totalCount.textContent = `${accounts.length} аккаунт(ов)`;
            if (!accounts.length) {
                managerList.innerHTML = '<div class="loading">Аккаунтов пока нет.</div>';
                return;
            }
            managerList.innerHTML = accounts.map(account => {
                const login = String(account.login || '');
                const owner = ['admin', 'shaikh'].includes(login.trim().toLowerCase());
                const linked = names.has(login.trim().toLowerCase());
                const status = owner ? '<span style="color:#7CFF9B">полный доступ владельца</span>'
                    : (linked ? '<span style="color:#FFD66B">привязан к менеджеру</span>'
                        : '<span style="color:var(--danger-color)">нет привязки · вход ограничен</span>');
                return `<div class="manager-card" data-id="${escapeHtml(account.id)}">
                    <div class="manager-info">
                        <div class="manager-login">👤 ${escapeHtml(login)} &nbsp; ${status}</div>
                        <div class="manager-pass">Пароль скрыт. Если он был показан раньше, смените его.</div>
                        <div class="password-reset">
                            <input class="new-account-password" type="password" minlength="12" maxlength="128" autocomplete="new-password" placeholder="Новый пароль — от 12 символов" aria-label="Новый пароль для ${escapeHtml(login)}">
                            <button type="button" class="reset-btn">Сменить пароль</button>
                        </div>
                    </div>
                    ${owner ? '' : '<button type="button" class="delete-btn">Отозвать доступ</button>'}
                </div>`;
            }).join('');

            managerList.querySelectorAll('.manager-card').forEach(card => {
                const id = card.dataset.id;
                const passwordInput = card.querySelector('.new-account-password');
                card.querySelector('.reset-btn').addEventListener('click', async () => {
                    if (passwordInput.value.length < 12) {
                        alert('Новый пароль должен содержать не менее 12 символов.');
                        return;
                    }
                    try {
                        await request('PATCH', { id, password: passwordInput.value });
                        passwordInput.value = '';
                        alert('Пароль изменён. Ранее открытые сеансы могут оставаться активными до выхода или истечения срока.');
                    } catch (error) { alert('Ошибка смены пароля: ' + error.message); }
                });
                card.querySelector('.delete-btn')?.addEventListener('click', async () => {
                    if (!confirm('Отозвать доступ этого аккаунта?')) return;
                    try {
                        await request('DELETE', { id });
                        await loadManagers();
                    } catch (error) { alert('Ошибка удаления: ' + error.message); }
                });
            });
        } catch (error) {
            console.error('Account list error:', error);
            managerList.innerHTML = `<div class="loading" style="color:var(--danger-color)">Ошибка: ${escapeHtml(error.message)}</div>`;
        }
    }

    createForm.addEventListener('submit', async event => {
        event.preventDefault();
        const login = loginInput.value.trim();
        const password = passInput.value;
        createBtn.disabled = true;
        createBtn.textContent = 'Создание...';
        try {
            await request('POST', { login, password });
            loginInput.value = '';
            passInput.value = '';
            await loadManagers();
        } catch (error) {
            alert('Ошибка создания: ' + error.message);
        } finally {
            createBtn.disabled = false;
            createBtn.textContent = 'Создать';
        }
    });

    await loadManagers();
});
