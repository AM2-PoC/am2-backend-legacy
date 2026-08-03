/**
 * AM2 panel runtime.
 *
 * Three owners, and nothing has two:
 *
 *   Preline  — component state and lifecycle. Which overlay is open, where
 *              focus is, whether the body scrolls. We never set those.
 *   Motion   — what the change looks like. Never what is visible: an element
 *              hidden by an animation that failed to run is an element the
 *              operator cannot reach.
 *   Vanilla  — fetch and the business state the pages already had.
 *
 * Every animate() below runs on an element Preline has already made visible,
 * so a thrown animation leaves a usable page rather than a blank one.
 */
/* Only the plugins this panel uses. The barrel export pulls in the datatable,
 * the datepicker, the carousel and the range slider as well, which is 449kB of
 * behaviour for a console that has none of those. */
/*
 * One import per plugin the markup actually uses, and no others. collapse,
 * tabs, tooltip and combobox were imported for pages that have not been built
 * yet, and every page paid for them on first load. ui-runtime.test.mjs reads
 * the hs-* attributes out of the markup and fails if an import is missing, so
 * adding one back is a line and forgetting one is a red test.
 */
import 'preline/plugins/overlay';          /* modal, and the mobile drawer  */
import 'preline/plugins/dropdown';         /* header menus, row actions     */
import 'preline/plugins/accordion';        /* foldable navigation groups    */
import 'preline/plugins/toggle-password';  /* login, and the password card  */
import { animate, stagger, inView } from 'motion';
import qrcode from 'qrcode-generator';
import { initTables } from './am2-table.js';

/* Durations, in seconds because that is what Motion takes. Graded by how far
 * a thing travels: a colour change is over before it is noticed, a drawer
 * crossing the viewport has earned the time. */
const T = {
    micro: 0.14,
    pop: 0.16,
    modal: 0.18,
    drawer: 0.22,
    entrance: 0.2,
    exit: 0.12,
};

/* Entering decelerates hard, so a panel arrives rather than slides. Leaving
 * accelerates away, because waiting for something to go is waiting. */
const EASE = {
    enter: [0.16, 1, 0.3, 1],
    exit: [0.4, 0, 1, 1],
};

const STAGGER = 0.035;

const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let reduced = reduceQuery.matches;
reduceQuery.addEventListener('change', (e) => { reduced = e.matches; });

export const prefersReducedMotion = () => reduced;

/**
 * animate(), except that under reduced motion it applies the final frame and
 * returns. Not "a shorter animation" -- no transform, no stagger, no loop, and
 * the element is at its end state on the next paint.
 */
function move(el, keyframes, options = {}) {
    if (!el) return null;
    if (reduced) {
        const final = {};
        for (const [prop, frames] of Object.entries(keyframes)) {
            final[prop] = Array.isArray(frames) ? frames[frames.length - 1] : frames;
        }
        // Colour and opacity still land; only travel is dropped.
        delete final.transform;
        if (final.y !== undefined) delete final.y;
        if (final.x !== undefined) delete final.x;
        if (final.scale !== undefined) delete final.scale;
        Object.assign(el.style, styleable(final));
        return null;
    }
    try {
        return animate(el, keyframes, options);
    } catch {
        // A missing element or an unsupported property must not take the page
        // down with it -- the component is already open either way.
        return null;
    }
}

function styleable(obj) {
    const out = {};
    if (obj.opacity !== undefined) out.opacity = String(obj.opacity);
    return out;
}

/* ------------------------------------------------------------------ *
 * Overlays: modal, offcanvas drawer.
 *
 * Preline decides open and closed. We colour in the transition either side of
 * its decision: the scrim only fades, because a backdrop that travels pulls
 * the eye off the thing it exists to isolate, and the panel travels because
 * that small movement is what says it came from somewhere.
 * ------------------------------------------------------------------ */

function panelOf(overlay) {
    return overlay.querySelector('[data-am2-panel]') || overlay.firstElementChild;
}

function isDrawer(overlay) {
    return overlay.hasAttribute('data-am2-drawer');
}

document.addEventListener('open.hs.overlay', (e) => {
    const overlay = e.detail?.el || e.target;
    if (!(overlay instanceof HTMLElement)) return;

    move(overlay, { opacity: [0, 1] }, { duration: T.modal, ease: EASE.enter });

    const panel = panelOf(overlay);
    if (!panel) return;

    if (isDrawer(overlay)) {
        move(panel, { x: ['-100%', '0%'] }, { duration: T.drawer, ease: EASE.enter });
    } else {
        move(panel, { opacity: [0, 1], y: [8, 0], scale: [0.99, 1] },
            { duration: T.modal, ease: EASE.enter });
    }
});

