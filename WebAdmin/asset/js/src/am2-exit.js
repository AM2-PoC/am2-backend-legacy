/**
 * Playing a panel out.
 *
 * Preline sets `hidden` -- display:none -- in the same frame it decides to
 * close, and the bulk bar is toggled the same way by hand. Either way there is
 * no frame left in which the element is still painted, so nothing can be
 * animated out by CSS alone: every panel in this console arrived with motion
 * and left by disappearing.
 *
 * This holds the element visible with `.am2-closing` for exactly as long as its
 * exit animation runs, then lets go. It opens and closes nothing itself --
 * Preline still owns the state; this only borrows the element for the frames
 * between the decision and the paint.
 *
 * Its own module rather than a function in am2-ui.js because am2-table.js needs
 * it too, and am2-ui.js already imports am2-table.js -- reaching back the other
 * way would be a cycle, and reading it off window.AM2 would be reading a global
 * that is assigned after am2-table.js has already run.
 */

const CLOSING = 'am2-closing';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Hold `el` on screen until its exit animation finishes.
 *
 * Resolves immediately under reduced motion, where there is no animation to
 * wait for and the element should simply go.
 */
export function playExit(el) {
    if (!el || reduced() || el.classList.contains(CLOSING)) return Promise.resolve();
    el.classList.add(CLOSING);

    return new Promise((resolve) => {
        // Asked for on the next frame, so what gets measured is the exit rule
        // the class just brought in rather than whatever ran before it.
        requestAnimationFrame(() => {
            /*
             * Including descendants, which is where the exit that matters
             * actually runs. The overlay itself only fades its scrim
             * (--duration-exit, 120ms); the panel inside it slides down over
             * --duration-drawer (220ms). Measuring the overlay alone dropped
             * the class at 120ms, the child rule stopped matching, and every
             * bottom sheet was cut at just over half its exit -- the exact
             * defect this module exists to prevent.
             */
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

/**
 * How long after a close to check that the close actually finished.
 *
 * Preline defers the callback that marks an overlay open by 50ms, so a close
 * arriving inside that window is overtaken by it: the close hides the element
 * and the deferred callback then puts `open`/`opened` back on it. The longest
 * exit in this console is the drawer's, so 400ms is past both and past nothing
 * that is still legitimately in flight.
 */
const SETTLE = 400;

/**
 * Put right an overlay that was closed while it was still opening.
 *
 * Preline builds one backdrop per open under a fixed id -- `<overlay>-backdrop`
 * -- and removes it on close by looking that id up. Close and open overlapping
 * leaves two elements sharing the id, and the deferred open callback then
 * re-marks a hidden element as opened. What is left is an element that is
 * `hidden` but still says `opened`, and a spare backdrop: `fixed inset-0`,
 * faded to nothing, and on top of the page. Nothing to see, every click
 * swallowed, and the trigger toggles the wrong way because the element claims
 * to be open already.
 *
 * Measured on an ordinary overlay: closing at the same moment as the reopen
 * left one backdrop behind on every attempt, still there three seconds later,
 * with the link underneath no longer the element at its own coordinates.
 *
 * This runs only when the overlay really is closed. Reopened inside the window,
 * it is a live overlay and none of this applies to it.
 */
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

/**
 * Every overlay leaves this way.
 *
 * close.hs.overlay fires as Preline begins closing -- the moment the element is
 * still on screen and about to stop being.
 */
export function watchOverlays() {
    document.addEventListener('close.hs.overlay', (e) => {
        const el = e.target?.closest?.('.hs-overlay') ?? e.target;
        playExit(el).then(() => setTimeout(() => reconcile(el), SETTLE));
    });
}
