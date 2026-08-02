<?php
require_once 'auth.php';
date_default_timezone_set('Asia/Jakarta');

require_once 'config.php';



?>
<?php
$pageTitle = t('logs.heading');
$pageLede  = t('logs.lede');

include 'partials/head.php';
include 'partials/shell.php';
?>

<section class="rounded-card border border-edge bg-card" x-data="logConsole()" x-init="start()">

    <div class="flex flex-wrap items-center gap-3 border-b border-edge px-4 py-3 lg:px-5">
        <!-- Category first: it narrows the set, and search then works within it. -->
        <div class="flex gap-1.5" role="group" aria-label="<?= e('logs.filter') ?>">
            <?php foreach ([['ALL', 'btn-all', 'logs.all'], ['PTT', 'btn-ptt', 'logs.ptt'], ['ADM', 'btn-adm', 'logs.adm']] as [$cat, $id, $key]): ?>
                <button type="button" id="<?= $id ?>" @click="category = '<?= $cat ?>'"
                        :aria-pressed="category === '<?= $cat ?>' ? 'true' : 'false'"
                        class="filter-btn rounded-control border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors"
                        :class="category === '<?= $cat ?>'
                            ? 'border-brand bg-brand/10 text-brand'
                            : 'border-edge text-ink-subtle hover:border-edge-strong hover:text-ink'">
                    <?= e($key) ?>
                </button>
            <?php endforeach; ?>
        </div>

        <div class="relative min-w-0 flex-1 sm:max-w-xs">
            <input id="logSearchInput" x-model="query" type="search" autocomplete="off"
                   class="w-full rounded-control border border-edge bg-card px-3 py-1.5 text-sm text-ink
                          transition-colors hover:border-edge-strong focus:border-brand focus:outline-none"
                   placeholder="<?= e('logs.search') ?>">
        </div>

        <p class="ml-auto flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
            <span id="loading-indicator" x-show="loading" x-cloak class="text-brand">•••</span>
            <span x-show="stale" x-cloak class="text-warn"><?= e('rail.stale') ?></span>
            <span><?= e('logs.updated') ?> <span id="last-update-time" x-text="updatedAt">--:--:--</span></span>
        </p>
    </div>

    <div class="overflow-x-auto">
        <table class="data-table w-full text-sm">
            <thead>
                <tr class="border-b border-edge text-left font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                    <th scope="col" class="px-4 py-2.5 font-normal lg:px-5"><?= e('logs.time') ?></th>
                    <th scope="col" class="px-4 py-2.5 font-normal"><?= e('logs.event') ?></th>
                    <th scope="col" class="px-4 py-2.5 font-normal"><?= e('logs.detail') ?></th>
                    <th scope="col" class="px-4 py-2.5 font-normal"><?= e('logs.actor') ?></th>
                </tr>
            </thead>
            <tbody id="log-table-body" class="divide-y divide-edge">
                <template x-for="row in visible" :key="row.key">
                    <tr class="transition-colors hover:bg-card-muted">
                        <td data-label="<?= e('logs.time') ?>" class="px-4 py-2 align-top lg:px-5">
                            <span class="block font-mono text-xs tabular-nums" x-text="row.jam"></span>
                            <span class="block font-mono text-[10px] text-ink-subtle" x-text="row.tanggal"></span>
                        </td>
                        <td data-label="<?= e('logs.event') ?>" class="px-4 py-2 align-top">
                            <span class="inline-block rounded-control px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em]"
                                  :class="badge(row)" x-text="label(row)"></span>
                        </td>
                        <td data-label="<?= e('logs.detail') ?>" class="px-4 py-2 align-top">
                            <!-- x-text, not innerHTML. keterangan is free text an
                                 admin typed and a database trigger writes. -->
                            <span x-text="row.target"></span>
                        </td>
                        <td data-label="<?= e('logs.actor') ?>" class="px-4 py-2 align-top">
                            <span class="block truncate" x-text="row.pelaksana"></span>
                            <span class="block font-mono text-[10px] text-ink-subtle" x-text="row.pelaksana_id"></span>
                        </td>
                    </tr>
                </template>
            </tbody>
        </table>
    </div>

    <p x-show="visible.length === 0" x-cloak class="px-5 py-10 text-center text-sm text-ink-muted">
        <span x-show="query"><?= e('logs.no_match') ?></span>
        <span x-show="!query"><?= e('logs.empty') ?></span>
    </p>
