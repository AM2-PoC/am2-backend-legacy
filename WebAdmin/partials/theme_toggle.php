<?php
/**
 * The theme toggle's behaviour, in one place.
 *
 * It lived twice -- once in shell_end.php and once in login.php, whose copy
 * carried a comment saying it was "identical to the shell's". It was not: the
 * shell gained the view-transition ripple and the login page kept swapping
 * instantly, which is exactly the drift a second copy produces and the reason
 * nobody notices until someone signs in and sees the difference.
 *
 * Included by both, outside every framework on purpose: the theme has to work
 * whether or not the bundle arrives.
 */
?>
<script>
(() => {
    'use strict';
    document.getElementById('themeToggle')?.addEventListener('click', function () {
        const root = document.documentElement;
        const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';

        /*
         * The class stays on for the duration of the swap: it suppresses the
         * per-element transitions -- without it a few hundred bordered controls
         * each ease to a new colour on their own schedule, which is a sweep
         * across the screen rather than a switch -- and it is what names the
         * root for the view transition. Named permanently it would make the
         * root a stacking context, which is what once put every dialogue under
         * Preline's backdrop, and it would take the root snapshot away from the
         * page transition that uses it on every navigation.
         */
        const apply = () => {
            root.setAttribute('data-theme', next);
            document.cookie = 'am2_theme=' + next + ';path=/;max-age=31536000;samesite=lax';
            this.setAttribute('aria-pressed', next === 'dark' ? 'true' : 'false');
            this.querySelector('[data-theme-icon="light"]')?.classList.toggle('hidden', next === 'dark');
            this.querySelector('[data-theme-icon="dark"]')?.classList.toggle('hidden', next !== 'dark');
        };

        // The new theme grows from the control that asked for it, so the change
        // has a visible cause. The radius reaches the furthest corner, which is
        // what guarantees the circle finishes by covering the screen wherever
        // the toggle happens to sit.
        const r = this.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        root.style.setProperty('--am2-theme-x', x + 'px');
        root.style.setProperty('--am2-theme-y', y + 'px');
        root.style.setProperty('--am2-theme-r',
            Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 'px');

        root.classList.add('am2-theme-switching');

        // An enhancement, never the mechanism: a browser without the API still
        // changes theme, exactly as instantly as it did before.
        if (!document.startViewTransition) {
            apply();
            requestAnimationFrame(() => requestAnimationFrame(
                () => root.classList.remove('am2-theme-switching')));
            return;
        }

        const vt = document.startViewTransition(apply);
        // `finished` rejects when a transition is skipped -- another one
        // starting, or the tab being hidden mid-swap. Either way the class has
        // to come off, or the page is left named and unable to navigate.
        vt.finished.catch(() => {}).finally(() => {
            root.classList.remove('am2-theme-switching');
        });
    });
})();
</script>
