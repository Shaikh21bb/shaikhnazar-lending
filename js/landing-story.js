/* Native touch scrolling and accessible controls also work without GSAP. */
(() => {
    if (window.gsap && window.ScrollTrigger) window.gsap.registerPlugin(window.ScrollTrigger);
    function createMagneticLabel(button, gsap) {
        const label = button.querySelector('span');
        if (!label) return () => {};
        const xTo = gsap.quickTo(label, 'x', { duration: .45, ease: 'power3.out' });
        const yTo = gsap.quickTo(label, 'y', { duration: .45, ease: 'power3.out' });
        const move = event => {
            if (event.pointerType !== 'mouse') return;
            const bounds = button.getBoundingClientRect();
            if (!bounds.width || !bounds.height) return;
            const clamp = value => Math.max(-.5, Math.min(.5, value));
            xTo(clamp((event.clientX - bounds.left) / bounds.width - .5) * 18);
            yTo(clamp((event.clientY - bounds.top) / bounds.height - .5) * 12);
        };
        const reset = () => { xTo(0); yTo(0); };
        button.setAttribute('data-magnetic', '');
        button.addEventListener('pointermove', move, { passive: true });
        ['pointerleave', 'pointercancel', 'blur'].forEach(name => button.addEventListener(name, reset));
        return () => {
            button.removeEventListener('pointermove', move);
            ['pointerleave', 'pointercancel', 'blur'].forEach(name => button.removeEventListener(name, reset));
            button.removeAttribute('data-magnetic');
        };
    }
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
        let desktopRail;
        let idlePaused = false;
        const cards = () => [...gallery.querySelectorAll('.project-card')];

        function updateGallery() {
            frame = 0;
            if (stopped) return;
            const items = cards();
            if (!items.length) return;
            // Measure the visible cards after GSAP renders, including refreshes
            // that restore a tween without running its intermediate callbacks.
            const bounds = (desktopRail?.stage || gallery).getBoundingClientRect();
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
            if (mobile.matches || desktopRail) gallery.setAttribute('aria-roledescription', 'карусель');
            else gallery.removeAttribute('aria-roledescription');
        }
        function queueGallery() {
            if (!frame) frame = requestAnimationFrame(updateGallery);
        }
        function goTo(index) {
            const items = cards();
            const target = items[Math.max(0, Math.min(items.length - 1, index))];
            if (!target || !items[0]) return;
            if (desktopRail) {
                const trigger = desktopRail.tween.scrollTrigger;
                const ratio = Math.min(1, (target.offsetLeft - items[0].offsetLeft) / desktopRail.travel());
                // The rail's scrub supplies the transition; a second native smooth
                // scroll can be interrupted by image/font-triggered pin refreshes.
                window.scrollTo({ top: trigger.start + ratio * (trigger.end - trigger.start), behavior: 'instant' });
                return;
            }
            gallery.scrollTo({ left: target.offsetLeft - items[0].offsetLeft, behavior: reduced.matches ? 'auto' : 'smooth' });
        }
        const goPrevious = () => goTo(activeIndex - 1);
        const goNext = () => goTo(activeIndex + 1);
        const keyboard = event => {
            if ((!mobile.matches && !desktopRail) || event.target !== gallery || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            goTo(event.key === 'Home' ? 0 : event.key === 'End' ? cards().length - 1 : activeIndex + (event.key === 'ArrowRight' ? 1 : -1));
        };
        function refresh() {
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => {
                if (!stopped) { ScrollTrigger?.refresh(true); queueGallery(); }
            }, 120);
        }
        function rebuildProjects() {
            const oldTrigger = desktopRail?.tween.scrollTrigger;
            const restoreProgress = oldTrigger && window.scrollY >= oldTrigger.start && window.scrollY <= oldTrigger.end ? oldTrigger.progress : null;
            projectScene?.revert();
            if (gsap && ScrollTrigger) {
                projectScene = gsap.matchMedia();
                projectScene.add({ desktop: '(min-width: 801px)', pinned: '(min-width: 1024px) and (min-height: 640px)', reduce: '(prefers-reduced-motion: reduce)' }, context => {
                    if (!context.conditions.desktop || context.conditions.reduce) return;
                    const stage = document.querySelector('.projects-stage');
                    const items = cards();
                    if (context.conditions.pinned && stage && items.length > 1) {
                        document.body.classList.add('desktop-portfolio');
                        gallery.scrollLeft = 0;
                        const rail = { stage, travel: () => Math.max(1, gallery.scrollWidth - gallery.clientWidth) };
                        desktopRail = rail;
                        rail.tween = gsap.to(gallery, { x: () => -rail.travel(), ease: 'none', onUpdate: queueGallery,
                            scrollTrigger: { trigger: stage, pin: true, start: 'top top', end: () => `+=${Math.max(1600, window.innerHeight * 3.2)}`,
                                scrub: .65, anticipatePin: 1, invalidateOnRefresh: true, refreshPriority: 1, onRefresh: queueGallery } });
                        const focusCard = event => {
                            const index = items.findIndex(card => card.contains(event.target));
                            if (index >= 0 && index !== activeIndex) goTo(index);
                        };
                        gallery.addEventListener('focusin', focusCard);
                        return () => {
                            gallery.removeEventListener('focusin', focusCard);
                            desktopRail = null;
                            document.body.classList.remove('desktop-portfolio');
                            queueGallery();
                        };
                    }
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
            if (restoreProgress !== null && desktopRail) {
                const trigger = desktopRail.tween.scrollTrigger;
                window.scrollTo({ top: trigger.start + restoreProgress * (trigger.end - trigger.start), behavior: 'instant' });
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
            readingTrigger = ScrollTrigger.create({ start: 0, end: 'max', refreshPriority: -1, onUpdate: self => setReadingProgress(self.progress), onRefresh: self => setReadingProgress(self.progress) });
            scene = gsap.matchMedia();
            scene.add({ mobile: '(max-width: 800px)', desktop: '(min-width: 801px)', pointer: '(hover: hover) and (pointer: fine)', reduce: '(prefers-reduced-motion: reduce)' }, context => {
                if (context.conditions.reduce) return;
                const phone = context.conditions.mobile;
                if (!introPlayed && window.scrollY < 40) {
                    introPlayed = true;
                    const intro = gsap.timeline({ defaults: { ease: 'power3.out', duration: phone ? .85 : 1.25 } })
                        .from('.hero-title-line > span', { yPercent: phone ? 35 : 115, rotation: phone ? 0 : 3, opacity: 0, stagger: phone ? .09 : .13, clearProps: 'transform,opacity' }, 0)
                        .from('.hero-copy .eyebrow, .hero-lead, .hero-actions', { y: 14, opacity: 0, stagger: .08, clearProps: 'transform,opacity' }, .15)
                        .from('.hero-showcase', { y: phone ? 30 : 0, opacity: 0, clearProps: 'transform,opacity' }, .2);
                    if (!phone) intro.from('.showcase-main .showcase-arrival', { x: 90, y: 65, rotation: 12, scale: .8, duration: 1.4 }, .25)
                        .from('.showcase-float .showcase-arrival', { x: -110, y: 110, rotation: -16, scale: .75, duration: 1.5 }, .45);
                }
                gsap.timeline({ scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: phone ? .25 : .6 } })
                    .to('.showcase-main', { y: phone ? -22 : -130, x: phone ? 0 : 75, rotation: phone ? -3 : -10, ease: 'none' }, 0)
                    .to('.showcase-float', { y: phone ? 25 : 100, x: phone ? 8 : -75, rotation: phone ? 8 : 13, ease: 'none' }, 0);
                document.querySelectorAll('.capability-card').forEach(card => {
                    ScrollTrigger.create({ trigger: card, start: 'top 75%', end: 'bottom 30%', toggleClass: 'is-engaged' });
                });
                gsap.from('.workspace-preview', { y: phone ? 22 : 80, x: phone ? 0 : 65, scale: phone ? .965 : .85, rotation: phone ? 0 : 5,
                    ease: 'none', scrollTrigger: { trigger: '.platform-section', start: 'top 85%', end: 'center 65%', scrub: .45 } });
                gsap.fromTo('.workspace-chart i', { scaleY: .15 }, { scaleY: 1, duration: .8, stagger: .06, ease: 'power2.out', scrollTrigger: { trigger: '.workspace-preview', start: 'top 80%', once: true } });
                gsap.fromTo('.approach-list', { '--route-progress': 0 }, { '--route-progress': 1, ease: 'none',
                    scrollTrigger: { trigger: '.approach-list', start: 'top 60%', end: 'bottom 65%', scrub: .3 } });
                document.querySelectorAll('.approach-list > li').forEach(step => {
                    ScrollTrigger.create({ trigger: step, start: 'top 65%', end: 'bottom 40%', toggleClass: 'is-active' });
                });
                if (!phone) {
                    gsap.fromTo('.ribbon-line-one', { x: 0 }, { x: () => -window.innerWidth * .35, ease: 'none',
                        scrollTrigger: { trigger: '.motion-ribbon', start: 'top bottom', end: 'bottom top', scrub: .6, invalidateOnRefresh: true } });
                    gsap.fromTo('.ribbon-line-two', { x: () => -window.innerWidth * .35 }, { x: 0, ease: 'none',
                        scrollTrigger: { trigger: '.motion-ribbon', start: 'top bottom', end: 'bottom top', scrub: .6, invalidateOnRefresh: true } });
                    gsap.to('.ribbon-line i', { rotation: 100, ease: 'none', scrollTrigger: { trigger: '.motion-ribbon', start: 'top bottom', end: 'bottom top', scrub: .6 } });
                    document.querySelectorAll('.approach-list > li').forEach(step => {
                        gsap.timeline({ scrollTrigger: { trigger: step, start: 'top 90%', end: 'top 55%', scrub: .45 } })
                            .fromTo(step.querySelector('div'), { y: 65, rotationX: -32, opacity: .15 }, { y: 0, rotationX: 0, opacity: 1, ease: 'none' }, 0)
                            .fromTo(step.querySelector('span'), { scale: .6, rotation: -35 }, { scale: 1, rotation: 0, ease: 'none' }, 0);
                    });
                    gsap.from('.contact-panel', { y: 65, scale: .94, rotation: -2, duration: 1, ease: 'power3.out', clearProps: 'transform',
                        scrollTrigger: { trigger: '.contact-panel', start: 'top 90%', once: true } });
                    const removeMagnets = context.conditions.pointer
                        ? [...document.querySelectorAll('.button-primary')].map(button => createMagneticLabel(button, gsap)) : [];
                    document.querySelectorAll('.capabilities-section h2, .platform-copy h2, .approach-section h2, .contact-copy h2').forEach(title => {
                        gsap.from(title, { y: 45, clipPath: 'inset(0 0 100% 0)', duration: 1, ease: 'power3.out', clearProps: 'transform,clipPath', scrollTrigger: { trigger: title, start: 'top 90%', once: true } });
                    });
                    document.querySelectorAll('.capability-card').forEach(card => {
                        gsap.from(card.querySelectorAll('.capability-top, h3, p, .tag-list'), { x: 50, opacity: 0, stagger: .1, duration: .8, ease: 'power3.out', clearProps: 'transform,opacity', scrollTrigger: { trigger: card, start: 'top 85%', once: true } });
                    });
                    const showcase = document.querySelector('.hero-showcase');
                    const pauseButton = document.getElementById('hero-motion-toggle');
                    const float = gsap.timeline({ repeat: -1, yoyo: true, defaults: { ease: 'sine.inOut', duration: 4.5 } })
                        .to('.showcase-main .showcase-surface', { y: -22, rotation: 1.4 }, 0)
                        .to('.showcase-float .showcase-surface', { y: 26, rotation: -2 }, 0);
                    const orbit = gsap.to('.showcase-orbit', { rotation: 360, duration: 32, ease: 'none', repeat: -1 });
                    let visible = window.scrollY < (showcase?.offsetHeight || 800);
                    const syncIdle = () => {
                        const paused = idlePaused || !visible || document.hidden;
                        float.paused(paused); orbit.paused(paused);
                        document.body.classList.toggle('ambient-paused', idlePaused || document.hidden);
                    };
                    const toggleIdle = () => { idlePaused = !idlePaused; pauseButton?.setAttribute('aria-pressed', String(idlePaused)); syncIdle(); };
                    pauseButton?.setAttribute('aria-pressed', String(idlePaused));
                    pauseButton?.addEventListener('click', toggleIdle);
                    document.addEventListener('visibilitychange', syncIdle);
                    ScrollTrigger.create({ trigger: '.hero', start: 'top bottom', end: 'bottom top', onToggle: self => { visible = self.isActive; syncIdle(); } });
                    syncIdle();
                    const tiltX = showcase && gsap.quickTo(showcase, 'rotationX', { duration: .8, ease: 'power3.out' });
                    const tiltY = showcase && gsap.quickTo(showcase, 'rotationY', { duration: .8, ease: 'power3.out' });
                    const pointer = event => {
                        if (event.pointerType !== 'mouse') return;
                        const bounds = showcase.getBoundingClientRect();
                        tiltX((.5 - (event.clientY - bounds.top) / bounds.height) * 10);
                        tiltY(((event.clientX - bounds.left) / bounds.width - .5) * 14);
                    };
                    const resetTilt = () => { tiltX?.(0); tiltY?.(0); };
                    showcase?.addEventListener('pointermove', pointer, { passive: true });
                    showcase?.addEventListener('pointerleave', resetTilt);
                    return () => {
                        removeMagnets.forEach(remove => remove());
                        document.body.classList.remove('ambient-paused');
                        pauseButton?.removeEventListener('click', toggleIdle);
                        document.removeEventListener('visibilitychange', syncIdle);
                        showcase?.removeEventListener('pointermove', pointer);
                        showcase?.removeEventListener('pointerleave', resetTilt);
                    };
                }
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
