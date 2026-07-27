document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const resultsSection = document.getElementById('results-section');
    const resultsGrid = document.getElementById('results-grid');

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
            // Parse CSV using PapaParse
            Papa.parse(file, {
                header: true,
                skipEmptyLines: true,
                complete: function(results) {
                    console.log("Parsed CSV Data:", results.data);
                    analyzeData({ leads: results.data });
                },
                error: function(error) {
                    console.error("Error parsing CSV:", error);
                    alert("Ошибка при чтении CSV файла.");
                    dropZone.classList.remove('is-loading');
                }
            });
        } else if (file.name.endsWith('.pdf')) {
            // Read PDF and extract text using pdf.js
            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    // Set up pdf.js worker
                    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
                    
                    const typedarray = new Uint8Array(e.target.result);
                    const pdf = await pdfjsLib.getDocument(typedarray).promise;
                    
                    let fullText = '';
                    for (let i = 1; i <= pdf.numPages; i++) {
                        const page = await pdf.getPage(i);
                        const textContent = await page.getTextContent();
                        const pageText = textContent.items.map(item => item.str).join(' ');
                        fullText += pageText + '\\n';
                    }
                    
                    console.log("Parsed PDF Text:", fullText.substring(0, 200) + '...');
                    analyzeData({ pdfText: fullText });
                } catch (err) {
                    console.error("Error extracting PDF text:", err);
                    alert("Ошибка при разборе PDF файла.");
                    dropZone.classList.remove('is-loading');
                }
            };
            reader.onerror = function() {
                console.error("Error reading PDF file");
                alert("Ошибка при чтении PDF файла.");
                dropZone.classList.remove('is-loading');
            };
            reader.readAsArrayBuffer(file);
        }
    }

    // Send parsed data to our serverless API
    async function analyzeData(payload) {
        try {
            // payload is either { leads: [...] } or { pdfData: "base64..." }
            const response = await fetch('/api/analyze', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
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
                renderResults(result.warmLeads);
            } else {
                alert("Не удалось найти теплые лиды в предоставленном файле.");
            }
        } catch (error) {
            console.error("Analysis Error:", error);
            alert("Ошибка ИИ: " + error.message);
        } finally {
            dropZone.classList.remove('is-loading');
        }
    }

    // Render results in the grid
    function renderResults(leads) {
        resultsGrid.innerHTML = ''; // Clear previous results
        
        if (leads.length === 0) {
            resultsGrid.innerHTML = '<p>Подходящих лидов не найдено.</p>';
        } else {
            leads.forEach(lead => {
                const name = lead.name || lead.имя || 'Неизвестный клиент';
                const contact = lead.contact || lead.email || lead.phone || lead.телефон || 'Нет контакта';
                const watchTime = lead.watchTime || lead.time || lead['время просмотра'] || 'Неизвестно';
                
                const card = document.createElement('div');
                card.className = 'lead-card fade-in is-visible'; // Force visible since we are dynamically adding it
                
                card.innerHTML = `
                    <div class="lead-name">${name}</div>
                    <div class="lead-detail">
                        <span>Контакт:</span>
                        <span class="lead-value">${contact}</span>
                    </div>
                    <div class="lead-detail">
                        <span>Время просмотра:</span>
                        <span class="lead-value">${watchTime}</span>
                    </div>
                    <div class="badge">Высокий приоритет</div>
                    <button class="copy-btn primary-btn" style="width: 100%; margin-top: 15px; padding: 10px; font-size: 14px; display: flex; justify-content: center; align-items: center; gap: 8px;">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        Копировать
                    </button>
                `;
                
                const copyBtn = card.querySelector('.copy-btn');
                copyBtn.addEventListener('click', () => {
                    const textToCopy = `Имя: ${name}\\nКонтакт: ${contact}\\nВремя просмотра: ${watchTime}`;
                    navigator.clipboard.writeText(textToCopy).then(() => {
                        const originalText = copyBtn.innerHTML;
                        copyBtn.innerHTML = 'Скопировано! ✅';
                        copyBtn.style.background = '#4CAF50';
                        copyBtn.style.color = '#fff';
                        setTimeout(() => {
                            copyBtn.innerHTML = originalText;
                            copyBtn.style.background = '';
                            copyBtn.style.color = '';
                        }, 2000);
                    }).catch(err => {
                        console.error('Ошибка копирования:', err);
                        alert('Не удалось скопировать текст.');
                    });
                });

                resultsGrid.appendChild(card);
            });
        }

        // Show the results section
        resultsSection.style.display = 'block';
        
        // Let CSS adjust, then recalculate smooth scroll height
        setTimeout(() => {
            resultsSection.classList.add('is-visible');
            window.dispatchEvent(new Event('resize'));
            
            // Scroll down to results
            const yOffset = resultsSection.getBoundingClientRect().top + window.scrollY;
            window.scrollTo({ top: yOffset - 100, behavior: 'smooth' });
        }, 100);
    }
});
