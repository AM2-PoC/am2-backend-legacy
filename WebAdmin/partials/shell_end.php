    </main>
</div>

<!--
    Command palette. Preline's free modal:
    https://preline.co/docs/modal.html
    Preline owns open, close, Escape and focus; the list and the keyboard
    cursor are plain JavaScript, because they are about the panel's data rather
    than the component's state.

    It navigates, and typing anything offers a unit search that submits to
    users.php?search= — the parameter that page has always accepted, so nothing
    new had to be exposed for it.
-->
<div id="am2-palette" role="dialog" tabindex="-1" aria-labelledby="am2-palette-label"
     class="hs-overlay fixed inset-0 z-80 hidden size-full overflow-y-auto
            bg-slate-950/40 backdrop-blur-sm">
    <div data-am2-panel
         class="pointer-events-auto mx-auto mt-[12vh] w-[92%] max-w-xl overflow-hidden
                am2-surface rounded-card">
        <!--
            The search row is the card's own top edge, so it cannot wear the
            ordinary focus ring: the input runs the full width inside a 20px
            radius with overflow hidden, and a 2px ring offset by 2px came out
            as a rectangle with both ends clipped by the corners and its top
            against the card edge. The row takes the focus instead -- the
            hairline under it thickens and colours -- which is a shape that fits
            what it is drawn inside.
        -->
        <div class="am2-palette-field flex items-center gap-3 border-b border-edge px-4">
            <span class="text-ink-subtle"><?= am2_icon('search', 'h-4 w-4') ?></span>
            <label id="am2-palette-label" for="am2-palette-input" class="sr-only">
                <?= e('search.placeholder') ?>
            </label>
            <input id="am2-palette-input" type="text" autocomplete="off" spellcheck="false"
                   role="combobox" aria-expanded="true" aria-controls="am2-palette-list"
                   class="w-full border-0 bg-transparent py-3.5 text-sm text-ink
                          placeholder:text-ink-subtle focus:outline-none focus:ring-0
                          focus-visible:outline-none"
                   placeholder="<?= e('search.hint') ?>">
            <kbd class="hidden rounded border border-edge px-1.5 py-0.5 font-mono text-[11px]
                        text-ink-subtle sm:block">ESC</kbd>
        </div>
        <ul id="am2-palette-list" role="listbox" class="max-h-80 overflow-y-auto py-2"></ul>
    </div>
</div>

<script src="<?= am2_asset('asset/js/am2-ui.min.js') ?>" defer></script>

