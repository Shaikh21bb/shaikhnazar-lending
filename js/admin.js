document.addEventListener('DOMContentLoaded', () => {
    const MASTER_PASS = 'admin123'; // Мастер-пароль для входа в панель
    const overlay = document.getElementById('master-overlay');
    const masterInput = document.getElementById('master-pass');
    const masterErr = document.getElementById('master-err');
    
    const createForm = document.getElementById('create-manager-form');
    const loginInput = document.getElementById('new-login');
    const passInput = document.getElementById('new-pass');
    const createBtn = document.getElementById('create-btn');
    
    const managerList = document.getElementById('manager-list');
    const totalCount = document.getElementById('total-count');

    // Проверка мастер-пароля
    masterInput.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') {
            if (masterInput.value === MASTER_PASS) {
                overlay.style.display = 'none';
                loadManagers();
            } else {
                masterErr.style.display = 'block';
                masterInput.value = '';
            }
        }
    });

    // Загрузка списка менеджеров из БД
    async function loadManagers() {
        managerList.innerHTML = '<div class="loading">Загрузка менеджеров...</div>';
        try {
            const { data, error } = await supabaseClient
                .from('managers_auth')
                .select('*')
                .order('created_at', { ascending: false });

            if (error) throw error;

            if (data.length === 0) {
                managerList.innerHTML = '<div class="loading">Менеджеров пока нет. Создайте первого выше.</div>';
                totalCount.textContent = '0 менеджеров';
                return;
            }

            totalCount.textContent = `${data.length} менеджер(ов)`;

            const { data: managers } = await supabaseClient.from('managers').select('name');
            const names = new Set((managers || []).map(m => String(m.name || '').trim().toLowerCase()));

            const roleBadge = (m) => {
                const login = String(m.login || '').trim().toLowerCase();
                if (login === 'admin') return '<span style="color:#7CFF9B; font-size:0.8rem;">полный доступ</span>';
                if (names.has(login)) return '<span style="color:#FFD66B; font-size:0.8rem;">привязан · только своё</span>';
                return '<span style="color:var(--danger-color); font-size:0.8rem;">нет привязки · вход ограничен</span>';
            };

            managerList.innerHTML = data.map(m => `
                <div class="manager-card" id="mgr-${m.id}">
                    <div class="manager-info">
                        <div class="manager-login">👤 ${m.login} &nbsp; ${roleBadge(m)}</div>
                        <div class="manager-pass">🔑 ${m.password}</div>
                    </div>
                    <button class="delete-btn" onclick="window.__deleteManager('${m.id}', '${m.login}')">Отозвать доступ</button>
                </div>
            `).join('');

        } catch (error) {
            console.error('Error loading managers:', error);
            managerList.innerHTML = `<div class="loading" style="color:var(--danger-color)">Ошибка: ${error.message}</div>`;
        }
    }

    // Создание нового менеджера
    createForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const login = loginInput.value.trim();
        const password = passInput.value.trim();

        if (!login || !password) return;

        createBtn.disabled = true;
        createBtn.textContent = 'Создание...';

        try {
            const { error } = await supabaseClient
                .from('managers_auth')
                .insert([{ login, password }]);

            if (error) throw error;

            loginInput.value = '';
            passInput.value = '';
            await loadManagers();
            
        } catch (error) {
            console.error('Error creating manager:', error);
            if (error.code === '23505') { // Unique violation
                alert('Менеджер с таким логином уже существует!');
            } else {
                alert('Ошибка создания: ' + error.message);
            }
        } finally {
            createBtn.disabled = false;
            createBtn.textContent = 'Создать';
        }
    });

    // Удаление менеджера
    window.__deleteManager = async (id, login) => {
        if (!confirm(`Вы уверены, что хотите отозвать доступ у "${login}"?`)) return;

        try {
            const { error } = await supabaseClient
                .from('managers_auth')
                .delete()
                .eq('id', id);

            if (error) throw error;
            await loadManagers();

        } catch (error) {
            console.error('Error deleting manager:', error);
            alert('Ошибка удаления: ' + error.message);
        }
    };
});