document.addEventListener('close.hs.overlay', (e) => {
    const overlay = e.detail?.el || e.target;
    if (!(overlay instanceof HTMLElement)) return;
    const panel = panelOf(overlay);
    if (!panel) return;

    // Preline owns the hide, so this is a shorter exit that reads as leaving
    // rather than a promise to finish before the element goes.
    if (isDrawer(overlay)) {
        move(panel, { x: ['0%', '-100%'] }, { duration: T.exit, ease: EASE.exit });
    } else {
        move(panel, { opacity: [1, 0], y: [0, 8] }, { duration: T.exit, ease: EASE.exit });
    }
});

/* Dropdowns and the search popover: opacity and a little travel, no bounce. */
document.addEventListener('open.hs.dropdown', (e) => {
    const menu = e.detail?.menu;
    move(menu, { opacity: [0, 1], y: [-4, 0] }, { duration: T.pop, ease: EASE.enter });
});

/* ------------------------------------------------------------------ *
 * Things the pages call.
 * ------------------------------------------------------------------ */

/**
 * Card entrance, once. Polling re-renders the numbers inside these cards
 * several times a minute; replaying the entrance each time would make the
 * dashboard flicker on a timer.
 */
function enterOnce(selector, container = document) {
    const els = [...container.querySelectorAll(selector)].filter(
        (el) => !el.dataset.am2Entered
    );
    if (!els.length) return;
    els.forEach((el) => { el.dataset.am2Entered = '1'; });

    if (reduced) {
        els.forEach((el) => { el.style.opacity = '1'; });
        return;
    }
    animate(els, { opacity: [0, 1], y: [10, 0] },
        { duration: T.entrance, ease: EASE.enter, delay: stagger(STAGGER) });
}

/**
 * Count a metric up to its value. Only on the first meaningful render or when
 * the number actually changes -- a figure that re-counts on every poll reads
 * as activity that is not happening.
 */
function countTo(el, value) {
    if (!el) return;
    const target = Number(value);
    if (!Number.isFinite(target)) { el.textContent = String(value); return; }

    const from = Number(el.dataset.am2Value ?? 0);
    const first = el.dataset.am2Value === undefined;
    el.dataset.am2Value = String(target);
    if (from === target) {
        // Still write it. On the first pass the element holds a placeholder,
        // and a genuine zero equals the assumed starting value -- so returning
        // here left "–" on screen for every count that really was zero.
        if (first) el.textContent = target.toLocaleString();
        return;
    }
    if (reduced) { el.textContent = target.toLocaleString(); return; }

    animate(from, target, {
        duration: T.entrance,
        ease: EASE.enter,
        onUpdate: (v) => { el.textContent = Math.round(v).toLocaleString(); },
    });
}

/**
 * A QR code, as an SVG element.
 *
 * The console hands a phone to an officer in the field; the officer scans and
 * installs. Type 0 lets the encoder choose the smallest version that fits, and
 * correction level M survives a photograph of a screen at an angle.
 *
 * Built as DOM rather than a markup string: the only thing interpolated is a
 * path of numbers, but the rule in this codebase is that markup is not
 * assembled from data, and an exception is how the rule stops holding.
 */
function qr(text, size = 120) {
    const code = qrcode(0, 'M');
    code.addData(String(text));
    code.make();

    const n = code.getModuleCount();
    const cell = size / n;
    let d = '';
    for (let r = 0; r < n; r += 1) {
        for (let c = 0; c < n; c += 1) {
            if (!code.isDark(r, c)) continue;
            const x = (c * cell).toFixed(2);
            const y = (r * cell).toFixed(2);
            d += `M${x} ${y}h${cell.toFixed(2)}v${cell.toFixed(2)}h-${cell.toFixed(2)}z`;
        }
    }

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('role', 'img');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
}

/** Reveal below the fold, once, for the long lower half of the dashboard. */
function revealOnScroll(selector) {
    if (reduced) {
        document.querySelectorAll(selector).forEach((el) => { el.style.opacity = '1'; });
        return;
    }
    document.querySelectorAll(selector).forEach((el) => {
        el.style.opacity = '0';
        inView(el, () => {
            animate(el, { opacity: [0, 1], y: [12, 0] },
                { duration: T.entrance, ease: EASE.enter });
        }, { amount: 0.2 });
    });
}