</section>

<?php include 'partials/shell_end.php'; ?>

<script>
    function logConsole() {
        return {
            rows: [], query: '', category: 'ALL',
            loading: false, stale: false, updatedAt: '--:--:--',

            start() {
                this.tick();
                // Four seconds, as before. A dispatch log is read while it moves.
                setInterval(() => this.tick(), 4000);
            },

            async tick() {
                this.loading = true;
                try {
                    const res = await fetch('fetch_logs.php', { headers: { Accept: 'application/json' } });
                    if (!res.ok) throw new Error(res.status);
                    const data = await res.json();
                    if (data.error) throw new Error(data.error);
                    this.rows = [...(data.ptt ?? []), ...(data.adm ?? [])]
                        .sort((a, b) => String(b.raw_time).localeCompare(String(a.raw_time)))
                        .map((r) => ({ ...r, key: r.kategori + ':' + r.id }));
                    this.updatedAt = new Date().toLocaleTimeString('<?= am2_locale() === 'id' ? 'id-ID' : 'en-GB' ?>',
                        { hour12: false, timeZone: 'Asia/Jakarta' });
                    this.stale = false;
                } catch {
                    // Keep the rows on screen but say they are no longer current.
                    this.stale = true;
                } finally {
                    this.loading = false;
                }
            },

            get visible() {
                const q = this.query.trim().toLowerCase();
                return this.rows.filter((r) => {
                    if (this.category !== 'ALL' && r.kategori !== this.category) return false;
                    if (!q) return true;
                    // Searches the fields, not the rendered text: the old version
                    // matched on row.innerText, so a change of column count
                    // silently changed what a search found.
                    return [r.target, r.pelaksana, r.pelaksana_id, r.aksi]
                        .some((v) => String(v ?? '').toLowerCase().includes(q));
                }).slice(0, 100);
            },

            label(row) {
                const t = String(row.aksi ?? '').toUpperCase();
                if (['PUSH', 'PUSH_PRIVATE'].includes(t)) return 'TX';
                if (['RELEASE', 'RELEASE_PRIVATE'].includes(t)) return 'RX';
                if (t === 'LOGIN') return <?= json_encode(t('logs.badge_login')) ?>;
                if (t === 'LOGOUT' || t === 'FORCE_LOGOUT') return <?= json_encode(t('logs.badge_logout')) ?>;
                // Admin actions have long names. Truncating them produced
                // "UPDATE_FEATU", which reads as a rendering fault rather than
                // as a label.
                const ADM = <?= json_encode([
                    'CREATE_USER'   => t('logs.badge_create'),
                    'UPDATE_USER'   => t('logs.badge_update'),
                    'DELETE_USER'   => t('logs.badge_delete'),
                    'UPDATE_FEATURE'=> t('logs.badge_feature'),
                    'UPDATE_ACCESS' => t('logs.badge_access'),
                    'CREATE'        => t('logs.badge_create'),
                    'UPDATE'        => t('logs.badge_update'),
                    'DELETE'        => t('logs.badge_delete'),
                ]) ?>;
                return ADM[t] ?? t.slice(0, 10);
            },

            badge(row) {
                const t = String(row.aksi ?? '').toUpperCase();
                if (['PUSH', 'PUSH_PRIVATE'].includes(t)) return 'bg-bad/10 text-bad';
                if (t === 'LOGIN') return 'bg-ok/10 text-ok';
                if (t === 'FORCE_LOGOUT') return 'bg-warn/10 text-warn';
                if (row.kategori === 'ADM') return 'bg-accent/10 text-accent';
                return 'bg-card-muted text-ink-subtle';
            },
        };
    }
</script>
</body>
</html>
