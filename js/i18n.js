document.addEventListener('DOMContentLoaded', () => {
    const KEY = 'shaikh_lang';
    let lang = window.__getLang ? window.__getLang() : (localStorage.getItem(KEY) || 'ru');

    const KK = {
        'nav.analyzer': 'ИИ-талдау',
        'nav.agents': 'Агенттер',
        'nav.clients': 'Клиенттер',
        'nav.tasks': 'Тапсырмалар',
        'nav.scripts': 'Скрипттер',
        'nav.stats': 'Статистика',
        'nav.site': 'Сайт',
        'nav.logout': 'Шығу',
        't.analyzer': 'AI лидтер талдауы',
        't.analyzer-sub': 'Вебинар көрермендерінің CSV немесе PDF деректерін жүктеңіз. AI ең «жылу» клиенттерді тауып береді.',
        't.agents': 'Менің агенттерім',
        't.agents-sub': 'Telegram және WhatsApp үшін AI-боттар. Агенттер қосып, оларды басқарыңыз.',
        't.projects': 'Оқыту',
        't.projects-sub': 'Жобалар — агенттер оқитын білім базасы. Болашақ жобалар туралы ақпарат қосыңыз.',
        't.tasks': 'Тапсырмалар және күнтізбе',
        't.tasks-sub': 'Тапсырмаларды менеджерлерге жіберіңіз — агент Telegram-да жіберіп, олар чатта растайды. Еске салулар автоматты: расталмаған (30 мин), мерзім жақын (1 сағ), кешіктірілген.',
        't.managers': 'Менеджерлер',
        't.managers-sub': 'Менеджерлерді және олардың Telegram chat ID-ін қосыңыз — тапсырмалар соларға келеді. Chat ID-ін @userinfobot ботынан білесіз.',
        't.scripts': 'Сату скриптілері',
        't.scripts-sub': 'Әр клиентке дайын скриптілер. Лидтен генерациялаңыз — менеджерге тек қоңырау шалу қалады.',
        't.clients': 'Клиенттер',
        't.clients-sub': 'Агенттеріңізге жазған барлық клиенттер. Соңғы хабарлама, белсенділік және жылдам әрекеттер.',
        't.stats': 'Статистика',
        't.stats-sub': 'Агенттер, тапсырмалар, диалогтар және скриптілер бойынша қорытынды.',
        'b.addAgent': 'Агент қосу',
        'b.addProject': 'Жоба қосу',
        'b.newTask': 'Жаңа тапсырма',
        'b.addManager': 'Менеджер қосу',
        'b.createScript': 'Скрипт жасау',
        'b.refresh': 'Жаңарту',
        'm.newProject': 'Жаңа жоба',
        'm.newAgent': 'Жаңа агент',
        'm.newTaskModal': 'Жаңа тапсырма',
        'm.newManager': 'Жаңа менеджер',
        'm.broadcast': 'Клиенттерге тарату',
        'm.script': 'Сату скриптісі',
        'h.clearAll': 'Бәрін тазалау',
        'h.open': 'Ашу'
    };

    const RANGE_KK = { all: 'Барлық уақыт', today: 'Бүгін', '7d': '7 күн', '30d': '30 күн', '90d': '90 күн' };
    const RANGE_RU = { all: 'Всё время', today: 'Сегодня', '7d': '7 дней', '30d': '30 дней', '90d': '90 дней' };

    function apply() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.dataset.i18n;
            if (lang === 'kk') {
                el.textContent = KK[key] || el.dataset.i18nRu || el.textContent;
            } else {
                el.textContent = el.dataset.i18nRu || el.textContent;
            }
        });
        [['lang-toggle', 'Русский', 'Қазақша'], ['lang-toggle-mobile', 'Русский', 'Қазақша']].forEach(([id, ru, kk]) => {
            const btn = document.getElementById(id);
            if (btn) btn.textContent = lang === 'kk' ? ru : kk;
        });
        const range = document.getElementById('stats-range');
        if (range) {
            Array.from(range.options).forEach(o => {
                const map = lang === 'kk' ? RANGE_KK : RANGE_RU;
                if (map[o.value]) o.textContent = map[o.value];
            });
        }
        const cs = document.getElementById('clients-search');
        if (cs) {
            cs.placeholder = lang === 'kk'
                ? 'chat ID, телефон немесе мәтін бойынша іздеу...'
                : 'Поиск по chat ID, телефону или тексту...';
        }
    }

    const toggle = (btnId) => {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        btn.addEventListener('click', () => {
            lang = lang === 'kk' ? 'ru' : 'kk';
            localStorage.setItem(KEY, lang);
            apply();
        });
    };
    toggle('lang-toggle');
    toggle('lang-toggle-mobile');

    apply();
});