/*
 * Portfolio content lives here so a new project can be added without editing
 * the page layout. Copy one object, give it a unique id, and fill both ru/kk.
 * Use status: live, demo, or private. Never publish unverified results.
 */
window.PORTFOLIO_PROJECTS = [
    {
        id: 'urpaq',
        title: 'Urpaq.ai',
        year: '2026',
        status: 'live',
        filter: 'live',
        category: {
            ru: 'EdTech · Web product',
            kk: 'EdTech · Веб-өнім'
        },
        summary: {
            ru: 'Образовательная платформа с AI-инструментами для подготовки учебных материалов и работы с уроками.',
            kk: 'Оқу материалдарын дайындауға және сабақтармен жұмыс істеуге арналған AI-құралдары бар білім беру платформасы.'
        },
        format: {
            ru: 'Рабочая веб-версия',
            kk: 'Жұмыс істейтін веб-нұсқа'
        },
        focus: {
            ru: 'Продукт, интерфейс, AI-сценарии',
            kk: 'Өнім, интерфейс, AI-сценарийлер'
        },
        tags: ['EdTech', 'Product design', 'AI', 'Web'],
        image: './images/project1.jpg',
        imageAlt: {
            ru: 'Главный экран образовательной платформы Urpaq.ai',
            kk: 'Urpaq.ai білім беру платформасының басты беті'
        },
        link: 'https://urpaq-edu.vercel.app/',
        external: true
    },
    {
        id: 'binom-ai',
        title: 'BINOM AI',
        year: '2026',
        status: 'live',
        filter: 'live',
        category: {
            ru: 'Procurement · AI platform',
            kk: 'Сатып алу · AI-платформа'
        },
        summary: {
            ru: 'Веб-платформа для подготовки тендерных документов и работы с закупочными материалами. Публичная версия и backend доступны.',
            kk: 'Тендерлік құжаттарды дайындауға және сатып алу материалдарымен жұмыс істеуге арналған веб-платформа. Ашық нұсқасы мен backend қолжетімді.'
        },
        format: {
            ru: 'Рабочая веб-версия',
            kk: 'Жұмыс істейтін веб-нұсқа'
        },
        focus: {
            ru: 'Документы, workflow, AI-инструменты',
            kk: 'Құжаттар, workflow, AI-құралдар'
        },
        tags: ['B2B', 'Procurement', 'AI', 'Web app'],
        visual: 'cover',
        visualTheme: 'binom',
        coverLabel: {
            ru: 'Тендерные документы и рабочие процессы',
            kk: 'Тендерлік құжаттар және жұмыс процестері'
        },
        imageAlt: {
            ru: 'Стилизованная обложка проекта BINOM AI',
            kk: 'BINOM AI жобасының стильденген мұқабасы'
        },
        link: 'https://binom-ai-vprod.vercel.app/',
        external: true
    },
    {
        id: 'forest-id',
        title: 'FOREST ID',
        year: '2026',
        status: 'live',
        filter: 'live',
        category: {
            ru: 'EcoTech · Digital registry',
            kk: 'EcoTech · Цифрлық тізілім'
        },
        summary: {
            ru: 'Казахоязычный каталог цифровых паспортов деревьев с QR-сценариями и формой для полевых исследований.',
            kk: 'Ағаштардың цифрлық паспорттары, QR-сценарийлері және далалық зерттеу формасы бар қазақша каталог.'
        },
        format: {
            ru: 'Рабочий веб-каталог',
            kk: 'Жұмыс істейтін веб-каталог'
        },
        focus: {
            ru: 'Каталог, QR, сбор данных',
            kk: 'Каталог, QR, деректер жинау'
        },
        tags: ['EcoTech', 'QR', 'Catalog', 'Kazakh'],
        visual: 'cover',
        visualTheme: 'forest',
        coverLabel: {
            ru: 'Цифровые паспорта городских деревьев',
            kk: 'Қала ағаштарының цифрлық паспорттары'
        },
        imageAlt: {
            ru: 'Стилизованная обложка проекта FOREST ID',
            kk: 'FOREST ID жобасының стильденген мұқабасы'
        },
        link: 'https://shaikh21bb.github.io/forest-id/',
        external: true
    },
    {
        id: 'pyrascope',
        title: 'Pyrascope',
        year: '2026',
        status: 'demo',
        filter: 'demo',
        category: {
            ru: 'Analytics · UI concept',
            kk: 'Analytics · UI тұжырымдамасы'
        },
        summary: {
            ru: 'Демо интерфейса для мониторинга финансовых рисков и связанных Telegram-каналов. Данные на экране демонстрационные.',
            kk: 'Қаржылық тәуекелдер мен байланысты Telegram-арналарды бақылауға арналған интерфейс демосы. Экрандағы деректер демонстрациялық.'
        },
        format: {
            ru: 'Концепт интерфейса',
            kk: 'Интерфейс тұжырымдамасы'
        },
        focus: {
            ru: 'Dashboard, визуализация, UX',
            kk: 'Dashboard, визуализация, UX'
        },
        tags: ['Dashboard', 'Analytics', 'Research', 'UI'],
        image: './images/project2.jpg',
        imageAlt: {
            ru: 'Демо панели мониторинга Pyrascope',
            kk: 'Pyrascope мониторинг панелінің демосы'
        },
        link: 'https://shaikh21bb.github.io/pyrascope/',
        external: true
    },
    {
        id: 'jadyra',
        title: 'Jadyra',
        year: '2026',
        status: 'demo',
        filter: 'demo',
        category: {
            ru: 'Beauty · Commercial landing',
            kk: 'Beauty · Коммерциялық лендинг'
        },
        summary: {
            ru: 'Адаптивный лендинг салона с услугами, адресом и быстрым переходом в WhatsApp. Внутренняя форма записи работает как демо.',
            kk: 'Қызметтер, мекенжай және WhatsApp-қа жылдам өтуі бар салонның бейімделгіш лендингі. Ішкі жазылу формасы демо ретінде жұмыс істейді.'
        },
        format: {
            ru: 'Публичное демо',
            kk: 'Ашық демо'
        },
        focus: {
            ru: 'Лендинг, мобильный UX, лиды',
            kk: 'Лендинг, мобильді UX, өтінімдер'
        },
        tags: ['Landing', 'Small business', 'Mobile', 'WhatsApp'],
        visual: 'cover',
        visualTheme: 'jadyra',
        coverLabel: {
            ru: 'Сайт услуг с быстрым выходом на связь',
            kk: 'Жылдам байланысы бар қызметтер сайты'
        },
        imageAlt: {
            ru: 'Стилизованная обложка лендинга Jadyra',
            kk: 'Jadyra лендингінің стильденген мұқабасы'
        },
        link: 'https://jadyra-salon.vercel.app/',
        external: true
    },
    {
        id: 'enactus-sherkhan',
        title: 'Enactus Sherkhan',
        year: '2026',
        status: 'live',
        filter: 'live',
        category: {
            ru: 'Community · Bilingual website',
            kk: 'Қауымдастық · Екі тілді сайт'
        },
        summary: {
            ru: 'Двуязычный сайт студенческой команды с проектами, участниками, формой вступления и быстрым контактом через WhatsApp.',
            kk: 'Жобалар, команда мүшелері, қосылу формасы және WhatsApp арқылы жылдам байланысы бар студенттік команданың екі тілді сайты.'
        },
        format: {
            ru: 'Рабочий публичный сайт',
            kk: 'Жұмыс істейтін ашық сайт'
        },
        focus: {
            ru: 'RU/KZ, структура, вовлечение',
            kk: 'RU/KZ, құрылым, қатысу'
        },
        tags: ['Community', 'RU/KZ', 'Responsive', 'WhatsApp'],
        visual: 'cover',
        visualTheme: 'sherkhan',
        coverLabel: {
            ru: 'Проекты, команда и набор участников',
            kk: 'Жобалар, команда және қатысушыларды қабылдау'
        },
        imageAlt: {
            ru: 'Стилизованная обложка сайта Enactus Sherkhan',
            kk: 'Enactus Sherkhan сайтының стильденген мұқабасы'
        },
        link: 'https://enactus-sherkhan.vercel.app/',
        external: true
    },
    {
        id: 'shaikh-workspace',
        title: 'SHAIKH Workspace',
        year: '2026',
        status: 'private',
        filter: 'platform',
        category: {
            ru: 'Sales operations · Platform',
            kk: 'Sales operations · Платформа'
        },
        summary: {
            ru: 'Закрытая рабочая платформа для анализа заявок, настройки AI-сценариев, задач и статистики. Доступ выдаётся по приглашению.',
            kk: 'Өтінімдерді талдауға, AI-сценарийлерді, тапсырмалар мен статистиканы баптауға арналған жабық жұмыс платформасы. Қолжетімділік шақыру арқылы беріледі.'
        },
        format: {
            ru: 'Закрытый пилот',
            kk: 'Жабық пилот'
        },
        focus: {
            ru: 'Панель управления и автоматизация',
            kk: 'Басқару панелі және автоматтандыру'
        },
        tags: ['CRM', 'AI tools', 'Tasks', 'Dashboard'],
        visual: 'workspace',
        imageAlt: {
            ru: 'Схематичное превью закрытой платформы SHAIKH Workspace',
            kk: 'SHAIKH Workspace жабық платформасының сызбалық көрінісі'
        },
        link: './login.html',
        external: false
    }
];
