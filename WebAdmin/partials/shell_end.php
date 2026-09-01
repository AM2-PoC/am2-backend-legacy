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
<!--
    No Preline backdrop, deliberately.

    This overlay is already a full-screen scrim -- it is `fixed inset-0` with a
    background of its own -- so Preline's was a second sheet of grey underneath
    it, drawing nothing that was not already drawn. It was also the thing that
    left the screen unusable: Preline builds one backdrop per open under a fixed
    id, `am2-palette-backdrop`, and removes it on close by looking that id up.
    Close and open overlapping -- which is what a keystroke landing while the
    palette is still leaving does -- leaves two elements sharing that id, the
    lookup finds the dying one, and the live one is never removed. It ends up
    over the page at opacity 0: nothing to see, and every click swallowed.

    Reproduced before the fix by reopening 30ms into a close and closing again
    straight after: one backdrop left behind, and the link underneath was no
    longer the element at its own coordinates.

    The scrim's alpha absorbs the one that is gone, so the page behind it is as
    dark as it was: 0.4 over Preline's 0.5 came to 0.7.

    Closing by clicking outside does not depend on it either -- that is the
    handler at the foot of this file, on this element.
-->
<div id="am2-palette" role="dialog" tabindex="-1" aria-labelledby="am2-palette-label"
     class="hs-overlay [--overlay-backdrop:false] fixed inset-0 z-80 hidden size-full
            overflow-y-auto bg-slate-950/70 backdrop-blur-sm">
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
    /*
     * One list, and it is the shell's.
     *
     * The sections of Settings used to be added by that page, which meant they
     * existed in the palette only once you were already looking at them:
     * "distribusi" from the dashboard matched nothing at all. They are ordinary
     * destinations with a fragment now, and run() turns one that names the page
     * you are on back into an in-page jump, so being there still scrolls rather
     * than reloads. A page may still contribute its own, and nothing does.
     *
     * `keys` are search aliases -- never drawn, only matched. They are
     * deliberately not translated: an operator switching an interface between
     * two languages does not switch which words come to mind, and "settings"
     * has to find Pengaturan the same way "keluar" has to find Logout. The
     * labels are what the palette shows; these are what it hears.
     */
    const COMMANDS = <?= json_encode(array_merge(array_values(array_filter([
        ['id' => 'p-dash',     'group' => t('nav.home'),       'label' => t('nav.dashboard'),      'href' => 'dashboard.php',
         'keys' => 'dashboard beranda home ringkasan overview'],
        ['id' => 'p-users',    'group' => t('nav.management'), 'label' => t('nav.users'),          'href' => 'users.php',
         'keys' => 'user users pengguna unit anggota member akun account'],
        ['id' => 'p-chan',     'group' => t('nav.management'), 'label' => t('nav.channels'),       'href' => 'channels.php',
         'keys' => 'channel channels kanal saluran grup group frekuensi'],
        ['id' => 'p-access',   'group' => t('nav.management'), 'label' => t('nav.channel_access'), 'href' => 'user_access.php',
         'keys' => 'akses access hak izin permission role peta maps ptp'],
        ['id' => 'p-track',    'group' => t('nav.monitoring'), 'label' => t('nav.live_track'),     'href' => 'livetrack.php',
         'keys' => 'live track tracking peta map lokasi location gps posisi'],
        ['id' => 'p-logs',     'group' => t('nav.monitoring'), 'label' => t('nav.activity_log'),   'href' => 'logs.php',
         'keys' => 'log logs aktivitas activity riwayat history audit jejak event'],
        ['id' => 'p-settings', 'group' => t('nav.system'),     'label' => t('nav.settings'),       'href' => 'settings.php',
         'keys' => 'setting settings pengaturan konfigurasi config sistem system preferensi'],
        $isSuper
            ? ['id' => 'p-admin', 'group' => t('nav.administrator'), 'label' => t('nav.admin_panel'), 'href' => 'admin_panel.php',
               'keys' => 'admin administrator panel superadmin operator']
            : null,

        // The sections of Settings, reachable from anywhere.
        ['id' => 's-account', 'group' => t('set.heading'), 'label' => t('set.account'),
         'href' => 'settings.php#am2-card-account',
         'keys' => 'akun account password sandi kata sandi profil profile'],
        ['id' => 's-quota',   'group' => t('set.heading'), 'label' => t('set.licence'),
         'href' => 'settings.php#am2-card-licence',
         'keys' => 'lisensi licence license kuota quota limit batas'],
        $isSuper
            ? ['id' => 's-apk', 'group' => t('set.heading'), 'label' => t('set.distribution'),
               'href' => 'settings.php#am2-card-shelf',
               'keys' => 'apk aplikasi app distribusi distribution update pembaruan versi version qr rak shelf']
            : null,
        ['id' => 's-export',  'group' => t('set.heading'), 'label' => t('set.export'),
         'href' => 'settings.php#am2-card-danger',
         'keys' => 'ekspor export dump basis data database backup cadangan unduh download'],
        $isSuper
            ? ['id' => 's-restore', 'group' => t('set.heading'), 'label' => t('set.restore'),
               'href' => 'settings.php#am2-card-danger',
               'keys' => 'pulihkan restore backup cadangan import impor kembalikan']
            : null,

        ['id' => 'a-theme', 'group' => t('search.action'), 'label' => t('pref.theme'),    'action' => 'theme',
         'keys' => 'tema theme dark light gelap terang mode'],
        ['id' => 'a-lang',  'group' => t('search.action'), 'label' => t('pref.language'), 'action' => 'lang',
         'keys' => 'bahasa language lang indonesia english inggris'],
        ['id' => 'a-out',   'group' => t('search.action'), 'label' => t('nav.logout'),    'href'   => 'logout.php',
         'keys' => 'logout keluar sign out signout exit log out'],
    ])), array_values(is_array($pageCommands ?? null) ? $pageCommands : []))) ?>;
    const UNITS_LABEL = <?= json_encode(t('search.units')) ?>;
    const NO_RESULTS = <?= json_encode(t('search.no_results')) ?>;

    const input = $('am2-palette-input');
    const list = $('am2-palette-list');
    let cursor = 0, results = [];

    function compute() {
        const q = input.value.trim().toLowerCase();
        const matched = COMMANDS.filter(
            (c) => !q || c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)
                || (c.keys || '').includes(q));
        /*
         * The unit search is the fallback, so it goes last.
         *
         * It used to be prepended, and the cursor starts at 0, so the
         * highlighted row was always "find a unit" no matter what had been
         * typed: "dashboard" then Enter landed on the user list searching for
         * the word dashboard, and the Dashboard row sitting right underneath
         * could only be reached by arrowing down to it or clicking. Every page
         * the palette knew about was unreachable by the key everyone presses.
         */
        results = q
            ? [...matched,
               { id: 's-units', group: UNITS_LABEL, label: input.value.trim(),
                 href: 'users.php?search=' + encodeURIComponent(input.value.trim()) }]
            : matched;
        // A new query is a new list; the row under the cursor a keystroke ago
        // has nothing to do with the row at that index now.
        cursor = 0;
        render();
    }

    /*
     * Building the list and painting the selection are two different jobs.
     *
     * They used to be one, and hovering a row set the cursor and rebuilt the
     * whole list from scratch. The row under the pointer was therefore replaced
     * by a new element, which -- with the pointer still resting on it -- took
     * `mouseenter` in its turn and rebuilt the list again. Measured with a real
     * pointer resting on the list and nothing else happening: about four
     * rebuilds a second, indefinitely.
     *
     * That is both faults reported. A click needs its mousedown and its mouseup
     * on the same element, and the element was being swapped out underneath
     * them -- Playwright, driving a real mouse, reported "element was detached
     * from the DOM" twelve times over and never landed the hover at all. And
     * every arrow key was undone: pressing Down moved the selection to Live
     * Track, and 400ms later it was back on the row under the mouse, because
     * the loop was re-running `cursor = i` several times a second.
     *
     * So the rows are built when the results change, and the selection is
     * painted onto the rows that are already there. Nothing is detached to move
     * the highlight. What the pointer contributes is below, and it is keyed off
     * movement rather than off which element happens to be underneath.
     */
    let rows = [];

    const ROW = 'mx-2 flex h-11 cursor-pointer items-center gap-3 rounded-control px-3 text-sm ';
    const GROUP = 'shrink-0 font-mono text-[11px] uppercase tracking-[0.15em] ';

    function render() {
        list.textContent = '';
        rows = [];
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

            const g = document.createElement('span');
            // textContent, not innerHTML: `label` is whatever was typed.
            g.textContent = item.group;

            const l = document.createElement('span');
            l.className = 'min-w-0 flex-1 truncate';
            l.textContent = item.label;

            li.append(g, l);
            li.addEventListener('click', () => run(i));
            list.appendChild(li);
            rows.push(li);
        });
        paint();
    }

    /** Move the highlight, and nothing else. */
    function paint() {
        rows.forEach((li, i) => {
            const on = i === cursor;
            li.setAttribute('aria-selected', on ? 'true' : 'false');
            li.className = ROW + (on ? 'bg-brand/10 text-ink' : 'text-ink-muted');
            li.firstChild.className = GROUP + (on ? 'text-brand' : 'text-ink-subtle');
        });

        /*
         * Follow the cursor down the list.
         *
         * The list is 320px of an up-to-720px column, so from the eighth row
         * the highlight was outside the box and scrollTop stayed at 0 no matter
         * how far the arrow key went: the selection was somewhere below, off
         * screen, with nothing on screen moving. Measured before the fix --
         * row 7 at 316px against a 320px box, row 10 at 448px, scrollTop 0
         * throughout.
         *
         * 'nearest' rather than a computed scrollTop: it moves the list by the
         * least amount that makes the row visible, does nothing when the row
         * already is -- which is every hover, since the pointer cannot be on a
         * row it cannot see -- and does not drag the overlay or the page behind
         * it along with it.
         */
        rows[cursor]?.scrollIntoView({ block: 'nearest' });
    }

    /** The one way the cursor moves. */
    function select(i) {
        if (i === cursor || i < 0 || i >= results.length) return;
        cursor = i;
        paint();
    }

    /*
     * The pointer moves the cursor by moving, not by being somewhere.
     *
     * This was `mouseenter` on each row, and `mouseenter` does not mean the
     * pointer moved -- it means the element under it changed, which also
     * happens when the list scrolls beneath a pointer that is sitting perfectly
     * still. So arrowing down scrolled a new row under the resting pointer,
     * that row claimed the cursor, and the keyboard was fought for every press:
     * fifteen arrows from the top landed on the fourth row with the pointer
     * over the list, and on the sixteenth -- the right one -- with the pointer
     * anywhere else.
     *
     * `mousemove` fires only when the pointer actually moves, which is the
     * thing this was always meant to react to. One listener on the list rather
     * than one per row, because the row is in the event.
     */
    list.addEventListener('mousemove', (e) => {
        const li = e.target.closest?.('li');
        if (li) select(rows.indexOf(li));
    });

    /**
     * A section of the page that is already open.
     *
     * Closing the overlay while the Enter key was still travelling had Preline
     * re-open it 53ms later, with no click on any trigger -- traced, not
     * guessed. The fix is in the keydown handler below, which lets the key
     * event finish first; this only has to avoid fighting the focus restore.
     */
    function jumpTo(selector) {
        const el = document.querySelector(selector);
        window.HSOverlay?.close(document.getElementById('am2-palette'));
        // Preline restores focus as part of closing; landing after it has
        // settled means the two are not competing for the same element.
        setTimeout(() => {
            el?.setAttribute('tabindex', '-1');
            el?.focus({ preventScroll: true });
            el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 220);
    }

    /** The file this page is, as the command list spells it. */
    const HERE = window.location.pathname.split('/').pop() || 'dashboard.php';

    function run(i) {
        const item = results[i ?? cursor];
        if (!item) return;
        if (item.href) {
            /*
             * A destination naming the page you are already on is a jump, not a
             * navigation. Assigning the same path with a fragment does not
             * reload -- it changes the fragment and leaves the overlay sitting
             * open over the section it was asked to show.
             */
            const [path, hash] = item.href.split('#');
            if (hash && (path === '' || path === HERE)) { jumpTo('#' + hash); return; }
            window.location.href = item.href;
            return;
        }
        if (item.target) { jumpTo(item.target); return; }
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
        if (e.key === 'ArrowDown') { e.preventDefault(); select((cursor + 1) % results.length); }
        if (e.key === 'ArrowUp')   { e.preventDefault(); select((cursor - 1 + results.length) % results.length); }
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
