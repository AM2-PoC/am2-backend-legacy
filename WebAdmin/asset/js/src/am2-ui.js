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

import 'preline/plugins/overlay';          /* modal, and the mobile drawer  */
import 'preline/plugins/dropdown';         /* header menus, row actions     */
import 'preline/plugins/accordion';        /* foldable navigation groups    */
import 'preline/plugins/toggle-password';  /* login, and the password card  */
import { animate, stagger, inView } from 'motion';
import qrcode from 'qrcode-generator';
import { initTables } from './am2-table.js';
import { playExit, watchOverlays } from './am2-exit.js';

const T = {
    micro: 0.14,
    pop: 0.16,
    modal: 0.18,
    drawer: 0.22,
    entrance: 0.2,
    exit: 0.12,
};

const EASE = {
    enter: [0.16, 1, 0.3, 1],
    exit: [0.4, 0, 1, 1],
};

const STAGGER = 0.035;

const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let reduced = reduceQuery.matches;
reduceQuery.addEventListener('change', (e) => { reduced = e.matches; });

export const prefersReducedMotion = () => reduced;

function move(el, keyframes, options = {}) {
    if (!el) return null;
    if (reduced) {
        const final = {};
        for (const [prop, frames] of Object.entries(keyframes)) {
            final[prop] = Array.isArray(frames) ? frames[frames.length - 1] : frames;
        }

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

        return null;
    }
}

function styleable(obj) {
    const out = {};
    if (obj.opacity !== undefined) out.opacity = String(obj.opacity);
    return out;
}


document.addEventListener('open.hs.dropdown', (e) => {
    const menu = e.detail?.menu;
    move(menu, { opacity: [0, 1], y: [-4, 0] }, { duration: T.pop, ease: EASE.enter });
});


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

