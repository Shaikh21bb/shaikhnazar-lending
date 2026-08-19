document.addEventListener('DOMContentLoaded', () => {
    const SCRIPTS_TABLE = 'scripts';
    let resultScript = '';

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    function copyText(text, btn) {
        navigator.clipboard.writeText(text).then(() => {
            if (btn) {
                const orig = btn.textContent;
                btn.textContent = 'Скопировано! ✅';
                setTimeout(() => { btn.textContent = orig; }, 2000);
            }
        }).catch(() => alert('Не удалось скопировать.'));
    }

    /* ─── Library ────────────────────────────────────────────── */
    async function loadScripts() {
        const grid = document.getElementById('scripts-grid');
        if (!grid) return;
        const { data, error } = await supabaseClient.from(SCRIPTS_TABLE).select('*').order('created_at', { ascending: false });
        if (error) {
            grid.innerHTML = `<div class="agents-empty glass">Ошибка: ${escapeHtml(error.message)}<br>Выполните supabase-migration-4.sql в Supabase SQL Editor.</div>`;
            return;
        }
        if (!data || data.length === 0) {
            grid.innerHTML = '<div class="agents-empty glass">Скриптов пока нет. Нажмите «Создать скрипт» или кнопку «Скрипт» в карточке горячего лида.</div>';
            return;
        }
        grid.innerHTML = '';
        data.forEach(s => grid.appendChild(buildScriptCard(s)));
    }

    function buildScriptCard(s) {
        const card = document.createElement('div');
        card.className = 'script-card';
        card.innerHTML = `
            <div class="script-card-top">
                <div>
                    <div class="script-card-name">${escapeHtml(s.lead_name || 'Без имени')}</div>
                    ${s.lead_need ? `<div class="script-card-need">🎯 ${escapeHtml(s.lead_need)}</div>` : ''}
                </div>
                <div class="script-card-date">${escapeHtml(new Date(s.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }))}</div>
            </div>
            <pre class="script-text">${escapeHtml(s.script)}</pre>
            <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
                <button class="island island-sm js-script-copy">Копировать</button>
                <button class="island island-sm island-danger js-script-delete">Удалить</button>
            </div>
        `;
        card.querySelector('.js-script-copy').addEventListener('click', () => copyText(s.script, card.querySelector('.js-script-copy')));
        card.querySelector('.js-script-delete').addEventListener('click', async () => {
            if (!confirm('Удалить скрипт?')) return;
            await supabaseClient.from(SCRIPTS_TABLE).delete().eq('id', s.id);
            loadScripts();
        });
        return card;
    }

    /* ─── Modal ──────────────────────────────────────────────── */
    const scriptModal = document.getElementById('script-modal');
    const scriptForm = document.getElementById('script-form');
    const offerInput = document.getElementById('script-offer');
    const audienceInput = document.getElementById('script-audience');
    const contextInput = document.getElementById('script-context');
    const langInput = document.getElementById('script-lang');
    const resultEl = document.getElementById('script-result');
    const textEl = document.getElementById('script-text');
    const copyBtn = document.getElementById('script-copy');
    const saveBtn = document.getElementById('script-save');
    const closeBtn = document.getElementById('script-close');
    const generateBtn = document.getElementById('script-generate');
    const actionsEl = document.getElementById('script-actions');
    let scriptMeta = {};

    function openScriptModal() {
        resultScript = '';
        scriptMeta = {};
        scriptForm.reset();
        resultEl.style.display = 'none';
        actionsEl.style.display = 'flex';
        generateBtn.disabled = false;
        generateBtn.textContent = 'Сгенерировать';
        if (saveBtn) { saveBtn.textContent = 'Сохранить в библиотеку'; saveBtn.disabled = false; }
        const ctx = document.getElementById('ai-context');
        if (ctx && ctx.value) contextInput.value = ctx.value;
        scriptModal.classList.add('open');
        setTimeout(() => offerInput.focus(), 100);
    }

    window.__generateScript = openScriptModal;

    if (document.getElementById('script-add-btn')) {
        document.getElementById('script-add-btn').addEventListener('click', () => openScriptModal(null));
    }
    if (document.getElementById('script-modal-close')) {
        document.getElementById('script-modal-close').addEventListener('click', () => scriptModal.classList.remove('open'));
    }
    if (scriptModal) scriptModal.addEventListener('click', e => { if (e.target === scriptModal) scriptModal.classList.remove('open'); });
    if (closeBtn) closeBtn.addEventListener('click', () => scriptModal.classList.remove('open'));

    if (copyBtn) copyBtn.addEventListener('click', () => copyText(textEl.value || resultScript, copyBtn));

    if (saveBtn) saveBtn.addEventListener('click', async () => {
        const text = (textEl.value || '').trim();
        if (!text) { alert('Скрипт пуст — сначала сгенерируйте.'); return; }
        saveBtn.disabled = true;
        saveBtn.textContent = 'Сохраняю...';
        const { error } = await supabaseClient.from(SCRIPTS_TABLE).insert({
            lead_name: scriptMeta.offer || null,
            lead_need: scriptMeta.audience || null,
            script: text
        });
        if (error) {
            alert('Ошибка сохранения: ' + error.message);
            saveBtn.disabled = false;
            saveBtn.textContent = 'Сохранить в библиотеку';
            return;
        }
        saveBtn.textContent = 'Сохранено ✅';
        setTimeout(() => {
            scriptModal.classList.remove('open');
            saveBtn.textContent = 'Сохранить в библиотеку';
            saveBtn.disabled = false;
        }, 1200);
        loadScripts();
    });

    if (scriptForm) scriptForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const offer = offerInput.value.trim();
        if (!offer) return;

        generateBtn.disabled = true;
        generateBtn.textContent = 'Генерация...';
        resultEl.style.display = 'none';
        actionsEl.style.display = 'flex';

        try {
            const res = await fetch('/api/script', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    offer: offer,
                    audience: audienceInput.value.trim(),
                    context: contextInput.value.trim(),
                    language: langInput ? langInput.value : 'kk'
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка генерации');

            resultScript = data.script;
            scriptMeta = { offer: offer, audience: audienceInput.value.trim() };
            textEl.value = data.script;
            resultEl.style.display = 'block';
            actionsEl.style.display = 'none';
        } catch (err) {
            alert('Ошибка: ' + err.message);
        } finally {
            generateBtn.disabled = false;
            generateBtn.textContent = 'Сгенерировать';
        }
    });

    loadScripts();
});