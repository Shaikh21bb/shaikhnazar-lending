(() => {
    function initClientGlass() {
        const page = document.querySelector('.client-page');
        if (!page) return;
        const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
        const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
        const island = document.querySelector('.client-island');
        let pointerFrame = 0;
        let pointerPosition;

        const resetPointer = () => {
            if (pointerFrame) cancelAnimationFrame(pointerFrame);
            pointerFrame = 0;
            pointerPosition = undefined;
            page.style.removeProperty('--client-pointer-x');
            page.style.removeProperty('--client-pointer-y');
        };
        window.addEventListener('pointermove', event => {
            if (motionPreference.matches || !finePointer.matches || event.pointerType === 'touch') return;
            pointerPosition = { x: event.clientX, y: event.clientY };
            if (pointerFrame) return;
            pointerFrame = requestAnimationFrame(() => {
                pointerFrame = 0;
                if (!pointerPosition || motionPreference.matches || !finePointer.matches) return;
                page.style.setProperty('--client-pointer-x', `${pointerPosition.x}px`);
                page.style.setProperty('--client-pointer-y', `${pointerPosition.y}px`);
            });
        }, { passive: true });

        const updateScroll = () => island?.classList.toggle('is-compact', window.scrollY > 24);
        window.addEventListener('scroll', updateScroll, { passive: true });
        updateScroll();

        const viewport = window.visualViewport;
        let previousViewportHeight = viewport?.height || window.innerHeight;
        let previousViewportWidth = window.innerWidth;
        let editViewportHeight = 0;
        const updateViewport = () => {
            const height = viewport?.height || window.innerHeight;
            page.style.setProperty('--client-visible-height', `${Math.round(height)}px`);
            const keyboardOffset = Math.max(0, window.innerHeight - height - (viewport?.offsetTop || 0));
            page.style.setProperty('--client-keyboard-offset', `${Math.round(keyboardOffset)}px`);
            const editable = document.activeElement?.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea, [contenteditable="true"]');
            if (Math.abs(window.innerWidth - previousViewportWidth) > 80) editViewportHeight = 0;
            if (editable && !editViewportHeight) editViewportHeight = Math.max(previousViewportHeight, height);
            if (!editable) editViewportHeight = 0;
            const coveredHeight = Math.max(window.innerHeight - height, editViewportHeight - height);
            page.classList.toggle('is-keyboard-open', Boolean(editable && coveredHeight > 160));
            previousViewportHeight = height;
            previousViewportWidth = window.innerWidth;
        };
        viewport?.addEventListener('resize', updateViewport, { passive: true });
        viewport?.addEventListener('scroll', updateViewport, { passive: true });
        window.addEventListener('resize', updateViewport, { passive: true });
        page.addEventListener('focusin', updateViewport);
        page.addEventListener('focusout', () => requestAnimationFrame(updateViewport));
        updateViewport();

        let observer;
        if ('IntersectionObserver' in window && !motionPreference.matches) {
            observer = new IntersectionObserver(entries => {
                entries.forEach(entry => {
                    if (!entry.isIntersecting) return;
                    entry.target.classList.add('glass-in-view');
                    observer.unobserve(entry.target);
                });
            }, { threshold: 0.08 });
            page.querySelectorAll('[data-glass-reveal]').forEach(element => observer.observe(element));
        }
        motionPreference.addEventListener('change', () => {
            resetPointer();
            if (motionPreference.matches) observer?.disconnect();
        });
        finePointer.addEventListener('change', resetPointer);
        window.addEventListener('blur', resetPointer);
        document.addEventListener('visibilitychange', () => {
            page.classList.toggle('motion-paused', document.hidden);
            if (document.hidden) resetPointer();
        });
        requestAnimationFrame(() => page.classList.add('client-ready'));
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initClientGlass, { once: true });
    else initClientGlass();
})();
