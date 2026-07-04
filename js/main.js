/* =============================================
   main.js — shaikh_lending
   All interactive logic for the landing page
============================================= */

document.addEventListener('DOMContentLoaded', () => {

    /* =============================================
       TRANSLATIONS (i18n)
    ============================================= */
    const translations = {
        ru: {
            'nav.contact': 'Связаться',
            'hero.title': 'Бизнес в цифре. На автопилоте.',
            'hero.subtitle': 'shaikh_lending — премиальные сайты и AI-системы.',
            'hero.cta1': 'Обсудить',
            'hero.cta2': 'Портфолио',
            'services.title': 'Услуги',
            'services.card1.title': 'Лендинг',
            'services.card1.desc': 'Продающий дизайн. Высокая конверсия. Быстрый запуск.',
            'services.card2.title': 'AI Автоматизация',
            'services.card2.desc': 'Чат-боты и автоворонки. Ваш бизнес работает 24/7.',
            'services.card3.title': 'CRM Системы',
            'services.card3.desc': 'Порядок в клиентах. Ни одной потерянной заявки.',
            'services.card4.title': 'Под ключ',
            'services.card4.desc': 'От идеи до прибыли. Техническая часть — на нас.',
            'why.years': '2+ года',
            'why.yearsDesc': 'в digital-разработке',
            'why.desc': 'Симбиоз дизайна и технологий. Строю системы, которые приносят деньги.',
            'why.stat1': 'Клиентов',
            'why.stat2': 'Проектов',
            'why.stat3': 'Часов AI',
            'why.stat4': 'В срок',
            'how.title': 'Процесс',
            'how.step1.title': 'Анализ',
            'how.step1.desc': 'Изучаем бизнес. Строим стратегию победы.',
            'how.step2.title': 'Разработка',
            'how.step2.desc': 'Дизайн, код, интеграции. Создаём продукт.',
            'how.step3.title': 'Запуск',
            'how.step3.desc': 'Старт продаж. Поддержка. Обучение.',
            'portfolio.title': 'Работы',
            'reviews.title': 'Отзывы в Telegram',
            'reviews.desc': 'Больше реальных кейсов и отзывов в моём канале',
            'reviews.btn': 'Читать отзывы',
            'cta.title': 'Масштабируем?',
            'cta.sub': 'Напишите мне напрямую. Обсудим ваш проект.',
            'footer.tagline': 'Digital-решения для лидеров',
        },
        kz: {
            'nav.contact': 'Байланыс',
            'hero.title': 'Цифрлы бизнес. Автопилотта.',
            'hero.subtitle': 'shaikh_lending — премиум сайттар және AI жүйелері.',
            'hero.cta1': 'Талқылау',
            'hero.cta2': 'Портфолио',
            'services.title': 'Қызметтер',
            'services.card1.title': 'Лендинг',
            'services.card1.desc': 'Сатылымды дизайн. Жоғары конверсия. Жылдам іске қосу.',
            'services.card2.title': 'AI Автоматтандыру',
            'services.card2.desc': 'Чат-боттар мен автоворонкалар. Бизнес 24/7 жұмыс істейді.',
            'services.card3.title': 'CRM Жүйелер',
            'services.card3.desc': 'Клиенттер тәртіпте. Бірде-бір өтінім жоғалмайды.',
            'services.card4.title': 'Кілтпен тапсыру',
            'services.card4.desc': 'Идеядан пайдаға дейін. Техникалық бөлім — бізде.',
            'why.years': '2+ жыл',
            'why.yearsDesc': 'digital-салада',
            'why.desc': 'Дизайн мен технология үндестігі. Ақша әкелетін жүйелер құрамын.',
            'why.stat1': 'Клиент',
            'why.stat2': 'Жоба',
            'why.stat3': 'Сағат AI',
            'why.stat4': 'Мерзімде',
            'how.title': 'Процесс',
            'how.step1.title': 'Талдау',
            'how.step1.desc': 'Бизнесті зерттейміз. Жеңіс стратегиясын құрамыз.',
            'how.step2.title': 'Әзірлеу',
            'how.step2.desc': 'Дизайн, код, интеграция. Өнім жасаймыз.',
            'how.step3.title': 'Іске қосу',
            'how.step3.desc': 'Сатылым басталуы. Қолдау. Оқыту.',
            'portfolio.title': 'Жұмыстар',
            'reviews.title': 'Telegram-дағы пікірлер',
            'reviews.desc': 'Нақты кейстер мен пікірлер менің арнамда',
            'reviews.btn': 'Пікірлерді оқу',
            'cta.title': 'Дамимыз ба?',
            'cta.sub': 'Маған тікелей жазыңыз. Жобаңызды талқылайық.',
            'footer.tagline': 'Лидерлерге арналған Digital-шешімдер',
        }
    };

    let currentLang = 'ru';

    /* =============================================
       HERO TEXT ANIMATION
    ============================================= */
    function rebuildHeroText(text) {
        const el = document.getElementById('hero-text');
        if (!el) return;
        el.innerHTML = '';
        const parts = text.split(/(\s+)/);
        let delay = 0;
        parts.forEach(part => {
            if (part.match(/^\s+$/)) {
                el.appendChild(document.createTextNode(part));
                return;
            }
            const wordSpan = document.createElement('span');
            wordSpan.style.display = 'inline-block';
            [...part].forEach(char => {
                const s = document.createElement('span');
                s.textContent = char;
                s.style.animationDelay = `${delay}s`;
                delay += 0.04;
                wordSpan.appendChild(s);
            });
            el.appendChild(wordSpan);
        });
    }

    /* =============================================
       APPLY TRANSLATIONS
    ============================================= */
    function applyTranslation(lang) {
        currentLang = lang;
        const t = translations[lang];
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (t[key]) el.textContent = t[key];
        });
        // rebuild animated hero
        rebuildHeroText(t['hero.title']);
        // update lang buttons
        document.querySelectorAll('.lang-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.lang === lang);
        });
    }

    // Language switcher click
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.addEventListener('click', () => applyTranslation(btn.dataset.lang));
    });

    // Initial render
    applyTranslation('ru');

    /* =============================================
       PORTFOLIO RENDER
       Reads data from js/portfolio.js (PORTFOLIO_PROJECTS)
    ============================================= */
    function renderPortfolio() {
        const grid = document.getElementById('portfolio-grid');
        if (!grid || typeof PORTFOLIO_PROJECTS === 'undefined') return;

        grid.innerHTML = '';
        PORTFOLIO_PROJECTS.forEach(project => {
            const hasImage = project.image && project.image.trim() !== '';
            const hasLink = project.link && project.link.trim() !== '';

            const card = document.createElement('div');
            card.className = 'portfolio-card magnet-target fade-in-up';
            card.innerHTML = `
                ${hasImage
                    ? `<img src="${project.image}" alt="${project.title}" loading="lazy" onerror="this.style.display='none'">`
                    : `<div style="height:180px;background:var(--glass-bg);display:flex;align-items:center;justify-content:center;font-size:3rem">🖥</div>`
                }
                <div class="portfolio-card-body">
                    <h3>${project.title}</h3>
                    <p>${project.description}</p>
                    <div class="portfolio-tags">
                        ${project.tags.map(t => `<span class="portfolio-tag">${t}</span>`).join('')}
                    </div>
                </div>
                ${hasLink ? `<a href="${project.link}" target="_blank" rel="noopener" class="portfolio-link" title="Открыть проект">↗</a>` : ''}
            `;
            grid.appendChild(card);
        });

        // re-observe newly added fade-in-up elements
        document.querySelectorAll('#portfolio-grid .fade-in-up').forEach(el => revealObserver.observe(el));
    }

    /* =============================================
       SCROLL REVEAL (IntersectionObserver)
    ============================================= */
    const revealObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) entry.target.classList.add('visible');
        });
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

    document.querySelectorAll('.fade-in-up').forEach(el => revealObserver.observe(el));

    // Render portfolio AFTER observer is set up
    renderPortfolio();

    /* =============================================
       CUSTOM CURSOR
    ============================================= */
    const cursor = document.getElementById('cursor');
    if (cursor) {
        document.addEventListener('mousemove', (e) => {
            cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`;
        });
    }

    /* =============================================
       MAGNETIC BUTTONS
    ============================================= */
    document.querySelectorAll('.magnet-target').forEach(target => {
        target.addEventListener('mousemove', (e) => {
            const rect = target.getBoundingClientRect();
            const x = e.clientX - rect.left - rect.width / 2;
            const y = e.clientY - rect.top - rect.height / 2;
            target.style.transform = `translate(${x * 0.25}px, ${y * 0.25}px)`;
            if (cursor) cursor.classList.add('hovered');
        });
        target.addEventListener('mouseleave', () => {
            target.style.transform = '';
            if (cursor) cursor.classList.remove('hovered');
        });
    });

    /* =============================================
       HORIZONTAL SCROLL — Services
       Fixed: uses sticky + measures actual card
       overflow width, not dependent on scroll height.
    ============================================= */
    const servicesOuter = document.querySelector('.services-outer');
    const servicesTrack = document.querySelector('.services-track');

    function initHorizontalScroll() {
        if (!servicesOuter || !servicesTrack) return;
        // Only on desktop
        if (window.innerWidth <= 768) {
            servicesTrack.style.transform = '';
            return;
        }

        // How far the track can scroll horizontally
        function getMaxTranslate() {
            return servicesTrack.scrollWidth - window.innerWidth;
        }

        // Dynamically set wrapper height so scroll distance = track overflow
        function setWrapperHeight() {
            const extra = getMaxTranslate();
            // 100vh for sticky visibility + extra pixels to drive the animation
            servicesOuter.style.height = `${window.innerHeight + extra}px`;
        }

        setWrapperHeight();
        window.addEventListener('resize', setWrapperHeight);

        window.addEventListener('scroll', () => {
            if (window.innerWidth <= 768) {
                servicesTrack.style.transform = '';
                return;
            }
            const rect = servicesOuter.getBoundingClientRect();
            // rect.top goes from 0 to -(height - vh) as we scroll through the section
            const scrolled = -rect.top;   // 0 at section start, positive as we scroll
            const total = servicesOuter.offsetHeight - window.innerHeight;
            if (scrolled <= 0 || total <= 0) {
                servicesTrack.style.transform = 'translateX(0)';
                return;
            }
            const progress = Math.min(scrolled / total, 1);
            const tx = progress * getMaxTranslate();
            servicesTrack.style.transform = `translateX(-${tx}px)`;
        }, { passive: true });
    }

    initHorizontalScroll();

    /* =============================================
       STEP LINE PROGRESS
    ============================================= */
    const howSection = document.querySelector('.how-it-works');
    const lineProgress = document.getElementById('line-progress');
    const steps = document.querySelectorAll('.step-item');

    if (howSection && lineProgress) {
        window.addEventListener('scroll', () => {
            const rect = howSection.getBoundingClientRect();
            const winH = window.innerHeight;
            if (rect.top < winH && rect.bottom > 0) {
                const scrolled = 1 - rect.bottom / (rect.height + winH);
                const pct = Math.min(Math.max((scrolled - 0.15) * 180, 0), 100);
                lineProgress.style.height = `${pct}%`;
                steps.forEach(step => {
                    if (step.getBoundingClientRect().top < winH * 0.75) {
                        step.classList.add('active');
                    }
                });
            }
        }, { passive: true });
    }

    /* =============================================
       COUNTER ANIMATION
    ============================================= */
    let countersStarted = false;
    const statsGrid = document.querySelector('.stats-grid');

    if (statsGrid) {
        window.addEventListener('scroll', () => {
            if (countersStarted) return;
            const rect = statsGrid.getBoundingClientRect();
            if (rect.top < window.innerHeight * 0.85) {
                countersStarted = true;
                document.querySelectorAll('.counter').forEach(el => {
                    const target = +el.getAttribute('data-target');
                    const step = target / (2000 / 16);
                    let curr = 0;
                    const tick = () => {
                        curr += step;
                        if (curr < target) {
                            el.textContent = Math.ceil(curr) + (target > 100 ? '+' : '');
                            requestAnimationFrame(tick);
                        } else {
                            el.textContent = target + (target > 100 ? '+' : '');
                        }
                    };
                    tick();
                });
            }
        }, { passive: true });
    }

    /* =============================================
       PARTICLES CANVAS
    ============================================= */
    const canvas = document.getElementById('particles-canvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        const particles = [];

        function resizeCanvas() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        }
        window.addEventListener('resize', resizeCanvas);
        resizeCanvas();

        class Particle {
            constructor() { this.reset(); }
            reset() {
                this.x = Math.random() * canvas.width;
                this.y = Math.random() * canvas.height;
                this.size = Math.random() * 1.5 + 0.3;
                this.speedX = (Math.random() - 0.5) * 0.4;
                this.speedY = (Math.random() - 0.5) * 0.4;
                this.opacity = Math.random() * 0.4 + 0.1;
            }
            update() {
                this.x += this.speedX;
                this.y += this.speedY;
                if (this.x < 0 || this.x > canvas.width) this.speedX *= -1;
                if (this.y < 0 || this.y > canvas.height) this.speedY *= -1;
            }
            draw() {
                ctx.fillStyle = `rgba(108, 99, 255, ${this.opacity})`;
                ctx.beginPath();
                ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        for (let i = 0; i < 45; i++) particles.push(new Particle());

        function animateParticles() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            particles.forEach(p => { p.update(); p.draw(); });
            requestAnimationFrame(animateParticles);
        }
        animateParticles();
    }

}); // end DOMContentLoaded
