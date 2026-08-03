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
import 'preline/plugins/overlay';    /* modal, and the mobile drawer */
import 'preline/plugins/dropdown';   /* header menus, row actions      */
import 'preline/plugins/collapse';
import 'preline/plugins/accordion';  /* foldable navigation groups     */
import 'preline/plugins/tabs';
import 'preline/plugins/tooltip';    /* also backs the popovers        */
import 'preline/plugins/combobox';   /* search over units and channels */
import { animate, stagger, inView } from 'motion';

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
    el.dataset.am2Value = String(target);
    if (from === target) return;
    if (reduced) { el.textContent = target.toLocaleString(); return; }

    animate(from, target, {
        duration: T.entrance,
        ease: EASE.enter,
        onUpdate: (v) => { el.textContent = Math.round(v).toLocaleString(); },
    });
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
function toast(el) {
    move(el, { opacity: [0, 1], y: [12, 0] }, { duration: T.pop, ease: EASE.enter });
}

window.AM2 = {
    enterOnce, countTo, revealOnScroll, filtered, toast,
    prefersReducedMotion, move, T, EASE, STAGGER,
};
