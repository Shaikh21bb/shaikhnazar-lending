/* Local Sales Agent controls. All commands use the signed owner session. */
window.SalesStudio = (() => {
    const models = [
        ['qwen3.5:9b-mlx', 'Qwen 3.5 · 9B', 'Тяжёлая модель · около 9 ГБ'],
        ['qwen3:1.7b', 'Qwen 3 · 1.7B', 'Быстрее, но менее точна · около 1,4 ГБ'],
        ['llama3.1:8b', 'Llama 3.1 · 8B', 'Для диалогов · около 5 ГБ']
    ];
    const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function request(agentId, body, testId, models) {
        const url = `/api/whatsapp/bridge?agentId=${encodeURIComponent(agentId)}${testId ? `&testId=${encodeURIComponent(testId)}` : ''}${models ? '&models=openrouter' : ''}`;
        const response = await fetch(url, body ? {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId, ...body })
        } : { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error === 'Unauthorized' ? 'Войдите в аккаунт заново.' : (data.error || 'Не удалось выполнить действие.'));
        return data;
    }

    function createCard(agent, projects, actions) {
        const card = document.createElement('article');
        card.className = 'sales-studio';
        card.innerHTML = `
            <header class="sales-studio-header">
                <div class="sales-avatar" aria-hidden="true">S<span></span></div>
                <div class="sales-identity"><span class="sales-eyebrow">SALES AGENT / WHATSAPP</span><h3>${esc(agent.name || 'Sales Agent')}</h3></div>
                <span class="sales-live-badge" data-state="loading">Проверяем готовность</span>
            </header>
            <div class="sales-health" aria-label="Готовность агента">
                ${[['whatsapp', 'WhatsApp'], ['mac', 'Mac онлайн'], ['ollama', 'AI-модель'], ['training', 'Обучение']].map(([key, label]) => `<span data-check="${key}"><i></i>${label}</span>`).join('')}
            </div>
            <div class="sales-studio-body">
                <div class="sales-settings">
                    <div class="sales-section-label"><span>01</span> Настройте своего агента</div>
                    <label class="sales-field">Где работает AI
                        <select class="sales-provider" aria-label="Провайдер AI ${esc(agent.name)}"><option value="ollama">Ollama · на моём Mac · бесплатно</option><option value="openrouter">OpenRouter · облачные модели · свой API-ключ</option></select>
                    </label>
                    <label class="sales-field">AI-модель <span class="sales-local-chip">На вашем Mac</span>
                        <select class="sales-model" aria-label="AI-модель ${esc(agent.name)}">${models.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select>
                        <small class="sales-model-help">${models[0][2]} · без API-платежей</small>
                    </label>
                    <form class="sales-key-settings" hidden>
                        <label class="sales-field">Личный ключ OpenRouter
                            <input class="sales-key-input" type="password" aria-label="API-ключ OpenRouter ${esc(agent.name)}" placeholder="sk-or-v1-…" autocomplete="off" spellcheck="false" required>
                        </label>
                        <div class="sales-key-actions"><button type="submit" class="sales-secondary sales-key-save">Проверить и сохранить</button><button type="button" class="sales-key-remove" hidden>Удалить ключ</button></div>
                        <small class="sales-key-state" role="status">Ключ нужен только для облачных моделей.</small>
                        <small class="sales-key-note">Ключ хранится зашифрованным на сервере. Для ответа OpenRouter получает текст диалога и материалы обучения. Бесплатные модели могут иметь лимиты; платные расходуют ваш баланс.</small>
                    </form>
                    <div class="sales-field-row">
                        <label class="sales-field">База знаний
                            <select class="sales-project" aria-label="База знаний ${esc(agent.name)}"><option value="">Выберите материалы</option>${projects.map(project => `<option value="${esc(project.id)}" ${project.id === agent.project_id ? 'selected' : ''}>${esc(project.name)}</option>`).join('')}</select>
                        </label>
                        <label class="sales-field">Язык
                            <select class="sales-language" aria-label="Язык ${esc(agent.name)}"><option value="ru" ${agent.language !== 'kk' ? 'selected' : ''}>Русский</option><option value="kk" ${agent.language === 'kk' ? 'selected' : ''}>Қазақша</option></select>
                        </label>
                    </div>
                    <button type="button" class="sales-training-button"><span class="sales-book-icon">▤</span><span><strong>Обучить агента</strong><small>Продукт, цены, вопросы и сценарий продаж</small></span><span aria-hidden="true">↗</span></button>
                    <div class="sales-readiness" role="status">Проверяем локальный сервер…</div>
                    <div class="sales-controls"><button type="button" class="sales-primary sales-toggle" disabled>Проверяем…</button><button type="button" class="sales-secondary sales-connect">WhatsApp · QR</button></div>
                    <div class="sales-session-stats"><span><b class="sales-reply-count">—</b> ответов с запуска</span><span class="sales-last-reply">Ожидаем первое сообщение</span></div>
                    <p class="sales-operation-note">Агент отвечает, пока Mac включён и не спит. Пауза сохраняет подключение WhatsApp. Память клиента и новые переписки сохраняются на Mac после перезапуска.</p>
                    <button type="button" class="sales-delete">Удалить агента</button>
                </div>
                <div class="sales-playground">
                    <div class="sales-playground-header"><div><span class="sales-eyebrow">LIVE PREVIEW</span><h4>Попробуйте как клиент</h4></div><button type="button" class="sales-clear" aria-label="Очистить тестовый чат">↺</button></div>
                    <p class="sales-playground-hint">Ответит ваша модель с материалами компании. Сообщения останутся в тестовом чате.</p>
                    <div class="sales-messages" role="log" aria-label="Тестовый диалог" aria-live="polite"><div class="sales-chat-empty"><div class="sales-spark">✦</div><strong>Ваш следующий диалог начинается здесь</strong><span>Задайте вопрос о продукте и оцените ответ до запуска продаж.</span></div></div>
                    <div class="sales-prompts"><button type="button">Что умеет платформа?</button><button type="button">Сколько стоит?</button></div>
                    <form class="sales-chat-form"><input aria-label="Сообщение тестовому агенту" placeholder="Напишите как ваш клиент…" maxlength="4000" required autocomplete="off"><button type="submit" aria-label="Отправить тестовое сообщение">↑</button></form>
                    <div class="sales-test-status" role="status">Без отправки в WhatsApp</div>
                </div>
            </div>`;
        const q = selector => card.querySelector(selector);
        let status = null;
        let busy = false;
        let targetEnabled = null;
        let controlSentAt = 0;
        let history = [];
        let refreshing = false;
        let saving = false;
        let modelCatalog = [];
        let catalogLoading = null;

        async function loadCatalog() {
            if (catalogLoading) return catalogLoading;
            catalogLoading = request(agent.id, null, null, true).then(data => {
                modelCatalog = Array.isArray(data.models) ? data.models : [];
                if (status?.provider === 'openrouter') renderModels(status);
            }).catch(() => { modelCatalog = []; });
            return catalogLoading;
        }

        function renderModels(data) {
            const provider = data.provider || 'ollama';
            const list = provider === 'openrouter'
                ? [{ id: 'openrouter/free', name: 'Бесплатная модель · авто', free: true }, ...modelCatalog.filter(item => item.id !== 'openrouter/free')]
                : models.map(([id, name]) => ({ id, name }));
            if (!list.some(item => item.id === data.model)) list.unshift({ id: data.model, name: data.model });
            const picker = q('.sales-model');
            if (document.activeElement !== picker) {
                picker.innerHTML = list.map(item => `<option value="${esc(item.id)}">${esc(item.name)}${provider === 'openrouter' ? (item.free ? ' · бесплатно' : ' · платно') : ''}</option>`).join('');
                picker.value = data.model;
            }
            const selected = list.find(item => item.id === data.model);
            q('.sales-local-chip').textContent = provider === 'openrouter' ? 'В облаке' : 'На вашем Mac';
            q('.sales-model-help').textContent = provider === 'openrouter'
                ? (selected?.free ? 'Бесплатно в пределах лимитов OpenRouter; скорость зависит от доступной модели.'
                    : `Платно: ~$${Number(selected?.inputPerMillion || 0).toFixed(2)} за 1 млн входных и ~$${Number(selected?.outputPerMillion || 0).toFixed(2)} за 1 млн выходных токенов. Оплачивается вашим ключом.`)
                : `${models.find(model => model[0] === data.model)?.[2] || ''} · без API-платежей`;
            q('.sales-key-settings').hidden = provider !== 'openrouter';
            q('.sales-key-state').textContent = data.keyConfigured ? 'Ключ проверен и сохранён. Его значение здесь не показывается.' : 'Добавьте свой ключ OpenRouter для ответов в облаке.';
            q('.sales-key-remove').hidden = !data.keyConfigured;
            if (document.activeElement !== q('.sales-provider')) q('.sales-provider').value = provider;
            if (provider === 'openrouter' && !modelCatalog.length) void loadCatalog();
        }

        function displayStatus(data) {
            status = data;
            agent.ai_enabled = data.aiEnabled;
            agent.status = data.aiEnabled ? 'active' : 'paused';
            const checks = data.checks || {};
            card.querySelectorAll('[data-check]').forEach(item => item.dataset.good = String(Boolean(checks[item.dataset.check])));
            card.querySelector('[data-check="ollama"]').lastChild.textContent = data.provider === 'openrouter' ? 'API-ключ' : 'AI-модель';
            const enabled = data.aiEnabled && data.runtime.enabled;
            const badge = q('.sales-live-badge');
            const failed = data.runtime.lastResult === 'error';
            badge.dataset.state = failed ? 'error' : (data.ready ? 'ready' : 'paused');
            badge.textContent = !checks.mac ? 'Mac не на связи' : (failed ? 'Ошибка ответа' : (data.ready ? 'Готов к продажам' : (!checks.replies ? 'Ответы на паузе' : 'Нужна настройка')));
            if (targetEnabled !== null && (data.runtime.enabled === targetEnabled || Date.now() - controlSentAt > 30000)) targetEnabled = null;
            const toggle = q('.sales-toggle');
            toggle.disabled = saving || targetEnabled !== null;
            toggle.textContent = targetEnabled !== null ? 'Применяем на Mac…' : (enabled ? 'Приостановить ответы' : 'Включить ответы');
            toggle.classList.toggle('is-running', enabled);
            renderModels(data);
            let reason = 'Всё готово. Новые сообщения в WhatsApp обрабатываются автоматически.';
            if (!checks.mac) reason = 'Локальный сервер не на связи. Запустите start-whatsapp.command на Mac.';
            else if (!checks.whatsapp) reason = 'Подключите номер через WhatsApp · QR.';
            else if (!checks.ollama) reason = data.provider === 'openrouter' ? 'Добавьте действительный API-ключ OpenRouter.' : 'Ollama недоступна или выбранная модель не установлена на Mac.';
            else if (!checks.training) reason = 'Добавьте информацию о продукте через «Обучить агента».';
            else if (!checks.replies) reason = 'Ответы выключены. Нажмите «Включить ответы», чтобы агент начал общаться с клиентами.';
            else if (data.runtime.lastResult === 'error') reason = `Последний ответ не отправлен: ${data.runtime.lastError || 'проверьте локальный сервер'}`;
            else if (data.runtime.lastResult === 'generating') reason = 'Агент готовит ответ клиенту…';
            else if (data.runtime.lastResult === 'decrypt_pending') reason = 'WhatsApp повторно запрашивает зашифрованное сообщение. Попробуйте отправить новое.';
            q('.sales-readiness').textContent = reason;
            q('.sales-readiness').dataset.ready = String(data.ready && data.runtime.lastResult !== 'error');
            q('.sales-reply-count').textContent = data.runtime.replies;
            q('.sales-last-reply').textContent = data.runtime.lastReplyAt ? `Последний ответ: ${new Date(data.runtime.lastReplyAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}${data.runtime.lastLatencyMs ? ` · ${(data.runtime.lastLatencyMs / 1000).toFixed(1)} с` : ''}` : 'Ожидаем первое сообщение';
        }

        async function refresh() {
            if (refreshing) return;
            refreshing = true;
            try { displayStatus(await request(agent.id)); }
            catch (error) {
                q('.sales-readiness').textContent = error.message;
                q('.sales-live-badge').textContent = 'Статус недоступен';
                q('.sales-live-badge').dataset.state = 'error';
                q('.sales-toggle').disabled = true;
            }
            finally { refreshing = false; }
        }
        async function configure(body) {
            if (saving) return;
            saving = true;
            card.querySelectorAll('select, .sales-toggle').forEach(control => { control.disabled = true; });
            q('.sales-chat-form button').disabled = true;
            q('.sales-readiness').textContent = 'Сохраняем настройки…';
            try {
                await request(agent.id, { action: 'configure', ...body });
                await refresh();
            } finally {
                saving = false;
                card.querySelectorAll('select').forEach(control => { control.disabled = false; });
                q('.sales-toggle').disabled = targetEnabled !== null;
                q('.sales-chat-form button').disabled = busy;
            }
        }
        q('.sales-model').addEventListener('change', async event => {
            const model = event.target.value;
            try { await configure({ model }); }
            catch (error) { q('.sales-readiness').textContent = error.message; if (status) event.target.value = status.model; }
        });
        q('.sales-provider').addEventListener('change', async event => {
            try { await configure({ provider: event.target.value }); }
            catch (error) { q('.sales-readiness').textContent = error.message; if (status) event.target.value = status.provider; }
        });
        q('.sales-key-settings').addEventListener('submit', async event => {
            event.preventDefault();
            const input = q('.sales-key-input');
            const key = input.value.trim();
            input.value = '';
            if (!key || saving) return;
            saving = true;
            q('.sales-key-save').disabled = true;
            q('.sales-key-state').textContent = 'Проверяем ключ в OpenRouter…';
            try { await request(agent.id, { action: 'provider_key_set', key }); await refresh(); }
            catch (error) { q('.sales-key-state').textContent = error.message; }
            finally { saving = false; q('.sales-key-save').disabled = false; }
        });
        q('.sales-key-remove').addEventListener('click', async () => {
            if (saving) return;
            saving = true;
            try { await request(agent.id, { action: 'provider_key_delete' }); await refresh(); }
            catch (error) { q('.sales-key-state').textContent = error.message; }
            finally { saving = false; }
        });
        q('.sales-project').addEventListener('change', async event => {
            try { await configure({ projectId: event.target.value || null }); agent.project_id = event.target.value || null; }
            catch (error) { q('.sales-readiness').textContent = error.message; event.target.value = agent.project_id || ''; }
        });
        q('.sales-language').addEventListener('change', async event => {
            try { await configure({ language: event.target.value }); agent.language = event.target.value; }
            catch (error) { q('.sales-readiness').textContent = error.message; event.target.value = agent.language; }
        });
        q('.sales-toggle').addEventListener('click', async () => {
            if (!status) return;
            targetEnabled = !(status.aiEnabled && status.runtime.enabled);
            controlSentAt = Date.now();
            q('.sales-toggle').disabled = true;
            try { await configure({ enabled: targetEnabled }); }
            catch (error) { targetEnabled = null; q('.sales-toggle').disabled = false; q('.sales-readiness').textContent = error.message; }
        });
        q('.sales-training-button').addEventListener('click', () => actions.train(agent));
        q('.sales-connect').addEventListener('click', () => actions.connect(agent));
        q('.sales-delete').addEventListener('click', () => actions.remove(agent));

        function addMessage(role, text) {
            q('.sales-chat-empty')?.remove();
            const bubble = document.createElement('div');
            bubble.className = `sales-message ${role}`;
            bubble.textContent = text;
            q('.sales-messages').appendChild(bubble);
            q('.sales-messages').scrollTop = q('.sales-messages').scrollHeight;
            return bubble;
        }
        q('.sales-clear').addEventListener('click', () => {
            if (busy || saving) return;
            history = [];
            q('.sales-messages').replaceChildren();
            q('.sales-test-status').textContent = 'Новый тестовый диалог';
        });
        card.querySelectorAll('.sales-prompts button').forEach(button => button.addEventListener('click', () => {
            q('.sales-chat-form input').value = button.textContent;
            q('.sales-chat-form input').focus();
        }));
        q('.sales-chat-form').addEventListener('submit', async event => {
            event.preventDefault();
            if (busy || saving) return;
            const input = q('.sales-chat-form input');
            const text = input.value.trim();
            if (!text) return;
            busy = true;
            q('.sales-chat-form button').disabled = true;
            addMessage('user', text);
            input.value = '';
            const thinking = addMessage('assistant thinking', status?.provider === 'openrouter' ? 'Готовлю ответ в облаке…' : 'Готовлю ответ на вашем Mac…');
            const started = Date.now();
            q('.sales-test-status').textContent = status?.provider === 'openrouter' ? 'Ожидаем ответ OpenRouter…' : 'Ожидаем локальную модель. Первый ответ может занять больше времени.';
            try {
                const job = await request(agent.id, { action: 'test_create', text, history });
                let result;
                while (Date.now() - started < 180000) {
                    await wait(1500);
                    if (!card.isConnected) return;
                    result = await request(agent.id, null, job.id);
                    if (['completed', 'failed', 'expired'].includes(result.state)) break;
                }
                if (result?.state !== 'completed') throw new Error(result?.error || 'Модель не успела ответить. Проверьте локальный сервер.');
                thinking.classList.remove('thinking');
                thinking.textContent = result.answer;
                history = [...history, { role: 'user', content: text }, { role: 'assistant', content: result.answer }].slice(-8);
                q('.sales-test-status').textContent = `${models.find(model => model[0] === result.model)?.[1] || modelCatalog.find(model => model.id === result.model)?.name || result.model} · ${Math.round((Date.now() - started) / 1000)} сек${status?.provider === 'ollama' ? ' · без API-платежей' : ''}`;
            } catch (error) {
                thinking.remove();
                q('.sales-test-status').textContent = error.message;
                input.value = text;
            } finally {
                busy = false;
                q('.sales-chat-form button').disabled = saving;
                q('.sales-messages').scrollTop = q('.sales-messages').scrollHeight;
            }
        });
        void refresh();
        const timer = setInterval(() => {
            if (!card.isConnected) return clearInterval(timer);
            if (!document.hidden && card.closest('.active-view')) void refresh();
        }, 8000);
        return card;
    }
    return { createCard };
})();
