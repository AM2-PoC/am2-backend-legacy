    </main>
</div>

<!--
    Command palette. Opens on Cmd/Ctrl+K from anywhere, or from the header
    button. It navigates, and typing anything offers a unit search that submits
    to users.php?search= — the parameter that page has always accepted, so
    nothing new had to be exposed for it.
-->
<div x-data="palette()" @open-palette.window="open()" @keydown.window.escape="shown = false">
    <div x-cloak x-show="shown" x-transition.opacity.duration.120ms
         class="fixed inset-0 z-[60] bg-slate-950/60 backdrop-blur-sm" @click="shown = false"></div>

    <div x-cloak x-show="shown" x-transition.opacity.duration.120ms
         class="fixed inset-x-0 top-[12vh] z-[70] mx-auto w-[92%] max-w-xl"
         role="dialog" aria-modal="true" aria-label="<?= e('search.placeholder') ?>">
        <div class="overflow-hidden rounded-card border border-edge bg-card shadow-2xl">
            <div class="flex items-center gap-3 border-b border-edge px-4">
                <span class="text-ink-subtle"><?= am2_icon('search', 'h-4 w-4') ?></span>
                <input x-ref="input" x-model="q" @keydown.down.prevent="move(1)"
                       @keydown.up.prevent="move(-1)" @keydown.enter.prevent="run()"
                       type="text" autocomplete="off" spellcheck="false"
                       class="w-full border-0 bg-transparent py-3.5 text-sm text-ink
                              placeholder:text-ink-subtle focus:outline-none focus:ring-0"
                       placeholder="<?= e('search.hint') ?>">
                <kbd class="hidden rounded border border-edge px-1.5 py-0.5 font-mono text-[10px] text-ink-subtle sm:block">ESC</kbd>
            </div>

            <ul class="max-h-80 overflow-y-auto py-2" role="listbox">
                <template x-for="(item, i) in results" :key="item.id">
                    <li role="option" :aria-selected="i === cursor"
                        @mouseenter="cursor = i" @click="run(i)"
                        class="mx-2 flex cursor-pointer items-center gap-3 rounded-control px-3 py-2 text-sm"
                        :class="i === cursor ? 'bg-brand/10 text-ink' : 'text-ink-muted'">
                        <span class="shrink-0 font-mono text-[9px] uppercase tracking-[0.15em]"
                              :class="i === cursor ? 'text-brand' : 'text-ink-subtle'"
                              x-text="item.group"></span>
                        <span class="min-w-0 flex-1 truncate" x-text="item.label"></span>
                        <span x-show="i === cursor" class="font-mono text-[10px] text-ink-subtle">&crarr;</span>
                    </li>
                </template>
                <li x-show="results.length === 0" class="px-5 py-6 text-center text-sm text-ink-muted">
                    <?= e('search.no_results') ?>
                </li>
            </ul>
        </div>
    </div>
</div>

<script src="<?= am2_asset('asset/js/alpine.min.js') ?>" defer></script>
<script>
    /**
     * How many units are keyed right now, and how many are online.
     * Reads get-users-ajax.php, the same session-scoped endpoint the tracking
     * page polls, so a branch admin only ever counts its own units.
     */
    function txRail() {
        return {
            count: 0, online: 0, stale: false,
            start() {
                this.tick();
                // A transmission lasts seconds, but this sits on every page and
                // does not need to be a live meter.
                setInterval(() => this.tick(), 10000);
            },
            async tick() {
                try {
                    const res = await fetch('get-users-ajax.php', { headers: { Accept: 'application/json' } });
                    if (!res.ok) throw new Error(res.status);
                    const users = await res.json();
                    this.online = users.length;
                    this.count = users.filter((u) => Number(u.is_speaking) === 1).length;
                    this.stale = false;
                } catch {
                    // Say nothing rather than show a stale number as if it were live.
                    this.stale = true;
                }
            },
        };
    }

    const AM2_COMMANDS = <?= json_encode(array_values(array_filter([
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
    ]))) ?>;
    const AM2_SEARCH_UNITS = <?= json_encode(t('search.units')) ?>;

    function palette() {
        return {
            shown: false, q: '', cursor: 0,
            get results() {
                const q = this.q.trim().toLowerCase();
                const matched = AM2_COMMANDS.filter(
                    (c) => !q || c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
                if (!q) return matched;
                return [{
                    id: 's-units', group: AM2_SEARCH_UNITS, label: this.q.trim(),
                    href: 'users.php?search=' + encodeURIComponent(this.q.trim()),
                }, ...matched];
            },
            open() {
                this.shown = true; this.q = ''; this.cursor = 0;
                this.$nextTick(() => this.$refs.input.focus());
            },
            move(d) {
                const n = this.results.length;
                if (n) this.cursor = (this.cursor + d + n) % n;
            },
            run(i) {
                const item = this.results[i ?? this.cursor];
                if (!item) return;
                this.shown = false;
                if (item.href) { window.location.href = item.href; return; }
                if (item.action === 'theme') { document.getElementById('themeToggle').click(); return; }
                if (item.action === 'lang') {
                    const url = new URL(window.location.href);
                    url.searchParams.set('lang', document.documentElement.lang === 'id' ? 'en' : 'id');
                    window.location.href = url.toString();
                }
            },
        };
    }

    // Bound outside Alpine so the shortcut works even before it hydrates.
    window.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('open-palette'));
        }
    });

    // Outside Alpine on purpose: the theme must work whether or not that loads.
    document.getElementById('themeToggle').addEventListener('click', function () {
        const root = document.documentElement;
        const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        document.cookie = 'am2_theme=' + next + ';path=/;max-age=31536000;samesite=lax';
        this.setAttribute('aria-pressed', next === 'dark' ? 'true' : 'false');
        // A moon offers dark; a sun offers light.
        this.querySelector('[data-theme-icon="light"]').classList.toggle('hidden', next === 'dark');
        this.querySelector('[data-theme-icon="dark"]').classList.toggle('hidden', next !== 'dark');
    });
</script>
