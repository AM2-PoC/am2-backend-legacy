<?php

?>
<script>
(() => {
    'use strict';
    document.getElementById('themeToggle')?.addEventListener('click', function () {
        const root = document.documentElement;
        const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';

        const apply = () => {
            root.setAttribute('data-theme', next);
            document.cookie = 'am2_theme=' + next + ';path=/;max-age=31536000;samesite=lax';
            this.setAttribute('aria-pressed', next === 'dark' ? 'true' : 'false');
            this.querySelector('[data-theme-icon="light"]')?.classList.toggle('hidden', next === 'dark');
            this.querySelector('[data-theme-icon="dark"]')?.classList.toggle('hidden', next !== 'dark');
        };

        const r = this.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        root.style.setProperty('--am2-theme-x', x + 'px');
        root.style.setProperty('--am2-theme-y', y + 'px');
        root.style.setProperty('--am2-theme-r',
            Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 'px');

        root.classList.add('am2-theme-switching');

        if (!document.startViewTransition) {
            apply();
            requestAnimationFrame(() => requestAnimationFrame(
                () => root.classList.remove('am2-theme-switching')));
            return;
        }

        const vt = document.startViewTransition(apply);

        vt.finished.catch(() => {}).finally(() => {
            root.classList.remove('am2-theme-switching');
        });
    });
})();
</script>