<script>
(() => {
    'use strict';

    /* ---- The rail -------------------------------------------------- *
     * A cookie rather than storage: PHP reads it on the next request and
     * renders the correct width immediately, so there is no snap after paint.
     * Preline owns the drawer below lg; this only touches widths above it. */
    const sidebar = document.getElementById('am2-sidebar');
    const content = document.getElementById('am2-content');
    const railBtn = document.getElementById('am2-rail-toggle');
    let rail = <?= am2_sidebar_collapsed() ? 'true' : 'false' ?>;

    railBtn?.addEventListener('click', () => {
        rail = !rail;
        sidebar.classList.toggle('lg:w-[72px]', rail);
        sidebar.classList.toggle('lg:w-[272px]', !rail);
        content.classList.toggle('lg:ps-[72px]', rail);
        content.classList.toggle('lg:ps-[272px]', !rail);
        document.documentElement.classList.toggle('am2-rail', rail);
        railBtn.setAttribute('aria-expanded', rail ? 'false' : 'true');
        // The icon is the only thing left saying which way this goes.
        const icon = document.getElementById('am2-rail-icon');
        if (icon) icon.style.transform = rail ? 'rotate(180deg)' : '';
        document.cookie = 'am2_nav=' + (rail ? 'rail' : 'wide')
            + ';path=/;max-age=31536000;samesite=lax';
    });

    /* ---- Which nav groups are folded -------------------------------- *
     * Preline decides open and closed; this only records what it decided, so
     * the sidebar renders already folded on the next page rather than folding
     * after paint. */
    document.addEventListener('open.hs.accordion', recordFolds);
    document.addEventListener('hide.hs.accordion', recordFolds);
    function recordFolds() {
        const folded = [...document.querySelectorAll('.hs-accordion')]
            .filter((el) => !el.classList.contains('active'))
            .map((el) => el.dataset.group)
            .filter(Boolean);
        document.cookie = 'am2_folded=' + encodeURIComponent(folded.join(','))
            + ';path=/;max-age=31536000;samesite=lax';
    }

    /* ---- Theme ------------------------------------------------------- *
     * In partials/theme_toggle.php, included at the foot of this file, because
     * login.php needs the same behaviour and a second copy of it had already
     * drifted -- the shell gained the ripple and login kept swapping instantly.
     */

    /* ---- Operational status ------------------------------------------ *
     * Reads get-users-ajax.php, the same session-scoped endpoint the tracking
     * page polls, so a branch admin only ever counts its own units. */
    const $ = (id) => document.getElementById(id);
    async function pollStatus() {
        try {
            const res = await fetch('get-users-ajax.php', { headers: { Accept: 'application/json' } });
            if (!res.ok) throw new Error(res.status);
            const users = await res.json();
            const tx = users.filter((u) => Number(u.is_speaking) === 1).length;

            $('am2-relay-dot').className = 'h-1.5 w-1.5 rounded-full bg-ok';
            $('am2-relay-text').textContent = <?= json_encode(t('status.relay_up')) ?>;
            $('am2-relay-text').className = 'text-ok';
            window.AM2?.countTo($('am2-online'), users.length);
            window.AM2?.countTo($('am2-tx'), tx);
            // The one pulse in the application, and only while it is true.
            $('am2-tx-dot').classList.toggle('hidden', tx === 0);
            $('am2-tx-dot').classList.toggle('am2-live', tx > 0);
            $('am2-stale').classList.add('hidden');
        } catch {
            // Say the numbers are old rather than show them as if they were live.
            $('am2-relay-dot').className = 'h-1.5 w-1.5 rounded-full bg-warn';
            $('am2-stale').classList.remove('hidden');
        }
    }
    /*
     * Every ten seconds on every page was a request for the whole fleet -- the
     * endpoint returns one row per unit, so on a full deployment that is tens
     * of kilobytes a tab, forever, including tabs nobody is looking at. Thirty
     * seconds is still inside the window an operator would call live, and a
     * hidden tab asks for nothing at all until it comes back.
     */
    const STATUS_EVERY = 30000;
    let statusTimer = null;

    function startStatus() {
        if (statusTimer) return;
        pollStatus();
        statusTimer = setInterval(pollStatus, STATUS_EVERY);
    }
    function stopStatus() {
        clearInterval(statusTimer);
        statusTimer = null;
    }

    document.addEventListener('visibilitychange',
        () => (document.hidden ? stopStatus() : startStatus()));
    if (!document.hidden) startStatus();

    /* ---- Command palette --------------------------------------------- */
    // A page may add its own sections; the shell owns the search, so this
    // stays one list rather than a second one appearing per page.
    const COMMANDS = <?= json_encode(array_merge(array_values(array_filter([
        ['id' => 'p-dash',     'group' => t('nav.home'),       'label' => t('nav.dashboard'),      'href' => 'dashboard.php'],
        ['id' => 'p-users',    'group' => t('nav.management'), 'label' => t('nav.users'),          'href' => 'users.php'],
        ['id' => 'p-chan',     'group' => t('nav.management'), 'label' => t('nav.channels'),       'href' => 'channels.php'],
        ['id' => 'p-access',   'group' => t('nav.management'), 'label' => t('nav.channel_access'), 'href' => 'user_access.php'],
        ['id' => 'p-track',    'group' => t('nav.monitoring'), 'label' => t('nav.live_track'),     'href' => 'livetrack.php'],
        ['id' => 'p-logs',     'group' => t('nav.monitoring'), 'label' => t('nav.activity_log'),   'href' => 'logs.php'],
        ['id' => 'p-settings', 'group' => t('nav.system'),     'label' => t('nav.settings'),       'href' => 'settings.php'],
        $isSuper
            ? ['id' => 'p-admin', 'group' => t('nav.administrator'), 'label' => t('nav.admin_panel'), 'href' => 'admin_panel.php']
            : null,
        ['id' => 'a-theme', 'group' => t('search.action'), 'label' => t('pref.theme'),    'action' => 'theme'],
        ['id' => 'a-lang',  'group' => t('search.action'), 'label' => t('pref.language'), 'action' => 'lang'],
        ['id' => 'a-out',   'group' => t('search.action'), 'label' => t('nav.logout'),    'href'   => 'logout.php'],
    ])), array_values(is_array($pageCommands ?? null) ? $pageCommands : []))) ?>;
    const UNITS_LABEL = <?= json_encode(t('search.units')) ?>;
    const NO_RESULTS = <?= json_encode(t('search.no_results')) ?>;

    const input = $('am2-palette-input');
    const list = $('am2-palette-list');
    let cursor = 0, results = [];

    function compute() {
        const q = input.value.trim().toLowerCase();
        const matched = COMMANDS.filter(
            (c) => !q || c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
        results = q
            ? [{ id: 's-units', group: UNITS_LABEL, label: input.value.trim(),
                 href: 'users.php?search=' + encodeURIComponent(input.value.trim()) }, ...matched]
            : matched;
        if (cursor >= results.length) cursor = 0;
        render();
    }

    function render() {
        list.textContent = '';
        if (!results.length) {
            const li = document.createElement('li');
            li.className = 'px-5 py-6 text-center text-sm text-ink-muted';
            li.textContent = NO_RESULTS;
            list.appendChild(li);
            return;
        }
        results.forEach((item, i) => {
            const li = document.createElement('li');
            li.role = 'option';
            li.setAttribute('aria-selected', i === cursor ? 'true' : 'false');
            li.className = 'mx-2 flex h-11 cursor-pointer items-center gap-3 rounded-control px-3 text-sm '
                + (i === cursor ? 'bg-brand/10 text-ink' : 'text-ink-muted');

            const g = document.createElement('span');
            g.className = 'shrink-0 font-mono text-[11px] uppercase tracking-[0.15em] '
                + (i === cursor ? 'text-brand' : 'text-ink-subtle');
            // textContent, not innerHTML: `label` is whatever was typed.
            g.textContent = item.group;

            const l = document.createElement('span');
            l.className = 'min-w-0 flex-1 truncate';
            l.textContent = item.label;

            li.append(g, l);
            li.addEventListener('mouseenter', () => { cursor = i; render(); });
            li.addEventListener('click', () => run(i));
            list.appendChild(li);
        });
    }

    function run(i) {
        const item = results[i ?? cursor];
        if (!item) return;
        if (item.href) { window.location.href = item.href; return; }
        if (item.target) {
            /*
             * A section of the page that is already open. Closing the overlay
             * while the Enter key was still travelling had Preline re-open it
             * 53ms later, with no click on any trigger -- traced, not guessed.
             * The fix is in the keydown handler below, which lets the key event
             * finish first; this only has to avoid fighting the focus restore.
             */
            const el = document.querySelector(item.target);
            window.HSOverlay?.close(document.getElementById('am2-palette'));
            // Preline restores focus as part of closing; landing after it has
            // settled means the two are not competing for the same element.
            setTimeout(() => {
                el?.setAttribute('tabindex', '-1');
                el?.focus({ preventScroll: true });
                el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 220);
            return;
        }
        if (item.action === 'theme') {
            window.HSOverlay?.close(document.getElementById('am2-palette'));
            document.getElementById('themeToggle')?.click();
            return;
        }
        if (item.action === 'lang') {
            const url = new URL(window.location.href);
            url.searchParams.set('lang', document.documentElement.lang === 'id' ? 'en' : 'id');
            window.location.href = url.toString();
        }
    }

    input?.addEventListener('input', compute);
    input?.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); cursor = (cursor + 1) % results.length; render(); }
        if (e.key === 'ArrowUp')   { e.preventDefault(); cursor = (cursor - 1 + results.length) % results.length; render(); }
        if (e.key === 'Enter') {
            // Deferred, and kept off the document: closing the overlay while
            // the Enter key was still travelling had Preline re-open it 53ms
            // later. Letting the key event finish first stops that.
            e.preventDefault();
            e.stopPropagation();
            setTimeout(run, 0);
        }
    });

    // Preline moves focus into the panel; this only resets what is in it.
    document.getElementById('am2-palette')?.addEventListener('open.hs.overlay', () => {
        input.value = ''; cursor = 0; compute();
        setTimeout(() => input.focus(), 50);
    });

    compute();

    // Preline still owns open and closed -- these only call it. Its own Escape
    // handling covers overlays opened through a data-hs-overlay trigger, and an
    // overlay opened from script was not registered as the active one, so the
    // palette opened and could not be closed by any means at all.
    const palette = document.getElementById('am2-palette');
    const paletteOpen = () => palette && !palette.classList.contains('hidden');

    // Capture phase. Preline's accessibility manager registers its own keydown
    // on document and consumes Escape for whichever overlay it considers
    // active -- which is never one that script opened. Listening on the bubble
    // meant this handler was never reached, and the palette could not be
    // closed by any means.
    window.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            if (paletteOpen()) {
                window.HSOverlay?.close(palette);
            } else {
                document.querySelector('header [data-hs-overlay="#am2-palette"]')?.click();
            }
            return;
        }
        if (e.key === 'Escape' && paletteOpen()) {
            e.preventDefault();
            e.stopPropagation();
            window.HSOverlay?.close(palette);
        }
    }, true);

    // Clicking the backdrop, which means anywhere that is not the panel.
    palette?.addEventListener('click', (e) => {
        if (!e.target.closest('[data-am2-panel]')) window.HSOverlay?.close(palette);
    });
})();
</script>

<?php include __DIR__ . '/theme_toggle.php'; ?>
</body>
</html>
