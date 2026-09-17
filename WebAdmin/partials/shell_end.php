    </main>
</div>

<div id="am2-palette" role="dialog" tabindex="-1" aria-labelledby="am2-palette-label"
     class="hs-overlay [--overlay-backdrop:false] fixed inset-0 z-80 hidden size-full
            overflow-y-auto bg-slate-950/70 backdrop-blur-sm">
    <div data-am2-panel
         class="pointer-events-auto mx-auto mt-[12vh] w-[92%] max-w-xl overflow-hidden
                am2-surface rounded-card">

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

        const icon = document.getElementById('am2-rail-icon');
        if (icon) icon.style.transform = rail ? 'rotate(180deg)' : '';
        document.cookie = 'am2_nav=' + (rail ? 'rail' : 'wide')
            + ';path=/;max-age=31536000;samesite=lax';
    });

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


    /* ---- Operational status ------------------------------------------ *
     * Reads get-users-ajax.php, the same session-scoped endpoint the tracking
     * page polls, so a branch admin only ever counts its own units. */
    const $ = (id) => document.getElementById(id);

    const RELAY_UP = <?= json_encode(t('status.relay_up'), JSON_UNESCAPED_UNICODE) ?>;
    const RELAY_STALE = <?= json_encode(t('status.stale'), JSON_UNESCAPED_UNICODE) ?>;

    function relay(up) {
        document.querySelectorAll('[data-relay-dot]').forEach((dot) => {
            dot.className = 'h-1.5 w-1.5 shrink-0 rounded-full ' + (up ? 'bg-ok' : 'bg-warn');
        });
        document.querySelectorAll('[data-relay-text]').forEach((el) => {
            el.textContent = up ? RELAY_UP : RELAY_STALE;
            el.className = 'truncate ' + (up ? 'text-ok' : 'text-warn');
        });
    }

    async function pollStatus() {
        try {
            const res = await fetch('get-users-ajax.php', { headers: { Accept: 'application/json' } });
            if (!res.ok) throw new Error(res.status);
            const users = await res.json();
            const tx = users.filter((u) => Number(u.is_speaking) === 1).length;

            relay(true);
            window.AM2?.countTo($('am2-online'), users.length);
            window.AM2?.countTo($('am2-tx'), tx);

            $('am2-tx-dot').classList.toggle('hidden', tx === 0);
            $('am2-tx-dot').classList.toggle('am2-live', tx > 0);
            $('am2-stale').classList.add('hidden');
        } catch {

            relay(false);
            $('am2-stale').classList.remove('hidden');
        }
    }

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
        results = q
            ? [...matched,
               { id: 's-units', group: UNITS_LABEL, label: input.value.trim(),
                 href: 'users.php?search=' + encodeURIComponent(input.value.trim()) }]
            : matched;

        cursor = 0;
        render();
    }

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

    function paint() {
        rows.forEach((li, i) => {
            const on = i === cursor;
            li.setAttribute('aria-selected', on ? 'true' : 'false');
            li.className = ROW + (on ? 'bg-brand/10 text-ink' : 'text-ink-muted');
            li.firstChild.className = GROUP + (on ? 'text-brand' : 'text-ink-subtle');
        });

        rows[cursor]?.scrollIntoView({ block: 'nearest' });
    }

    function select(i) {
        if (i === cursor || i < 0 || i >= results.length) return;
        cursor = i;
        paint();
    }

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

        setTimeout(() => {
            el?.setAttribute('tabindex', '-1');
            el?.focus({ preventScroll: true });
            el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 220);
    }

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

            e.preventDefault();
            e.stopPropagation();
            setTimeout(run, 0);
        }
    });

    document.getElementById('am2-palette')?.addEventListener('open.hs.overlay', () => {
        input.value = ''; cursor = 0; compute();
        setTimeout(() => input.focus(), 50);
    });

    compute();

    const palette = document.getElementById('am2-palette');
    const paletteOpen = () => palette && !palette.classList.contains('hidden');

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

    palette?.addEventListener('click', (e) => {
        if (!e.target.closest('[data-am2-panel]')) window.HSOverlay?.close(palette);
    });
})();
</script>

<?php include __DIR__ . '/theme_toggle.php'; ?>
</body>
</html>