/**
 * A filtered table says the set changed without redrawing every row: the body
 * dips and comes back. Row-level animation is deliberately not done here --
 * animating each row on every refresh is what makes a live table unreadable.
 */
function filtered(tbody) {
    move(tbody, { opacity: [0.45, 1] }, { duration: T.micro, ease: EASE.enter });
}

/** Toast in from the edge, out faster. */
/**
 * Say what just happened.
 *
 * This used to take an element and animate it, which meant every call that
 * passed a sentence -- every save, every refusal, every bulk result -- did
 * nothing at all. Silently: the string was treated as an element, and animating
 * a string is a no-op. Elements are still accepted so the pages that hand it
 * one keep working.
 */
function toastRoot() {
    let root = document.getElementById('am2-toasts');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'am2-toasts';
    // Above the bulk bar, clear of the safe area, and never in the way of a
    // thumb: bottom centre on a phone, bottom right on a desk.
    root.className = 'pointer-events-none fixed inset-x-0 bottom-20 z-90 flex flex-col '
        + 'items-center gap-2 px-4 sm:inset-x-auto sm:end-6 sm:bottom-6 sm:items-end';
    root.setAttribute('aria-live', 'polite');
    document.body.appendChild(root);
    return root;
}

function toast(what, ok = true) {
    if (what instanceof Element) {
        move(what, { opacity: [0, 1], y: [12, 0] }, { duration: T.pop, ease: EASE.enter });
        return;
    }

    const text = String(what ?? '').trim();
    if (!text) return;

    const el = document.createElement('div');
    el.setAttribute('role', ok ? 'status' : 'alert');
    // Theme comes from the tokens, so light and dark need no second rule.
    el.className = 'pointer-events-auto flex max-w-[min(92vw,26rem)] items-start gap-2.5 '
        + 'rounded-control border bg-card px-3.5 py-2.5 text-sm text-ink shadow-panel '
        + (ok ? 'border-ok/40 border-s-2 border-s-ok' : 'border-bad/40 border-s-2 border-s-bad');

    const mark = document.createElement('span');
    mark.className = 'mt-px shrink-0 font-mono text-xs ' + (ok ? 'text-ok' : 'text-bad');
    mark.textContent = ok ? '✓' : '✕';
    mark.setAttribute('aria-hidden', 'true');

    const body = document.createElement('span');
    body.className = 'min-w-0 flex-1';
    // textContent: the message can carry a database error, which is text.
    body.textContent = text;

    el.append(mark, body);
    toastRoot().appendChild(el);

    if (reduced) {
        setTimeout(() => el.remove(), 4200);
        return;
    }
    animate(el, { opacity: [0, 1], y: [10, 0] }, { duration: T.pop, ease: EASE.enter });
    setTimeout(() => {
        animate(el, { opacity: 0, y: 6 }, { duration: T.exit, ease: EASE.exit })
            .finished.then(() => el.remove());
    }, 4000);
}

/**
 * The rings leaving the login mark. Motion owns this outright rather than
 * sharing it with a CSS keyframe, so reduced motion is a branch here instead
 * of a media query trying to cancel an animation mid-flight.
 *
 * It is the one looping animation on that page, and it depicts the product:
 * a signal leaving a transmitter.
 */
function emit(selector) {
    const rings = [...document.querySelectorAll(selector)];
    if (!rings.length || reduced) {
        // Under reduced motion the rings simply are not there. A static ring
        // would read as a border nobody asked for.
        rings.forEach((el) => { el.style.display = 'none'; });
        return;
    }
    rings.forEach((el, i) => {
        animate(el,
            { transform: ['scale(1)', 'scale(3.4)'], opacity: [0.55, 0.06, 0] },
            { duration: 4.8, ease: 'easeOut', repeat: Infinity, delay: i * 1.6 });
    });
}

/*
 * Tables wire themselves. A page supplies markup and data attributes and
 * writes no JavaScript at all, so the three roster pages cannot drift apart
 * by each growing its own copy of selection or of a toggle.
 */
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initTables(), { once: true });
} else {
    initTables();
}

window.AM2 = {
    enterOnce, countTo, revealOnScroll, filtered, toast, emit, qr, initTables,
    prefersReducedMotion, move, T, EASE, STAGGER,
};
