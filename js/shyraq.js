document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const resultsSection = document.getElementById('results-section');
    const resultsGrid = document.getElementById('results-grid');
    const managerTabsEl = document.getElementById('manager-tabs');
    const managersCountInput = document.getElementById('managers-count');

    // All leads storage for filtering
    let allLeads = [];

    // Make drop zone clickable to trigger file input
    dropZone.addEventListener('click', () => {
        if (!dropZone.classList.contains('is-loading')) {
            fileInput.click();
        }
    });

    // Handle Drag & Drop events
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) {
            handleFile(e.dataTransfer.files[0]);
        }
    });

    // Handle File Input change
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) {
            handleFile(e.target.files[0]);
        }
    });

    // Process the file
    function handleFile(file) {
        if (!file.name.endsWith('.csv') && !file.name.endsWith('.pdf')) {
            alert('Пожалуйста, загрузите файл в формате CSV или PDF.');
            return;
        }

        dropZone.classList.add('is-loading');

        if (file.name.endsWith('.csv')) {
            Papa.parse(file, {
                header: true,
                skipEmptyLines: true,
                complete: function(results) {
                    analyzeData({ leads: results.data });
                },
                error: function(error) {
                    console.error("Error parsing CSV:", error);
                    alert("Ошибка при чтении CSV файла.");
                    dropZone.classList.remove('is-loading');
                }
            });
        } else if (file.name.endsWith('.pdf')) {
            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
                    const typedarray = new Uint8Array(e.target.result);
                    const pdf = await pdfjsLib.getDocument(typedarray).promise;

                    let fullText = '';
                    for (let i = 1; i <= pdf.numPages; i++) {
                        const page = await pdf.getPage(i);
                        const textContent = await page.getTextContent();
                        fullText += textContent.items.map(item => item.str).join(' ') + '\n';
                    }
                    analyzeData({ pdfText: fullText });
                } catch (err) {
                    console.error("Error extracting PDF text:", err);
                    alert("Ошибка при разборе PDF файла.");
                    dropZone.classList.remove('is-loading');
                }
            };
            reader.onerror = function() {
                alert("Ошибка при чтении PDF файла.");
                dropZone.classList.remove('is-loading');
            };
            reader.readAsArrayBuffer(file);
        }
    }

    // Send parsed data to our serverless API
    async function analyzeData(payload) {
        try {
            // Attach managers count
            payload.managersCount = parseInt(managersCountInput.value) || 1;

            const response = await fetch('/api/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                let errDetails = response.statusText;
                try {
                    const errData = await response.json();
                    if (errData.details) errDetails = errData.details;
                } catch (e) {}
                throw new Error('API Error: ' + errDetails);
            }

            const result = await response.json();

            if (result.warmLeads && Array.isArray(result.warmLeads)) {
                allLeads = result.warmLeads;
                renderResults(allLeads);
            } else {
                alert("Не удалось найти горячих лидов в предоставленном файле.");
            }
        } catch (error) {
            console.error("Analysis Error:", error);
            alert("Ошибка ИИ: " + error.message);
        } finally {
            dropZone.classList.remove('is-loading');
        }
    }

    // Build manager filter tabs
    function buildManagerTabs(leads) {
        managerTabsEl.innerHTML = '';
        const managers = [...new Set(leads.map(l => l.manager).filter(Boolean))].sort();

        if (managers.length <= 1) return; // No tabs needed for 1 manager

        // "All" tab
        const allTab = document.createElement('button');
        allTab.className = 'manager-tab active';
        allTab.textContent = `Все (${leads.length})`;
        allTab.addEventListener('click', () => {
            document.querySelectorAll('.manager-tab').forEach(t => t.classList.remove('active'));
            allTab.classList.add('active');
            renderCards(leads);
        });
        managerTabsEl.appendChild(allTab);

        managers.forEach(manager => {
            const managerLeads = leads.filter(l => l.manager === manager);
            const tab = document.createElement('button');
            tab.className = 'manager-tab';
            tab.textContent = `${manager} (${managerLeads.length})`;
            tab.addEventListener('click', () => {
                document.querySelectorAll('.manager-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                renderCards(managerLeads);
            });
            managerTabsEl.appendChild(tab);
        });
    }

    // Render results in the grid
    function renderResults(leads) {
        const subtitle = document.getElementById('results-subtitle');
        if (subtitle) {
            subtitle.textContent = `Найдено горячих лидов: ${leads.length}. Отранжированы по времени просмотра.`;
        }

        buildManagerTabs(leads);
        renderCards(leads);

        // Show the results section
        resultsSection.style.display = 'block';
        setTimeout(() => {
            resultsSection.classList.add('is-visible');
            window.dispatchEvent(new Event('resize'));
            const yOffset = resultsSection.getBoundingClientRect().top + window.scrollY;
            window.scrollTo({ top: yOffset - 100, behavior: 'smooth' });
        }, 100);
    }

    // Render lead cards for given leads array
    function renderCards(leads) {
        resultsGrid.innerHTML = '';

        if (leads.length === 0) {
            resultsGrid.innerHTML = '<p style="text-align:center; color: var(--text-secondary);">Лидов по данному менеджеру нет.</p>';
            return;
        }

        leads.forEach(lead => {
            const name = lead.name || lead.имя || 'Неизвестный клиент';
            const contact = lead.contact || lead.email || lead.phone || lead.телефон || 'Нет контакта';
            const watchTime = lead.watchTime || lead.time || lead['время просмотра'] || 'Неизвестно';
            const verdict = lead.verdict || '';
            const manager = lead.manager || '';

            const card = document.createElement('div');
            card.className = 'lead-card fade-in is-visible';

            card.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.5rem; margin-bottom:0.5rem;">
                    <div class="lead-name">${name}</div>
                    ${manager ? `<span class="manager-badge">${manager}</span>` : ''}
                </div>
                <div class="lead-detail">
                    <span>Контакт:</span>
                    <span class="lead-value">${contact}</span>
                </div>
                <div class="lead-detail">
                    <span>Время просмотра:</span>
                    <span class="lead-value">${watchTime}</span>
                </div>
                ${verdict ? `<div class="lead-verdict">💬 ${verdict}</div>` : ''}
                <div class="badge" style="margin-top:1rem;">🔥 Горячий лид</div>
                <button class="copy-btn primary-btn" style="width: 100%; margin-top: 12px; padding: 10px; font-size: 14px; display: flex; justify-content: center; align-items: center; gap: 8px;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    Скопировать для WhatsApp
                </button>
            `;

            const copyBtn = card.querySelector('.copy-btn');
            copyBtn.addEventListener('click', () => {
                const textToCopy = `Имя: ${name}\nКонтакт: ${contact}\nВремя просмотра: ${watchTime}${verdict ? '\nВердикт: ' + verdict : ''}${manager ? '\nМенеджер: ' + manager : ''}`;
                navigator.clipboard.writeText(textToCopy).then(() => {
                    const originalHTML = copyBtn.innerHTML;
                    copyBtn.innerHTML = 'Скопировано! ✅';
                    copyBtn.style.background = '#4CAF50';
                    copyBtn.style.color = '#fff';
                    setTimeout(() => {
                        copyBtn.innerHTML = originalHTML;
                        copyBtn.style.background = '';
                        copyBtn.style.color = '';
                    }, 2000);
                }).catch(() => alert('Не удалось скопировать текст.'));
            });

            resultsGrid.appendChild(card);
        });
    }
});
