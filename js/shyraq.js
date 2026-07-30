document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const resultsSection = document.getElementById('results-section');
    const resultsGrid = document.getElementById('results-grid');
    const managerTabsEl = document.getElementById('manager-tabs');
    const managersCountInput = document.getElementById('managers-count');
    const strictnessInput = document.getElementById('ai-strictness');
    const contextInput = document.getElementById('ai-context');
    const historyList = document.getElementById('history-list');
    const historySection = document.getElementById('history-section');
    const dashboardSection = document.getElementById('dashboard-section');

    const STORAGE_KEY = 'shyraq_sessions';
    let allLeads = [];
    let currentFileName = '';

    // ─── Supabase DB helpers ──────────────────────────────────────
    let dbSessionsCache = [];

    async function getSessions() {
        try {
            const { data, error } = await supabaseClient
                .from('sessions')
                .select('*')
                .order('created_at', { ascending: false });
            
            if (error) throw error;
            dbSessionsCache = data || [];
            return dbSessionsCache;
        } catch (e) {
            console.error("Error fetching sessions:", e);
            if (e.message) alert("Ошибка загрузки истории: " + e.message);
            return [];
        }
    }

    async function saveSession(leads, fileName, managersCount, dashData) {
        try {
            const { error } = await supabaseClient
                .from('sessions')
                .insert([{
                    id: Date.now(), // simple bigint ID
                    user_id: window.currentUserId, // Привязываем к текущему юзеру
                    file_name: fileName,
                    managers_count: managersCount,
                    leads_count: leads.length,
                    dash_data: dashData,
                    leads: leads
                }]);
            
            if (error) throw error;
            await renderHistory();
        } catch (e) {
            console.error("Error saving session:", e);
            alert("Ошибка сохранения в базу: " + (e.message || JSON.stringify(e)));
        }
    }

    async function deleteSession(id) {
        try {
            const { error } = await supabaseClient
                .from('sessions')
                .delete()
                .eq('id', id);
            
            if (error) throw error;
            await renderHistory();
        } catch (e) {
            console.error("Error deleting session:", e);
            alert("Ошибка удаления сессии: " + (e.message || ""));
        }
    }

    async function clearAllSessions() {
        if (confirm('Вы уверены, что хотите удалить всю историю из базы данных?')) {
            try {
                // To delete all rows safely, we delete rows where id > 0
                const { error } = await supabaseClient
                    .from('sessions')
                    .delete()
                    .gt('id', 0);
                if (error) throw error;
                await renderHistory();
            } catch (e) {
                console.error("Error clearing sessions:", e);
                alert("Ошибка очистки сессий: " + (e.message || ""));
            }
        }
    }

    // ─── Render history list ───────────────────────────────────────
    async function renderHistory() {
        if (!historyList || !historySection) return;
        historyList.innerHTML = '<p style="text-align:center;color:var(--text-secondary);">Загрузка истории...</p>';
        historySection.style.display = 'block';

        const sessions = await getSessions();

        if (sessions.length === 0) {
            historySection.style.display = 'none';
            return;
        }

        historyList.innerHTML = sessions.map(s => {
            const dateStr = new Date(s.created_at).toLocaleString('ru-RU');
            return `
            <div class="history-card" id="hist-${s.id}">
                <div class="history-card-info">
                    <div class="history-card-title">📄 ${s.file_name}</div>
                    <div class="history-card-meta">
                        🗓 ${dateStr} &nbsp;·&nbsp; 🔥 ${s.leads_count} лидов &nbsp;·&nbsp; 👥 ${s.managers_count} менеджер(ов)
                    </div>
                </div>
                <div class="history-card-actions">
                    <button class="hist-open-btn" onclick="window.__openSession(${s.id})">Открыть</button>
                    <button class="hist-delete-btn" onclick="window.__deleteSession(${s.id})">✕</button>
                </div>
            </div>
            `;
        }).join('');
    }

    window.__openSession = (id) => {
        const session = dbSessionsCache.find(s => s.id === id);
        if (!session) return;
        allLeads = session.leads;
        
        // Render dashboard if data exists
        if (session.dash_data) {
            renderDashboard(session.dash_data);
        } else {
            dashboardSection.style.display = 'none';
        }
        
        renderResults(session.leads, session.file_name);
    };
    window.__deleteSession = (id) => {
        deleteSession(id);
    };
    window.__clearAllSessions = clearAllSessions;

    // ─── File handling ─────────────────────────────────────────────
    dropZone.addEventListener('click', () => {
        if (!dropZone.classList.contains('is-loading')) fileInput.click();
    });
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) handleFile(e.target.files[0]);
    });

    function handleFile(file) {
        if (!file.name.endsWith('.csv') && !file.name.endsWith('.pdf')) {
            alert('Пожалуйста, загрузите файл в формате CSV или PDF.');
            return;
        }
        currentFileName = file.name;
        dropZone.classList.add('is-loading');

        if (file.name.endsWith('.csv')) {
            Papa.parse(file, {
                header: true,
                skipEmptyLines: true,
                complete: (results) => analyzeData({ leads: results.data, totalCount: results.data.length }),
                error: (err) => {
                    console.error(err);
                    alert("Ошибка при чтении CSV файла.");
                    dropZone.classList.remove('is-loading');
                }
            });
        } else {
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
                    const pdf = await pdfjsLib.getDocument(new Uint8Array(e.target.result)).promise;
                    let fullText = '';
                    for (let i = 1; i <= pdf.numPages; i++) {
                        const page = await pdf.getPage(i);
                        const content = await page.getTextContent();
                        fullText += content.items.map(item => item.str).join(' ') + '\n';
                    }
                    analyzeData({ pdfText: fullText, totalCount: 'Из PDF' });
                } catch (err) {
                    console.error(err);
                    alert("Ошибка при разборе PDF файла.");
                    dropZone.classList.remove('is-loading');
                }
            };
            reader.onerror = () => { alert("Ошибка при чтении файла."); dropZone.classList.remove('is-loading'); };
            reader.readAsArrayBuffer(file);
        }
    }

    // ─── Dashboard rendering ───────────────────────────────────────
    function renderDashboard(dashData) {
        document.getElementById('dash-total').textContent = dashData.total;
        document.getElementById('dash-hot').textContent = dashData.hot;
        document.getElementById('dash-conv').textContent = dashData.conv;
        
        const tempEl = document.getElementById('dash-temp');
        tempEl.textContent = dashData.temp || '—';
        if (dashData.temp === 'Горячая') tempEl.style.color = '#4CAF50';
        else if (dashData.temp === 'Теплая') tempEl.style.color = '#FFC107';
        else if (dashData.temp === 'Холодная') tempEl.style.color = '#F44336';
        else tempEl.style.color = 'var(--text-primary)';

        document.getElementById('dash-insight').textContent = dashData.insight || 'Инсайт недоступен.';
        dashboardSection.style.display = 'block';
    }

    // ─── API call ──────────────────────────────────────────────────
    async function analyzeData(payload) {
        try {
            payload.managersCount = parseInt(managersCountInput.value) || 1;
            payload.strictness = strictnessInput ? strictnessInput.value : 'medium';
            payload.productContext = contextInput ? contextInput.value : '';

            const response = await fetch('/api/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                let errDetails = response.statusText;
                try { const d = await response.json(); if (d.details) errDetails = d.details; } catch (e) {}
                throw new Error('API Error: ' + errDetails);
            }

            const result = await response.json();
            
            // New format checking
            let warmLeadsArray = [];
            let temperature = "—";
            let insight = "Нет данных.";
            
            if (result.warmLeads && Array.isArray(result.warmLeads)) {
                warmLeadsArray = result.warmLeads;
                temperature = result.temperature || "—";
                insight = result.insights || "ИИ не смог сформировать инсайт.";
            } else if (Array.isArray(result)) {
                // Fallback for old format
                warmLeadsArray = result;
            }

            if (warmLeadsArray.length >= 0) {
                allLeads = warmLeadsArray;
                
                // Calculate metrics
                let total = payload.totalCount;
                let conv = "—";
                if (typeof total === 'number' && total > 0) {
                    conv = ((allLeads.length / total) * 100).toFixed(1) + '%';
                }

                const dashData = {
                    total: total,
                    hot: allLeads.length,
                    conv: conv,
                    temp: temperature,
                    insight: insight
                };

                renderDashboard(dashData);
                saveSession(allLeads, currentFileName, payload.managersCount, dashData);
                renderResults(allLeads, currentFileName);
            } else {
                alert("Не удалось распознать ответ ИИ.");
            }
        } catch (error) {
            console.error("Analysis Error:", error);
            alert("Ошибка ИИ: " + error.message);
        } finally {
            dropZone.classList.remove('is-loading');
        }
    }

    // ─── Probability badge colour ──────────────────────────────────
    function probColor(prob) {
        if (!prob) return 'rgba(255,255,255,0.1)';
        if (prob === 'Высокая') return 'rgba(76, 175, 80, 0.25)';
        if (prob === 'Средняя') return 'rgba(255, 193, 7, 0.25)';
        return 'rgba(244, 67, 54, 0.2)';
    }
    function probIcon(prob) {
        if (prob === 'Высокая') return '🟢';
        if (prob === 'Средняя') return '🟡';
        return '🔴';
    }

    // ─── Manager tabs ──────────────────────────────────────────────
    function buildManagerTabs(leads) {
        managerTabsEl.innerHTML = '';
        const managers = [...new Set(leads.map(l => l.manager).filter(Boolean))].sort();
        if (managers.length <= 1) {
            appendCopyAllBtn(managerTabsEl, 'Все лиды', leads);
            return;
        }

        const allTab = document.createElement('button');
        allTab.className = 'manager-tab active';
        allTab.textContent = `Все (${leads.length})`;
        allTab.addEventListener('click', () => {
            document.querySelectorAll('.manager-tab').forEach(t => t.classList.remove('active'));
            allTab.classList.add('active');
            renderCards(leads);
            updateCopyAllBtn(leads, 'Все лиды');
        });
        managerTabsEl.appendChild(allTab);

        managers.forEach(manager => {
            const ml = leads.filter(l => l.manager === manager);
            const tab = document.createElement('button');
            tab.className = 'manager-tab';
            tab.textContent = `${manager} (${ml.length})`;
            tab.addEventListener('click', () => {
                document.querySelectorAll('.manager-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                renderCards(ml);
                updateCopyAllBtn(ml, manager);
            });
            managerTabsEl.appendChild(tab);
        });

        const copyAllWrapper = document.createElement('div');
        copyAllWrapper.id = 'copy-all-wrapper';
        copyAllWrapper.style.cssText = 'width:100%; display:flex; justify-content:center; margin-top:1rem;';
        managerTabsEl.after(copyAllWrapper);
        appendCopyAllBtn(copyAllWrapper, 'Все лиды', leads);
    }

    function appendCopyAllBtn(container, label, leads) {
        container.innerHTML = '';
        const btn = document.createElement('button');
        btn.id = 'copy-all-btn';
        btn.className = 'primary-btn';
        btn.style.cssText = 'padding: 10px 24px; font-size: 14px; display:inline-flex; align-items:center; gap:8px;';
        btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> 📋 Скопировать всех для ${label}`;
        btn.addEventListener('click', () => copyAllLeads(leads, label));
        container.appendChild(btn);
    }

    function updateCopyAllBtn(leads, label) {
        const wrapper = document.getElementById('copy-all-wrapper');
        if (wrapper) appendCopyAllBtn(wrapper, label, leads);
    }

    // ─── Copy all leads for manager ────────────────────────────────
    function copyAllLeads(leads, label) {
        const now = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
        let text = `=== ${label.toUpperCase()} | ${leads.length} лидов | ${now} ===\n\n`;
        leads.forEach((lead, i) => {
            const name = lead.name || 'Неизвестный клиент';
            const contact = lead.contact || 'Нет контакта';
            const watchTime = lead.watchTime || 'Неизвестно';
            const verdict = lead.verdict || '';
            const need = lead.need || '';
            const probability = lead.probability || '';
            const manager = lead.manager || '';

            text += `${i + 1}. Имя: ${name}\n`;
            text += `   Контакт: ${contact}\n`;
            text += `   Время просмотра: ${watchTime}\n`;
            if (need) text += `   Потребность: ${need}\n`;
            if (probability) text += `   Вероятность продажи: ${probability}\n`;
            if (verdict) text += `   Вердикт: ${verdict}\n`;
            if (manager) text += `   Менеджер: ${manager}\n`;
            text += '\n';
        });
        text += '--- Сгенерировано AI SHAIKH Industries ---';

        const btn = document.getElementById('copy-all-btn');
        navigator.clipboard.writeText(text).then(() => {
            if (btn) {
                const orig = btn.innerHTML;
                btn.innerHTML = '✅ Скопировано!';
                btn.style.background = '#4CAF50';
                setTimeout(() => { btn.innerHTML = orig; btn.style.background = ''; }, 2500);
            }
        }).catch(() => alert('Не удалось скопировать.'));
    }

    // ─── Render results ────────────────────────────────────────────
    function renderResults(leads, fileName) {
        const subtitle = document.getElementById('results-subtitle');
        if (subtitle) subtitle.textContent = `Файл: ${fileName || ''}`;

        const old = document.getElementById('copy-all-wrapper');
        if (old) old.remove();

        buildManagerTabs(leads);
        renderCards(leads);

        resultsSection.style.display = 'block';
        setTimeout(() => {
            resultsSection.classList.add('is-visible');
            window.dispatchEvent(new Event('resize'));
            window.scrollTo({ top: resultsSection.getBoundingClientRect().top + window.scrollY - 100, behavior: 'smooth' });
        }, 100);
    }

    // ─── Render lead cards ─────────────────────────────────────────
    function renderCards(leads) {
        resultsGrid.innerHTML = '';
        if (leads.length === 0) {
            resultsGrid.innerHTML = '<p style="text-align:center;color:var(--text-secondary);">Лидов по данному менеджеру нет.</p>';
            return;
        }

        leads.forEach(lead => {
            const name = lead.name || 'Неизвестный клиент';
            const contact = lead.contact || 'Нет контакта';
            const watchTime = lead.watchTime || 'Неизвестно';
            const verdict = lead.verdict || '';
            const need = lead.need || '';
            const probability = lead.probability || '';
            const manager = lead.manager || '';

            const card = document.createElement('div');
            card.className = 'lead-card fade-in is-visible';

            card.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:0.4rem;margin-bottom:0.75rem;">
                    <div class="lead-name">${name}</div>
                    ${manager ? `<span class="manager-badge">${manager}</span>` : ''}
                </div>
                <div class="lead-detail"><span>Контакт:</span><span class="lead-value">${contact}</span></div>
                <div class="lead-detail"><span>Время просмотра:</span><span class="lead-value">${watchTime}</span></div>
                ${need ? `<div class="lead-detail"><span>Потребность:</span><span class="lead-value" style="font-style:italic;">${need}</span></div>` : ''}
                ${probability ? `
                <div style="margin-top:0.6rem;">
                    <span class="probability-badge" style="background:${probColor(probability)}; border:1px solid ${probColor(probability).replace('0.25','0.5').replace('0.2','0.4')}; padding:0.25rem 0.75rem; border-radius:100px; font-size:0.78rem;">
                        ${probIcon(probability)} Вероятность продажи: <strong>${probability}</strong>
                    </span>
                </div>` : ''}
                ${verdict ? `<div class="lead-verdict">💬 ${verdict}</div>` : ''}
                <div class="badge" style="margin-top:1rem;">🔥 Горячий лид</div>
                
                <div style="display:flex; gap:0.5rem; margin-top:12px;">
                    <!-- Direct WhatsApp Button -->
                    <a href="#" class="wa-direct-btn" style="flex:1; padding:10px; font-size:14px; display:flex; justify-content:center; align-items:center; gap:8px; background-color:#25D366; color:white; border-radius:100px; text-decoration:none; font-weight:500; transition:opacity 0.2s;">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
                        Написать
                    </a>
                    
                    <!-- Copy Details Button -->
                    <button class="copy-btn primary-btn" style="flex:1; padding:10px; font-size:14px; display:flex; justify-content:center; align-items:center; gap:8px;">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        Скопировать
                    </button>
                </div>
            `;

            // Setup direct WhatsApp link
            const waBtn = card.querySelector('.wa-direct-btn');
            // Clean phone number (remove anything that is not a digit)
            const cleanPhone = contact.replace(/\D/g, '');
            if (cleanPhone.length >= 10) { // Valid enough phone length
                const greeting = encodeURIComponent(`Здравствуйте, ${name}! Вы были на нашем вебинаре...`);
                waBtn.href = `https://wa.me/${cleanPhone}?text=${greeting}`;
                waBtn.target = "_blank";
            } else {
                // If it's an email or invalid phone
                waBtn.style.opacity = "0.4";
                waBtn.style.cursor = "not-allowed";
                waBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    alert('Не удалось распознать корректный номер телефона.');
                });
            }

            const copyBtn = card.querySelector('.copy-btn');
            copyBtn.addEventListener('click', () => {
                const text = `Имя: ${name}\nКонтакт: ${contact}\nВремя просмотра: ${watchTime}${need ? '\nПотребность: ' + need : ''}${probability ? '\nВероятность продажи: ' + probability : ''}${verdict ? '\nВердикт: ' + verdict : ''}${manager ? '\nМенеджер: ' + manager : ''}`;
                navigator.clipboard.writeText(text).then(() => {
                    const orig = copyBtn.innerHTML;
                    copyBtn.innerHTML = 'Скопировано! ✅';
                    copyBtn.style.background = '#4CAF50';
                    copyBtn.style.color = '#fff';
                    setTimeout(() => { copyBtn.innerHTML = orig; copyBtn.style.background = ''; copyBtn.style.color = ''; }, 2000);
                }).catch(() => alert('Не удалось скопировать текст.'));
            });

            resultsGrid.appendChild(card);
        });
    }

    // ─── Init ──────────────────────────────────────────────────────
    renderHistory();
});
