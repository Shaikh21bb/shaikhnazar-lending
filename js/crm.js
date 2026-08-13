document.addEventListener('DOMContentLoaded', () => {
    const CRM_TABLE = 'leads';

    const STATUSES = [
        { key: 'new', label: 'Новые' },
        { key: 'contacted', label: 'На связи' },
        { key: 'negotiation', label: 'Договор' },
        { key: 'deal', label: 'Сделка' },
        { key: 'lost', label: 'Закрыт' }
    ];

    let allLeads = [];
    let currentLead = null;

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function fmtDate(value) {
        if (!value) return '';
        const d = new Date(value);
        if (isNaN(d)) return '';
        return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }

    document.querySelectorAll('.nav-item').forEach(item => {
        if (item.classList.contains('disabled')) return;
        item.addEventListener('click', (e) => {
            e.preventDefault();
            document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            const view = item.getAttribute('href').slice(1);
            document.querySelectorAll('.dashboard-view').forEach(v => v.classList.remove('active-view'));
            const target = document.getElementById('view-' + view);
            if (target) target.classList.add('active-view');
        });
    });

    async function loadLeads() {
        const board = document.getElementById('crm-board');
        if (!board) return;
        const { data, error } = await supabaseClient.from(CRM_TABLE).select('*').order('created_at', { ascending: false });
        if (error) {
            console.error('CRM load error:', error);
            board.innerHTML = `<div class="crm-empty">Ошибка загрузки: ${escapeHtml(error.message)}</div>`;
            return;
        }
        allLeads = data || [];
        renderBoard();
    }

    function renderBoard() {
        const board = document.getElementById('crm-board');
        board.innerHTML = '';
        STATUSES.forEach(col => {
            const leads = allLeads.filter(l => (l.status || 'new') === col.key);
            const colEl = document.createElement('div');
            colEl.className = 'crm-column';
            colEl.dataset.status = col.key;

            const header = document.createElement('div');
            header.className = 'crm-col-header';
            header.innerHTML = `<span class="crm-col-title">${col.label}</span><span class="crm-col-count">${leads.length}</span>`;
            colEl.appendChild(header);

            const list = document.createElement('div');
            list.className = 'crm-col-list';
            if (leads.length === 0) {
                list.innerHTML = `<div class="crm-empty">Пусто</div>`;
            } else {
                leads.forEach(lead => list.appendChild(buildCard(lead)));
            }
            colEl.appendChild(list);

            colEl.addEventListener('dragover', e => { e.preventDefault(); colEl.classList.add('dragover'); });
            colEl.addEventListener('dragleave', () => colEl.classList.remove('dragover'));
            colEl.addEventListener('drop', e => {
                e.preventDefault();
                colEl.classList.remove('dragover');
                const id = e.dataTransfer.getData('text/plain');
                if (id) updateStatus(id, col.key);
            });

            board.appendChild(colEl);
        });
    }

    function buildCard(lead) {
        const card = document.createElement('div');
        card.className = 'crm-card';
        card.draggable = true;
        card.dataset.id = lead.id;
        card.addEventListener('dragstart', e => {
            e.dataTransfer.setData('text/plain', lead.id);
            card.style.opacity = '0.5';
        });
        card.addEventListener('dragend', () => { card.style.opacity = ''; });
        card.addEventListener('click', () => openModal(lead));

        const prob = (lead.probability || 'средняя').toLowerCase();
        card.innerHTML = `
            <div class="crm-card-top">
                <span class="crm-prob prob-${escapeHtml(prob)}"></span>
                <span class="crm-card-name">${escapeHtml(lead.name || 'Без имени')}</span>
            </div>
            <div class="crm-card-contact">${escapeHtml(lead.contact || '')}</div>
            ${lead.need ? `<div class="crm-card-need">${escapeHtml(lead.need)}</div>` : ''}
            <div class="crm-card-foot">
                ${lead.manager ? `<span class="crm-card-manager">${escapeHtml(lead.manager)}</span>` : ''}
                ${lead.follow_up ? `<span class="crm-card-time">⏰ ${escapeHtml(fmtDate(lead.follow_up))}</span>` : ''}
            </div>
        `;
        return card;
    }

    async function updateStatus(id, status) {
        const { error } = await supabaseClient.from(CRM_TABLE).update({ status }).eq('id', id);
        if (error) console.error('Status update error:', error);
        loadLeads();
    }

    /* ─── Modal ─── */
    const modal = document.getElementById('crm-modal');
    const modalName = document.getElementById('crm-modal-name');
    const modalContact = document.getElementById('crm-modal-contact');
    const modalNeed = document.getElementById('crm-modal-need');
    const modalStatus = document.getElementById('crm-status');
    const modalFollowUp = document.getElementById('crm-follow-up');
    const modalNotes = document.getElementById('crm-notes');
    const modalWa = document.getElementById('crm-wa');
    const modalSave = document.getElementById('crm-save');
    const modalDelete = document.getElementById('crm-delete');
    const modalClose = document.getElementById('crm-modal-close');

    function openModal(lead) {
        currentLead = lead;
        modalName.textContent = lead.name || 'Без имени';
        modalContact.textContent = lead.contact || '';
        modalNeed.textContent = lead.need || '';
        modalStatus.value = lead.status || 'new';
        modalNotes.value = lead.notes || '';
        modalFollowUp.value = lead.follow_up ? String(lead.follow_up).slice(0, 16) : '';

        const digits = (lead.contact || '').replace(/\D/g, '');
        if (digits.length >= 10) {
            const clean = digits.length === 11 && digits.startsWith('8') ? '7' + digits.slice(1) : digits;
            modalWa.href = `https://wa.me/${clean}?text=${encodeURIComponent(`Здравствуйте, ${lead.name || ''}!`)}`;
            modalWa.style.display = '';
        } else {
            modalWa.style.display = 'none';
        }
        modal.classList.add('open');
    }

    function closeModal() {
        modal.classList.remove('open');
        currentLead = null;
    }

    if (modalClose) modalClose.addEventListener('click', closeModal);
    if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

    if (modalSave) modalSave.addEventListener('click', async () => {
        if (!currentLead) return;
        const followUp = modalFollowUp.value ? new Date(modalFollowUp.value).toISOString() : null;
        const { error } = await supabaseClient.from(CRM_TABLE).update({
            status: modalStatus.value,
            notes: modalNotes.value,
            follow_up: followUp
        }).eq('id', currentLead.id);
        if (error) {
            alert('Ошибка сохранения: ' + error.message);
            return;
        }
        closeModal();
        loadLeads();
    });

    if (modalDelete) modalDelete.addEventListener('click', async () => {
        if (!currentLead) return;
        if (!confirm('Удалить лида из CRM?')) return;
        const { error } = await supabaseClient.from(CRM_TABLE).delete().eq('id', currentLead.id);
        if (error) {
            alert('Ошибка удаления: ' + error.message);
            return;
        }
        closeModal();
        loadLeads();
    });

    /* ─── Send analyzed leads to CRM ─── */
    window.__sendToCrm = async () => {
        const leads = window.__lastLeads;
        if (!leads || leads.length === 0) {
            alert('Сначала выполните анализ — результаты появятся после загрузки файла.');
            return;
        }
        const { data: existing, error: exErr } = await supabaseClient.from(CRM_TABLE).select('contact');
        if (exErr) {
            alert('Ошибка: ' + exErr.message);
            return;
        }
        const existingSet = new Set((existing || []).map(l => l.contact));
        const toInsert = leads
            .filter(l => !existingSet.has(l.contact))
            .map(l => ({
                name: l.name,
                contact: l.contact,
                watch_time: l.watchTime,
                verdict: l.verdict,
                need: l.need,
                probability: l.probability,
                manager: l.manager,
                status: 'new'
            }));

        if (toInsert.length === 0) {
            alert('Все лиды из этого анализа уже добавлены в CRM.');
            return;
        }
        const { error } = await supabaseClient.from(CRM_TABLE).insert(toInsert);
        if (error) {
            alert('Ошибка добавления: ' + error.message);
            return;
        }
        alert(`Добавлено лидов в CRM: ${toInsert.length}`);
        loadLeads();
        document.querySelector('.nav-item[href="#crm"]').click();
    };

    loadLeads();
});
