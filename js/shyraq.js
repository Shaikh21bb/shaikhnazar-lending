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

    // ─── LocalStorage helpers ──────────────────────────────────────
    function getSessions() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
        catch (e) { return []; }
    }

    function saveSession(leads, fileName, managersCount, dashData) {
        const sessions = getSessions();
        const session = {
            id: Date.now(),
            date: new Date().toLocaleString('ru-RU'),
            fileName: fileName,
            managersCount: managersCount,
            leadsCount: leads.length,
            leads: leads,
            dashData: dashData // { total, hot, conv, temp, insight }
        };
        sessions.unshift(session);
        if (sessions.length > 20) sessions.pop();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
        renderHistory();
    }

    function deleteSession(id) {
        const sessions = getSessions().filter(s => s.id !== id);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
        renderHistory();
    }

    function clearAllSessions() {
        if (confirm('Вы уверены, что хотите удалить всю историю?')) {
            localStorage.removeItem(STORAGE_KEY);
            renderHistory();
        }
    }

    // ─── Render history list ───────────────────────────────────────
    function renderHistory() {
        if (!historyList || !historySection) return;
        
        const sessions = getSessions();

        if (sessions.length === 0) {
            historySection.style.display = 'none';
            return;
        }

        historySection.style.display = 'block';
        historyList.innerHTML = sessions.map(s => `
            <div class="history-card" id="hist-${s.id}">
                <div class="history-card-info">
                    <div class="history-card-title">${s.fileName}</div>
                    <div class="history-card-meta">
                        ${s.date} &nbsp;|&nbsp; Лидов: ${s.leadsCount} &nbsp;|&nbsp; Менеджеров: ${s.managersCount}
                    </div>
                </div>
                <div class="history-card-actions">
                    <button class="hist-open-btn" onclick="window.__openSession(${s.id})">Открыть</button>
                    <button class="hist-delete-btn" onclick="window.__deleteSession(${s.id})">X</button>
                </div>
            </div>
        `).join('');
    }

    window.__openSession = (id) => {
        const session = getSessions().find(s => s.id === id);
        if (!session) return;
        allLeads = session.leads;
        
        // Render dashboard if data exists
        if (session.dashData) {
            renderDashboard(session.dashData);
        } else {
            dashboardSection.style.display = 'none';
        }
        
        renderResults(session.leads, session.fileName);
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

    // ─── Copy Phone Numbers ────────────────────────────────────────
    window.__copyAllNumbers = () => {
        if (!allLeads || allLeads.length === 0) {
            alert('Сначала загрузите и проанализируйте данные.');
            return;
        }

        let numbers = [];
        allLeads.forEach(lead => {
            if (lead.contact) {
                let digits = lead.contact.replace(/\D/g, '');
                
                // Format for RU/KZ numbers
                if (digits.length === 11 && digits.startsWith('8')) {
                    digits = '7' + digits.substring(1);
                } else if (digits.length === 10) {
                    digits = '7' + digits;
                }
                
                if (digits.length >= 10) {
                     numbers.push('+' + digits);
                }
            }
        });

        if (numbers.length === 0) {
            alert('Не найдено ни одного номера телефона в результатах.');
            return;
        }

        numbers = [...new Set(numbers)];
        
        const textToCopy = numbers.join('\n');
        navigator.clipboard.writeText(textToCopy).then(() => {
            alert(`Успешно скопировано номеров: ${numbers.length}`);
        }).catch(err => {
            console.error('Copy failed', err);
            alert('Ошибка копирования. Скопируйте вручную.');
        });
    };

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
        const isDark = document.body.getAttribute('data-theme') === 'dark';
        if (!prob) return isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)';
        if (prob === 'Высокая') return isDark ? 'rgba(76, 175, 80, 0.25)' : '#DCFCE7';
        if (prob === 'Средняя') return isDark ? 'rgba(255, 193, 7, 0.25)' : '#FEF3C7';
        return isDark ? 'rgba(244, 67, 54, 0.2)' : '#FEE2E2';
    }
    function probText(prob) {
        const isDark = document.body.getAttribute('data-theme') === 'dark';
        if (!prob) return isDark ? 'rgba(255,255,255,0.6)' : '#6B7280';
        if (prob === 'Высокая') return isDark ? '#4CAF50' : '#16A34A';
        if (prob === 'Средняя') return isDark ? '#FFC107' : '#D97706';
        return isDark ? '#F44336' : '#DC2626';
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

        const exp = document.createElement('button');
        exp.className = 'primary-btn';
        exp.style.cssText = 'padding: 10px 24px; font-size: 14px; display:inline-flex; align-items:center; gap:8px; background:#2563eb;';
        exp.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> ⬇ Экспорт CSV`;
        exp.addEventListener('click', () => exportLeadsCsv(leads));
        container.appendChild(exp);

        if (container.id === 'copy-all-wrapper' || container.tagName === 'DIV') {
            container.style.cssText += '; gap:0.6rem;';
        }
    }

    function exportLeadsCsv(leads) {
        const esc = c => {
            const s = String(c ?? '');
            return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        };
        const rows = [
            ['Имя', 'Контакт', 'Потребность', 'Вероятность', 'Вердикт', 'Менеджер', 'Время просмотра', 'Время'],
            ...leads.map(l => [l.name, l.contact, l.need, l.probability, l.verdict, l.manager, l.watchTime, l.time].map(esc))
        ];
        const csv = rows.map(r => r.join(';')).join('\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `shaikh_lidy_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
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
                    <span class="probability-badge" style="background:${probColor(probability)}; color:${probText(probability)}; padding:0.25rem 0.75rem; border-radius:100px; font-size:0.78rem;">
                        ${probIcon(probability)} Вероятность продажи: <strong>${probability}</strong>
                    </span>
                </div>` : ''}
                ${verdict ? `<div class="lead-verdict"><strong>ИИ Вердикт:</strong> ${verdict}</div>` : ''}
                <div class="badge" style="margin-top:1rem; background: ${document.body.getAttribute('data-theme') === 'dark' ? 'rgba(255, 193, 7, 0.1)' : '#FEF3C7'}; color: ${document.body.getAttribute('data-theme') === 'dark' ? '#FFC107' : '#D97706'}; border: 1px solid ${document.body.getAttribute('data-theme') === 'dark' ? 'rgba(255, 193, 7, 0.3)' : 'transparent'}; padding: 0.3rem 0.8rem;">🔥 ГОРЯЧИЙ ЛИД</div>
                
                <div style="display:flex; gap:0.5rem; margin-top:12px; flex-wrap:wrap;">
                    <!-- Direct WhatsApp Button -->
                    <a href="#" class="wa-direct-btn" style="flex:1 1 calc(50% - 0.25rem); padding:10px; font-size:14px; min-width:0; display:flex; justify-content:center; align-items:center; gap:8px; border-radius:8px; text-decoration:none; font-weight:600; transition:all 0.2s;">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
                        Написать
                    </a>
                    
                    <!-- Copy Details Button -->
                    <button class="copy-btn primary-btn" style="flex:1 1 calc(50% - 0.25rem); padding:10px; font-size:14px; min-width:0; display:flex; justify-content:center; align-items:center; gap:8px;">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        Скопировать
                    </button>

                    <!-- Assign Task Button -->
                    <button class="task-lead-btn" style="flex:1 1 calc(50% - 0.25rem); padding:10px; font-size:14px; min-width:0; display:flex; justify-content:center; align-items:center; gap:8px;">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                        Задача
                    </button>

                    <!-- Generate Script Button -->
                    <button class="script-lead-btn" style="flex:1 1 calc(50% - 0.25rem); padding:10px; font-size:14px; min-width:0; display:flex; justify-content:center; align-items:center; gap:8px;">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                        Скрипт
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

            const taskBtn = card.querySelector('.task-lead-btn');
            taskBtn.addEventListener('click', () => {
                if (typeof window.__openLeadTask === 'function') {
                    window.__openLeadTask({ name: name, contact: contact, manager: manager });
                } else {
                    alert('Перейдите во вкладку «Задачи» и создайте задачу вручную.');
                }
            });

            const scriptBtn = card.querySelector('.script-lead-btn');
            scriptBtn.addEventListener('click', () => {
                if (typeof window.__generateScript === 'function') {
                    window.__generateScript({
                        offer: need || '',
                        context: `Лид: ${name} (${contact}).${need ? ' Потребность: ' + need : ''}${probability ? ' Вероятность продажи: ' + probability + '%' : ''}.`
                    });
                } else {
                    alert('Перейдите во вкладку «Скрипты» и создайте скрипт вручную.');
                }
            });

            resultsGrid.appendChild(card);
        });
    }

    // ─── Init ──────────────────────────────────────────────────────
    renderHistory();
});
