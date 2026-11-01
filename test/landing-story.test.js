import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const motionSource = await readFile(new URL('../js/landing-story.js', import.meta.url), 'utf8');
const mainSource = await readFile(new URL('../js/main.js', import.meta.url), 'utf8');
class Surface {
    constructor() {
        this.events = new Map(); this.dataset = {}; this.attributes = {}; this.textContent = ''; this.style = {};
        const classes = new Set();
        this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
            toggle: (name, force) => { const next = force ?? !classes.has(name); next ? classes.add(name) : classes.delete(name); return next; } };
    }
    addEventListener(name, fn) { const listeners = this.events.get(name) || new Set(); listeners.add(fn); this.events.set(name, listeners); }
    removeEventListener(name, fn) { this.events.get(name)?.delete(fn); }
    dispatchEvent(event) { for (const fn of this.events.get(event.type) || []) fn({ target: this, ...event }); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 360, height: 60 }; }
}
function fixture({ reduced = false, withGsap = false, desktop = false, finePointer = desktop, magnetic = false } = {}) {
    const window = new Surface(); const document = new Surface();
    document.body = new Surface(); document.documentElement = { lang: 'ru' };
    const elements = Object.fromEntries(['project-grid','project-previous','project-next','project-position','project-scroll-progress','menu-toggle','mobile-menu','site-header','project-dialog'].map(id => [id, new Surface()]));
    const magneticButton = new Surface(); const magneticLabel = new Surface(); const quickMoves = [];
    magneticButton.querySelector = selector => selector === 'span' ? magneticLabel : null;
    document.querySelectorAll = selector => magnetic && selector === '.button-primary' ? [magneticButton] : [];
    document.getElementById = id => elements[id] || null;
    const gallery = elements['project-grid']; gallery.clientWidth = 360;
    let left = 0; let items;
    const makeCards = () => Array.from({ length: 6 }, (_, index) => {
        const card = new Surface(); card.offsetLeft = 16 + 316 * index; card.offsetWidth = 300; card.contains = target => target === card;
        card.media = new Surface(); card.image = new Surface();
        card.querySelector = selector => selector === '.project-media' ? card.media : selector === '.project-media img' ? card.image : null;
        card.getBoundingClientRect = () => ({ left: card.offsetLeft - gallery.scrollLeft, width: 300 }); return card;
    });
    items = makeCards(); gallery.querySelectorAll = () => items;
    Object.defineProperty(gallery, 'scrollLeft', { get: () => left, set: value => { left = Math.max(0, Math.min(1552, value)); } });
    gallery.scrollWidth = 1912;
    const scrolls = [];
    gallery.scrollTo = options => { scrolls.push(options); gallery.scrollLeft = options.left; gallery.dispatchEvent({ type: 'scroll' }); };
    const frames = new Map(); const timers = new Map(); let sequence = 0;
    const flush = () => { for (const [id, fn] of frames) { frames.delete(id); fn(); } };
    const flushTimers = () => { for (const [id, fn] of timers) { timers.delete(id); fn(); } };
    const refreshModes = [];
    const media = query => Object.assign(new Surface(), { media: query, matches: query.includes('prefers-reduced-motion') ? reduced : query.includes('max-width') ? !desktop : desktop });
    window.matchMedia = media; window.scrollY = 0; window.innerHeight = 720;
    const animations = [];
    const pageScrolls = [];
    window.scrollTo = options => {
        pageScrolls.push(options); window.scrollY = options.top;
    };
    if (withGsap) {
        const forbiddenMotion = () => { throw new Error('Reduced motion must not create a tween'); };
        const tween = () => { const t = { from: () => t, to: () => t, paused: () => t }; return t; };
        window.gsap = { registerPlugin() {}, quickSetter: () => () => {}, timeline: forbiddenMotion, from: forbiddenMotion, fromTo: forbiddenMotion, set() {},
            matchMedia: () => {
                let cleanup;
                return { add: (condition, fn) => { if (typeof condition === 'object') cleanup = fn({ conditions: { mobile: !desktop, desktop, pointer: finePointer, reduce: reduced } }); }, revert: () => cleanup?.() };
            } };
        if (desktop && !reduced) Object.assign(window.gsap, {
            timeline: tween, from: tween, to: tween,
            fromTo: (target, from, to) => { animations.push({ target, from, to }); return tween(); },
            quickTo: (target, property) => value => quickMoves.push({ target, property, value })
        });
        window.ScrollTrigger = { config() {}, create: () => ({ kill() {} }), refresh: safe => refreshModes.push(safe) };
    }
    const context = vm.createContext({ window, document, matchMedia: media, console,
        requestAnimationFrame: fn => { const id = ++sequence; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
        setTimeout: fn => { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
        localStorage: { getItem() { throw new Error('Storage blocked'); }, setItem() { throw new Error('Storage blocked'); } },
        CustomEvent: class { constructor(type) { this.type = type; } }
    });
    return { context, window, document, elements, gallery, scrolls, pageScrolls, animations, flush, flushTimers, refreshModes, magneticButton, magneticLabel, quickMoves, cards: () => items, replaceCards: () => { items = makeCards(); } };
}

test('native project navigation survives unavailable animation libraries and supports keyboard boundaries', () => {
    const f = fixture(); vm.runInContext(motionSource, f.context);
    f.document.dispatchEvent({ type: 'DOMContentLoaded' }); f.flush();
    assert.equal(f.elements['project-position'].textContent, '01 / 06');
    f.elements['project-next'].dispatchEvent({ type: 'click' }); f.flush();
    assert.equal(f.elements['project-position'].textContent, '02 / 06');
    assert.equal(f.elements['project-previous'].disabled, false);
    let prevented = false;
    f.gallery.dispatchEvent({ type: 'keydown', key: 'End', preventDefault: () => { prevented = true; } }); f.flush();
    assert.equal(prevented, true); assert.equal(f.elements['project-position'].textContent, '06 / 06');
    assert.equal(f.elements['project-next'].disabled, true);
    f.window.dispatchEvent({ type: 'pagehide' });
});

test('reduced motion keeps carousel movement instant and skips scene tweens', () => {
    const f = fixture({ reduced: true, withGsap: true }); vm.runInContext(motionSource, f.context);
    f.document.dispatchEvent({ type: 'DOMContentLoaded' }); f.flush();
    f.elements['project-next'].dispatchEvent({ type: 'click' }); f.flush();
    assert.equal(f.scrolls[0].behavior, 'auto');
    assert.equal(f.elements['project-position'].textContent, '02 / 06');
    f.window.dispatchEvent({ type: 'portfolio:opened' });
    f.window.dispatchEvent({ type: 'pagehide' });
});

test('language rerender and bfcache restore retain usable navigation without duplicate listeners', () => {
    const f = fixture(); vm.runInContext(motionSource, f.context);
    f.document.dispatchEvent({ type: 'DOMContentLoaded' }); f.flush();
    f.elements['project-next'].dispatchEvent({ type: 'click' }); f.flush();
    f.gallery.scrollLeft = 0; f.replaceCards(); f.window.dispatchEvent({ type: 'portfolio:rendered' }); f.flush();
    assert.equal(f.elements['project-position'].textContent, '02 / 06');
    f.window.dispatchEvent({ type: 'pagehide' });
    assert.equal(f.elements['project-next'].events.get('click').size, 0);
    f.window.dispatchEvent({ type: 'pageshow', persisted: true }); f.flush();
    assert.equal(f.elements['project-next'].events.get('click').size, 1);
    f.elements['project-next'].dispatchEvent({ type: 'click' }); f.flush();
    assert.equal(f.elements['project-position'].textContent, '03 / 06');
    f.window.dispatchEvent({ type: 'pagehide' });
});

test('blocked browser storage does not prevent the landing or language switch from working', () => {
    const f = fixture();
    const ru = new Surface(); ru.dataset.lang = 'ru';
    const kk = new Surface(); kk.dataset.lang = 'kk';
    const headline = new Surface(); headline.dataset.i18n = 'hero.title1';
    f.document.querySelectorAll = selector => selector === '[data-lang]' ? [ru, kk] : selector === '[data-i18n]' ? [headline] : [];
    vm.runInContext(mainSource, f.context); f.document.dispatchEvent({ type: 'DOMContentLoaded' });
    assert.equal(f.document.documentElement.lang, 'ru');
    assert.equal(headline.textContent, 'Сайты и AI.');
    kk.dispatchEvent({ type: 'click' });
    assert.equal(f.document.documentElement.lang, 'kk');
    assert.equal(headline.textContent, 'Сайттар мен AI.');
});

test('desktop previews animate in normal document flow without pinning, rail translation or scroll interception', () => {
    const f = fixture({ desktop: true, withGsap: true }); vm.runInContext(motionSource, f.context);
    f.document.dispatchEvent({ type: 'DOMContentLoaded' }); f.flush();
    assert.ok(f.cards().every(card => f.animations.some(animation => animation.target === card.media)));
    assert.ok(f.animations.every(animation => !animation.to.scrollTrigger?.pin));
    assert.ok(f.animations.every(animation => animation.target !== f.gallery));
    f.elements['project-next'].dispatchEvent({ type: 'click' }); f.flush();
    let prevented = false;
    f.gallery.dispatchEvent({ type: 'keydown', key: 'End', preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(f.scrolls.length, 0);
    f.window.scrollY = 2400;
    f.replaceCards(); f.window.dispatchEvent({ type: 'portfolio:rendered' }); f.flush();
    assert.equal(f.window.scrollY, 2400);
    assert.equal(f.pageScrolls.length, 0);
    assert.ok(f.cards().every(card => f.animations.some(animation => animation.target === card.media)));
    assert.equal(f.gallery.events.has('focusin'), false);
    f.window.dispatchEvent({ type: 'pagehide' });
});

test('desktop reduced-motion preference keeps all projects in the static grid', () => {
    const f = fixture({ desktop: true, reduced: true, withGsap: true }); vm.runInContext(motionSource, f.context);
    f.document.dispatchEvent({ type: 'DOMContentLoaded' }); f.flush();
    assert.equal(f.animations.length, 0);
    assert.equal(f.pageScrolls.length, 0);
    f.window.dispatchEvent({ type: 'pagehide' });
});

test('mouse attraction is bounded to the inner label and resets and removes its listeners', () => {
    const f = fixture({ desktop: true, withGsap: true, magnetic: true }); vm.runInContext(motionSource, f.context);
    f.document.dispatchEvent({ type: 'DOMContentLoaded' });
    assert.equal(f.magneticButton.attributes['data-magnetic'], '');
    f.magneticButton.dispatchEvent({ type: 'pointermove', pointerType: 'touch', clientX: 360, clientY: 60 });
    assert.equal(f.quickMoves.length, 0);
    f.magneticButton.dispatchEvent({ type: 'pointermove', pointerType: 'mouse', clientX: 900, clientY: 100 });
    assert.deepEqual(f.quickMoves.map(move => [move.property, move.value]), [['x', 9], ['y', 6]]);
    assert.ok(f.quickMoves.every(move => move.target === f.magneticLabel), 'the link hit area stays fixed');
    f.magneticButton.dispatchEvent({ type: 'blur' });
    assert.deepEqual(f.quickMoves.slice(-2).map(move => move.value), [0, 0]);
    f.window.dispatchEvent({ type: 'pagehide' });
    assert.equal(f.magneticButton.events.get('pointermove').size, 0);
    assert.equal(f.magneticButton.events.get('blur').size, 0);
    assert.equal(f.magneticButton.attributes['data-magnetic'], undefined);
});

test('coarse pointer and reduced motion do not install magnetic label handlers', () => {
    for (const preferences of [{ finePointer: false }, { reduced: true }]) {
        const f = fixture({ desktop: true, withGsap: true, magnetic: true, ...preferences }); vm.runInContext(motionSource, f.context);
        f.document.dispatchEvent({ type: 'DOMContentLoaded' });
        assert.equal(f.magneticButton.attributes['data-magnetic'], undefined);
        assert.equal(f.magneticButton.events.has('pointermove'), false);
        f.window.dispatchEvent({ type: 'pagehide' });
    }
});

test('layout refresh requests use the safe deferred mode without interrupting navigation', () => {
    const f = fixture({ withGsap: true, reduced: true }); vm.runInContext(motionSource, f.context);
    f.document.dispatchEvent({ type: 'DOMContentLoaded' });
    f.window.dispatchEvent({ type: 'portfolio:rendered' });
    f.flushTimers();
    assert.deepEqual(f.refreshModes, [true]);
    f.window.dispatchEvent({ type: 'pagehide' });
    f.flushTimers();
    assert.deepEqual(f.refreshModes, [true], 'disposed pages must not request another refresh');
});
