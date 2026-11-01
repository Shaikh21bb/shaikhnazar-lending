/* Native touch scrolling and accessible controls also work without GSAP. */
(() => {
    if (window.gsap && window.ScrollTrigger) window.gsap.registerPlugin(window.ScrollTrigger);
    function createExperience() {
        const gallery = document.getElementById('project-grid');
        if (!gallery) return () => {};
        const previous = document.getElementById('project-previous');
        const next = document.getElementById('project-next');
        const position = document.getElementById('project-position');
        const progress = document.getElementById('project-scroll-progress');
        const mobile = matchMedia('(max-width: 800px)');
        const reduced = matchMedia('(prefers-reduced-motion: reduce)');
        const gsap = window.gsap;
        const ScrollTrigger = window.ScrollTrigger;
        let frame = 0;
        let refreshTimer = 0;
        let activeIndex = 0;
        let scene;
        let projectScene;
        let readingTrigger;
        let dialogTween;
        let stopped = false;
        let introPlayed = false;
        const cards = () => [...gallery.querySelectorAll('.project-card')];

        function updateGallery() {
            frame = 0;
            if (stopped) return;
            const items = cards();
            if (!items.length) return;
            const bounds = gallery.getBoundingClientRect();
            const center = bounds.left + gallery.clientWidth / 2;
            let distance = Infinity;
            items.forEach((card, index) => {
                const rect = card.getBoundingClientRect();
                const delta = Math.abs(rect.left + rect.width / 2 - center);
                if (delta < distance) { distance = delta; activeIndex = index; }
            });
            items.forEach((card, index) => card.classList.toggle('is-current', index === activeIndex));
            gallery.dataset.activeIndex = String(activeIndex);
            if (position) position.textContent = `${String(activeIndex + 1).padStart(2, '0')} / ${String(items.length).padStart(2, '0')}`;
            if (previous) previous.disabled = activeIndex === 0;
            if (next) next.disabled = activeIndex === items.length - 1;
            if (progress) progress.style.transform = `scaleX(${(activeIndex + 1) / items.length})`;
            if (mobile.matches) gallery.setAttribute('aria-roledescription', 'карусель');
            else gallery.removeAttribute('aria-roledescription');
        }
        function queueGallery() {
            if (!frame) frame = requestAnimationFrame(updateGallery);
        }
        function goTo(index) {
            const items = cards();
            const target = items[Math.max(0, Math.min(items.length - 1, index))];
            if (!target || !items[0]) return;
            gallery.scrollTo({ left: target.offsetLeft - items[0].offsetLeft, behavior: reduced.matches ? 'auto' : 'smooth' });
        }
        const goPrevious = () => goTo(activeIndex - 1);
        const goNext = () => goTo(activeIndex + 1);
        const keyboard = event => {
            if (!mobile.matches || event.target !== gallery || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            goTo(event.key === 'Home' ? 0 : event.key === 'End' ? cards().length - 1 : activeIndex + (event.key === 'ArrowRight' ? 1 : -1));
        };
        function refresh() {
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => {
                if (!stopped) { ScrollTrigger?.refresh(); queueGallery(); }
            }, 120);
        }
        function rebuildProjects() {
            projectScene?.revert();
            if (gsap && ScrollTrigger) {
                projectScene = gsap.matchMedia();
                projectScene.add('(min-width: 801px) and (prefers-reduced-motion: no-preference)', () => {
                    cards().forEach(card => {
                        const image = card.querySelector('.project-media img');
                        if (!image) return;
                        gsap.fromTo(image, { yPercent: 3, scale: 1.075 }, {
                            yPercent: -3, scale: 1.075, ease: 'none',
                            scrollTrigger: { trigger: card, start: 'top bottom', end: 'bottom top', scrub: .5 }
                        });
                    });
                });
            }
            const remembered = Number(gallery.dataset.activeIndex) || 0;
            const items = cards();
            if (mobile.matches && items[remembered]) gallery.scrollLeft = items[remembered].offsetLeft - items[0].offsetLeft;
            queueGallery();
            refresh();
        }
        function animateDialog() {
            dialogTween?.kill();
            if (!gsap || reduced.matches) return;
            dialogTween = gsap.fromTo('#project-dialog .dialog-content', { y: 16, opacity: 0 }, {
                y: 0, opacity: 1, duration: .45, ease: 'power2.out', clearProps: 'transform,opacity'
            });
        }
        function clearDialogMotion() {
            dialogTween?.kill();
            if (gsap) gsap.set('#project-dialog .dialog-content', { clearProps: 'transform,opacity' });
        }
        const imageLoaded = event => { if (event.target?.tagName === 'IMG') refresh(); };
        previous?.addEventListener('click', goPrevious);
        next?.addEventListener('click', goNext);
        gallery.addEventListener('scroll', queueGallery, { passive: true });
        gallery.addEventListener('keydown', keyboard);
        window.addEventListener('resize', queueGallery, { passive: true });
        window.addEventListener('portfolio:rendered', rebuildProjects);
        window.addEventListener('portfolio:opened', animateDialog);
        document.addEventListener('load', imageLoaded, true);
        reduced.addEventListener('change', clearDialogMotion);

        if (gsap && ScrollTrigger) {
            ScrollTrigger.config({ ignoreMobileResize: true });
            document.body.classList.add('motion-ready');
            const setReadingProgress = gsap.quickSetter('.island-progress', 'scaleX');
            readingTrigger = ScrollTrigger.create({ start: 0, end: 'max', onUpdate: self => setReadingProgress(self.progress), onRefresh: self => setReadingProgress(self.progress) });
            scene = gsap.matchMedia();
            scene.add({ mobile: '(max-width: 800px)', desktop: '(min-width: 801px)', reduce: '(prefers-reduced-motion: reduce)' }, context => {
                if (context.conditions.reduce) return;
                const phone = context.conditions.mobile;
                if (!introPlayed && window.scrollY < 40) {
                    introPlayed = true;
                    gsap.timeline({ defaults: { ease: 'power3.out', duration: .85 } })
                        .from('.hero-title > span', { y: 28, opacity: 0, stagger: .09, clearProps: 'transform,opacity' }, 0)
                        .from('.hero-copy .eyebrow, .hero-lead, .hero-actions', { y: 14, opacity: 0, stagger: .08, clearProps: 'transform,opacity' }, .15)
                        .from('.hero-showcase', { y: 30, opacity: 0, clearProps: 'transform,opacity' }, .2);
                }
                gsap.timeline({ scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: phone ? .25 : .6 } })
                    .to('.showcase-main', { y: phone ? -22 : -65, rotation: phone ? -3 : -5, ease: 'none' }, 0)
                    .to('.showcase-float', { y: phone ? 25 : 70, x: phone ? 8 : -25, rotation: phone ? 8 : 9, ease: 'none' }, 0);
                document.querySelectorAll('.capability-card').forEach(card => {
                    ScrollTrigger.create({ trigger: card, start: 'top 75%', end: 'bottom 30%', toggleClass: 'is-engaged' });
                });
                gsap.from('.workspace-preview', { y: phone ? 22 : 42, scale: .965, rotation: phone ? 0 : -2,
                    ease: 'none', scrollTrigger: { trigger: '.platform-section', start: 'top 85%', end: 'center 65%', scrub: .45 } });
                gsap.fromTo('.workspace-chart i', { scaleY: .15 }, { scaleY: 1, duration: .8, stagger: .06, ease: 'power2.out', scrollTrigger: { trigger: '.workspace-preview', start: 'top 80%', once: true } });
                gsap.fromTo('.approach-list', { '--route-progress': 0 }, { '--route-progress': 1, ease: 'none',
                    scrollTrigger: { trigger: '.approach-list', start: 'top 60%', end: 'bottom 65%', scrub: .3 } });
                document.querySelectorAll('.approach-list > li').forEach(step => {
                    ScrollTrigger.create({ trigger: step, start: 'top 65%', end: 'bottom 40%', toggleClass: 'is-active' });
                });
            });
        }
        rebuildProjects();
        document.fonts?.ready.then(refresh).catch(() => {});

        return () => {
            stopped = true;
            clearTimeout(refreshTimer);
            if (frame) cancelAnimationFrame(frame);
            previous?.removeEventListener('click', goPrevious);
            next?.removeEventListener('click', goNext);
            gallery.removeEventListener('scroll', queueGallery);
            gallery.removeEventListener('keydown', keyboard);
            window.removeEventListener('resize', queueGallery);
            window.removeEventListener('portfolio:rendered', rebuildProjects);
            window.removeEventListener('portfolio:opened', animateDialog);
            document.removeEventListener('load', imageLoaded, true);
            reduced.removeEventListener('change', clearDialogMotion);
            clearDialogMotion();
            scene?.revert();
            projectScene?.revert();
            readingTrigger?.kill();
            document.body.classList.remove('motion-ready');
        };
    }
    let dispose = () => {};
    const start = () => { dispose(); dispose = createExperience(); };
    document.addEventListener('DOMContentLoaded', start, { once: true });
    window.addEventListener('pagehide', () => dispose());
    window.addEventListener('pageshow', event => { if (event.persisted) start(); });
})();
