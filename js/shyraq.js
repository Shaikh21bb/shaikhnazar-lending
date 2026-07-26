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
        if (!file.name.endsWith('.csv')) {
            alert('Пожалуйста, загрузите файл в формате CSV.');
            return;
        }

        dropZone.classList.add('is-loading');

        // Parse CSV using PapaParse
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: function(results) {
                console.log("Parsed CSV Data:", results.data);
                analyzeData(results.data);
            },
            error: function(error) {
                console.error("Error parsing CSV:", error);
                alert("Ошибка при чтении файла.");
                dropZone.classList.remove('is-loading');
            }
        });
    }

    // Send parsed data to our serverless API
    async function analyzeData(data) {
        try {
            // We assume the API is deployed on Vercel at /api/analyze
            const response = await fetch('/api/analyze', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ leads: data })
            });

            if (!response.ok) {
                throw new Error('API Error: ' + response.statusText);
            }

            const result = await response.json();
            
            if (result.warmLeads && Array.isArray(result.warmLeads)) {
                renderResults(result.warmLeads);
            } else {
                alert("Не удалось найти теплые лиды в предоставленном файле.");
            }
        } catch (error) {
            console.error("Analysis Error:", error);
            alert("Произошла ошибка при анализе данных. Проверьте консоль для деталей.");
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
                `;
                
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
