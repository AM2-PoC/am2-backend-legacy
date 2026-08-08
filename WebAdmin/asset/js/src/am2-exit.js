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
            const running = el.getAnimations().filter((a) => a.playState === 'running');
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
 * Every overlay leaves this way.
 *
 * close.hs.overlay fires as Preline begins closing -- the moment the element is
 * still on screen and about to stop being.
 */
export function watchOverlays() {
    document.addEventListener('close.hs.overlay', (e) => {
        const el = e.target?.closest?.('.hs-overlay') ?? e.target;
        playExit(el);
    });
}
