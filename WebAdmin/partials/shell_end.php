    </main>
</div>

<script src="<?= am2_asset('asset/js/alpine.min.js') ?>" defer></script>
<script>
    /**
     * How many units are keyed right now, and how many are online.
     * Reads get-users-ajax.php, the same session-scoped endpoint the tracking
     * page already polls, so a branch admin only ever counts its own units.
     */
    function txRail() {
        return {
            count: 0, online: 0, stale: false, timer: null,
            start() {
                this.tick();
                // Ten seconds: a transmission lasts seconds, but this sits on
                // every page and does not need to be a live meter.
                this.timer = setInterval(() => this.tick(), 10000);
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

    // Outside Alpine on purpose: the theme must work whether or not that loads.
    document.getElementById('themeToggle').addEventListener('click', function () {
        const root = document.documentElement;
        const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        document.cookie = 'am2_theme=' + next + ';path=/;max-age=31536000;samesite=lax';
        this.setAttribute('aria-pressed', next === 'dark' ? 'true' : 'false');
        // Swap which icon is shown: a moon offers dark, a sun offers light.
        this.querySelector('[data-theme-icon="light"]').classList.toggle('hidden', next === 'dark');
        this.querySelector('[data-theme-icon="dark"]').classList.toggle('hidden', next !== 'dark');
    });
</script>
