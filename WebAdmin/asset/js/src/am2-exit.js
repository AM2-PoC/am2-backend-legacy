
const CLOSING = 'am2-closing';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function playExit(el) {
    if (!el || reduced() || el.classList.contains(CLOSING)) return Promise.resolve();
    el.classList.add(CLOSING);

    return new Promise((resolve) => {

        requestAnimationFrame(() => {

            const running = el.getAnimations({ subtree: true })
                .filter((a) => a.playState === 'running');
            const done = running.length
                ? Promise.allSettled(running.map((a) => a.finished))
                : Promise.resolve();
            done.then(() => {
                el.classList.remove(CLOSING);
                resolve();
            });
        });
    });
}

const SETTLE = 400;

function reconcile(el) {
    if (!el?.classList.contains('hidden')) return;

    el.classList.remove('open', 'opened');
    if (el.id) {
        document.querySelectorAll(`[id="${CSS.escape(el.id)}-backdrop"]`)
            .forEach((backdrop) => backdrop.remove());
    }
    // The scroll lock belongs to whichever overlay is still open. With none
    // left, a lock still on the body is one that was never handed back.
    if (!document.querySelector('.hs-overlay.opened')) {
        document.body.style.removeProperty('overflow');
    }
}

export function watchOverlays() {
    document.addEventListener('close.hs.overlay', (e) => {
        const el = e.target?.closest?.('.hs-overlay') ?? e.target;
        playExit(el).then(() => setTimeout(() => reconcile(el), SETTLE));
    });
}