function countTo(el, value) {
    if (!el) return;
    const target = Number(value);
    if (!Number.isFinite(target)) { el.textContent = String(value); return; }

    const from = Number(el.dataset.am2Value ?? 0);
    const first = el.dataset.am2Value === undefined;
    el.dataset.am2Value = String(target);
    if (from === target) {

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

function revealOnScroll(selector) {

    clearTimeout(window.__am2RevealFallback);

    if (reduced) {
        document.querySelectorAll(selector).forEach((el) => { el.style.opacity = '1'; });
        return;
    }
    document.querySelectorAll(selector).forEach((el) => {
        inView(el, () => {
            animate(el, { opacity: [0, 1], y: [12, 0] },
                { duration: T.entrance, ease: EASE.enter });
        }, { amount: 0.2 });
    });
}

function filtered(tbody) {
    move(tbody, { opacity: [0.45, 1] }, { duration: T.micro, ease: EASE.enter });
}


function toastRoot() {
    let root = document.getElementById('am2-toasts');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'am2-toasts';

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

    el.className = 'pointer-events-auto flex max-w-[min(92vw,26rem)] items-start gap-2.5 '
        + 'rounded-control border bg-card px-3.5 py-2.5 text-sm text-ink shadow-panel '
        + (ok ? 'border-ok/40 border-s-2 border-s-ok' : 'border-bad/40 border-s-2 border-s-bad');

    const mark = document.createElement('span');
    mark.className = 'mt-px shrink-0 font-mono text-xs ' + (ok ? 'text-ok' : 'text-bad');
    mark.textContent = ok ? '✓' : '✕';
    mark.setAttribute('aria-hidden', 'true');

    const body = document.createElement('span');
    body.className = 'min-w-0 flex-1';

    body.textContent = text;

    el.append(mark, body);

    if (!ok) {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'ms-1 shrink-0 rounded px-1 font-mono text-xs text-ink-subtle '
            + 'transition-colors hover:text-ink focus:outline-none focus-visible:ring-2 '
            + 'focus-visible:ring-bad/60';
        close.textContent = '\u00d7';
        close.setAttribute('aria-label', toastRoot().dataset.dismiss || 'Dismiss');
        close.addEventListener('click', () => dismiss(el));
        el.append(close);
    }

    toastRoot().appendChild(el);

    if (reduced) {
        if (ok) setTimeout(() => el.remove(), 4200);
        return;
    }
    animate(el, { opacity: [0, 1], y: [10, 0] }, { duration: T.pop, ease: EASE.enter });
    if (ok) dismissAfter(el, 4000);
}

function dismiss(el) {
    if (el.dataset.leaving) return;
    el.dataset.leaving = '1';
    if (reduced) { el.remove(); return; }
    animate(el, { opacity: 0, y: 6 }, { duration: T.exit, ease: EASE.exit })
        .finished.then(() => el.remove());
}

function dismissAfter(el, ms) {
    setTimeout(() => dismiss(el), ms);
}

/**
 * Hand a message to the page that is about to replace this one.
 *
 * A toast raised immediately before `location.reload()` is destroyed by the
 * reload -- the bulk actions raised one and reloaded 900ms later, so the only
 * confirmation an operator got for the commonest write in the console was a
 * flash lasting under a quarter of the time it was built to stand. Stashing it
 * means the reload can stay as quick as it likes and the message is still read.
 *
 * sessionStorage rather than a query parameter: the message never enters a URL
 * that could be copied, shared or replayed, and it is gone once shown.
 */
const HANDOFF = 'am2:notice';

function handoff(text, ok = true) {
    try {
        sessionStorage.setItem(HANDOFF, JSON.stringify({ text: String(text ?? ''), ok: !!ok }));
    } catch {

    }
}

function drainNotices() {
    try {
        const held = sessionStorage.getItem(HANDOFF);
        if (held) {
            sessionStorage.removeItem(HANDOFF);
            const { text, ok } = JSON.parse(held);
            if (text) toast(text, ok);
        }
    } catch {

    }

    document.querySelectorAll('[data-notice]').forEach((el) => {
        const text = el.textContent.trim();
        el.remove();
        if (text) toast(text, el.dataset.notice !== 'bad');
    });
}

function emit(selector) {
    const rings = [...document.querySelectorAll(selector)];
    if (!rings.length || reduced) {

        rings.forEach((el) => { el.style.display = 'none'; });
        return;
    }
    rings.forEach((el, i) => {
        animate(el,
            { transform: ['scale(1)', 'scale(3.4)'], opacity: [0.55, 0.06, 0] },
            { duration: 4.8, ease: 'easeOut', repeat: Infinity, delay: i * 1.6 });
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initTables(), { once: true });
} else {
    initTables();
}

/*
 * The page transition, named only while one is happening.
 *
 * view-transition-name creates a stacking context wherever it sits. Carried
 * permanently, <main> became one -- and every dialogue in this panel is markup
 * inside <main> while Preline builds its backdrop under <body>, so the
 * overlay's z-80 stopped being comparable to the backdrop's z-79. The backdrop
 * covered the dialogue and ate every click on it. The dialogue still rendered,
 * which is why it read as a stale session rather than as a paint order.
 *
 * pageswap fires while the outgoing snapshot is being taken, and pagereveal on
 * the incoming page before it is shown; between those two moments the names
 * are needed, and outside them they are a bug. Browsers without view
 * transitions never fire either event, so they simply navigate -- which is what
 * they did before any of this existed.
 */

watchOverlays();

const NAVIGATING = 'am2-navigating';
window.addEventListener('pageswap', () => {
    document.documentElement.classList.add(NAVIGATING);
});
window.addEventListener('pagereveal', (e) => {
    document.documentElement.classList.add(NAVIGATING);

    const done = e.viewTransition?.finished ?? Promise.resolve();
    done.catch(() => {}).finally(() => {
        document.documentElement.classList.remove(NAVIGATING);
    });
});

window.addEventListener('pageshow', () => {
    document.documentElement.classList.remove(NAVIGATING);
});

drainNotices();

window.AM2 = {
    enterOnce, countTo, revealOnScroll, filtered, toast, handoff, emit, qr, initTables,
    prefersReducedMotion, move, playExit, T, EASE, STAGGER,
};
