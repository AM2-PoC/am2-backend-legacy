<?php
require_once 'auth.php';
require_once 'config.php';



$current_admin_id = $_SESSION['admin_id'];
$admin_role = $_SESSION['admin_role'];

try {
    if ($admin_role === 'superadmin') {
        $total_user = $pdo->query("SELECT COUNT(*) FROM public.users")->fetchColumn() ?: 0;
        $user_online = $pdo->query("SELECT COUNT(*) FROM public.users WHERE status = 'online'")->fetchColumn() ?: 0;
        $total_channel = $pdo->query("SELECT COUNT(*) FROM public.channels")->fetchColumn() ?: 0;
        $stmt_ptt = $pdo->query("
            SELECT COUNT(*) as total, TO_CHAR(event_time, 'HH24:00') as jam 
            FROM public.ptt_logs 
            WHERE event_time > NOW() - INTERVAL '24 hours'
            GROUP BY jam ORDER BY jam ASC LIMIT 7
        ");
    } else {
        $stmt = $pdo->prepare("SELECT COUNT(*) FROM public.users WHERE admin_id = ?");
        $stmt->execute([$current_admin_id]);
        $total_user = $stmt->fetchColumn() ?: 0;

        $stmt = $pdo->prepare("SELECT COUNT(*) FROM public.users WHERE admin_id = ? AND status = 'online'");
        $stmt->execute([$current_admin_id]);
        $user_online = $stmt->fetchColumn() ?: 0;

        $stmt = $pdo->prepare("
            SELECT COUNT(DISTINCT c.id) 
            FROM public.channels c
            LEFT JOIN public.admin_managed_channels amc ON c.id = amc.channel_id
            WHERE c.created_by = ? OR amc.admin_id = ?
        ");
        $stmt->execute([$current_admin_id, $current_admin_id]);
        $total_channel = $stmt->fetchColumn() ?: 0;

        $stmt_ptt = $pdo->prepare("
            SELECT COUNT(*) as total, TO_CHAR(l.event_time, 'HH24:00') as jam 
            FROM public.ptt_logs l
            JOIN public.users u ON l.user_id = u.id
            WHERE u.admin_id = ? AND l.event_time > NOW() - INTERVAL '24 hours'
            GROUP BY jam ORDER BY jam ASC LIMIT 7
        ");
        $stmt_ptt->execute([$current_admin_id]);
    }

    $ptt_activity = $stmt_ptt->fetchAll(PDO::FETCH_ASSOC);

} catch (PDOException $e) {
    die("Kesalahan Database: " . am2_safe_error($e, 'dashboard'));
}

if (empty($ptt_activity)) {
    $chart_labels = ['06:00', '09:00', '12:00', '15:00', '18:00', '21:00', 'Sekarang'];
    $chart_values = [0, 0, 0, 0, 0, 0, 0];
} else {
    $chart_labels = array_column($ptt_activity, 'jam');
    $chart_values = array_column($ptt_activity, 'total');
}


/*
 * Everything below is scoped to the signed-in admin unless they are a
 * superadmin. Both joins have to be scoped, not just the obvious one: a channel
 * is shared, so counting its ptt_logs without restricting whose logs they are
 * shows one branch another branch's traffic. That is the same mistake the
 * dashboard chart was shipping.
 */
$isSuper = $admin_role === 'superadmin';

try {
    // PUSH is a transmission starting and RELEASE is the same one ending, so
    // counting both would double every call.
    if ($isSuper) {
        $stmt = $pdo->query("
            SELECT COUNT(*) FROM public.ptt_logs
            WHERE event_type IN ('PUSH', 'PUSH_PRIVATE')
              AND event_time > NOW() - INTERVAL '24 hours'");
    } else {
        $stmt = $pdo->prepare("
            SELECT COUNT(*) FROM public.ptt_logs l
            JOIN public.users u ON l.user_id = u.id
            WHERE l.event_type IN ('PUSH', 'PUSH_PRIVATE')
              AND l.event_time > NOW() - INTERVAL '24 hours'
              AND u.admin_id = ?");
        $stmt->execute([$current_admin_id]);
    }
    $calls_24h = (int) $stmt->fetchColumn();

    // Where the traffic actually is: units on each channel now, and the calls
    // that channel carried today.
    //
    // Correlated subqueries rather than joins. Joining ptt_logs and counting
    // DISTINCT over the result took 16 seconds against 55k rows, because the
    // time filter could not be applied until after the join. Here it narrows
    // first, and idx_ptt_logs_channel_time makes it an index scan.
    if ($isSuper) {
        $stmt = $pdo->query("
            SELECT c.id, c.display_name,
              (SELECT COUNT(*) FROM public.users u
                 WHERE u.last_channel_id = c.id AND u.status = 'online') AS online_now,
              (SELECT COUNT(*) FROM public.ptt_logs l
                 WHERE l.channel_id = c.id
                   AND l.event_type IN ('PUSH','PUSH_PRIVATE')
                   AND l.event_time > NOW() - INTERVAL '24 hours') AS calls_24h
            FROM public.channels c
            ORDER BY calls_24h DESC, online_now DESC, c.display_name ASC
            LIMIT 6");
    } else {
        $stmt = $pdo->prepare("
            SELECT c.id, c.display_name,
              (SELECT COUNT(*) FROM public.users u
                 WHERE u.last_channel_id = c.id AND u.status = 'online'
                   AND u.admin_id = :aid) AS online_now,
              (SELECT COUNT(*) FROM public.ptt_logs l
                 JOIN public.users lu ON lu.id = l.user_id
                 WHERE l.channel_id = c.id
                   AND l.event_type IN ('PUSH','PUSH_PRIVATE')
                   AND l.event_time > NOW() - INTERVAL '24 hours'
                   AND lu.admin_id = :aid) AS calls_24h
            FROM public.channels c
            ORDER BY calls_24h DESC, online_now DESC, c.display_name ASC
            LIMIT 6");
        $stmt->execute(['aid' => $current_admin_id]);
    }
    $channel_rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    // Units that cannot sign in at all. server.js refuses app_login unless the
    // user has a last_channel_id AND a matching user_channels row, answering
    // "Admin belum menentukan Channel Default". Nothing in the panel showed
    // which users are in that state, so it surfaced only as a support call.
    if ($isSuper) {
        $stmt = $pdo->query("
            SELECT u.id, u.name FROM public.users u
            WHERE u.role = 'user'
              AND (u.last_channel_id IS NULL
                   OR NOT EXISTS (SELECT 1 FROM public.user_channels uc
                                  WHERE uc.user_id = u.id AND uc.channel_id = u.last_channel_id))
            ORDER BY u.name LIMIT 8");
    } else {
        $stmt = $pdo->prepare("
            SELECT u.id, u.name FROM public.users u
            WHERE u.role = 'user' AND u.admin_id = ?
              AND (u.last_channel_id IS NULL
                   OR NOT EXISTS (SELECT 1 FROM public.user_channels uc
                                  WHERE uc.user_id = u.id AND uc.channel_id = u.last_channel_id))
            ORDER BY u.name LIMIT 8");
        $stmt->execute([$current_admin_id]);
    }
    $stranded = $stmt->fetchAll(PDO::FETCH_ASSOC);

    // Branch admins whose access is about to lapse. When it does, server.js
    // force-logs-out every one of their units.
    $expiring = [];
    if ($isSuper) {
        $expiring = $pdo->query("
            SELECT username, expired_at,
                   (expired_at - CURRENT_DATE) AS days_left
            FROM public.admin
            WHERE role <> 'superadmin' AND expired_at IS NOT NULL
              AND expired_at <= CURRENT_DATE + INTERVAL '30 days'
            ORDER BY expired_at ASC LIMIT 5")->fetchAll(PDO::FETCH_ASSOC);
    }

    // Quota applies to branch admins only; a superadmin has none.
    $quota = null;
    if (!$isSuper) {
        $stmt = $pdo->prepare("SELECT user_quota, channel_quota FROM public.admin WHERE id = ?");
        $stmt->execute([$current_admin_id]);
        $q = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];

        $stmt = $pdo->prepare("SELECT COUNT(*) FROM public.channels WHERE created_by = ?");
        $stmt->execute([$current_admin_id]);

        $quota = [
            'users_used'    => (int) $total_user,
            'users_max'     => (int) ($q['user_quota'] ?? 0),
            'channels_used' => (int) $stmt->fetchColumn(),
            'channels_max'  => (int) ($q['channel_quota'] ?? 0),
        ];
    }
} catch (PDOException $e) {
    // A broken extra must not take the whole dashboard down with it.
    $calls_24h = 0;
    $channel_rows = [];
    $quota = null;
    $stranded = [];
    $expiring = [];
    error_log('AM2 dashboard extras failed: ' . $e->getMessage());
}
?>
<?php
$pageTitle = t('dash.heading');
$pageLede  = t('dash.lede');
$scopeNote = $admin_role === 'superadmin' ? t('dash.scope_all') : t('dash.scope_branch');

include 'partials/head.php';
include 'partials/shell.php';
?>

<!-- Each figure links to the page that acts on it. A number you cannot follow
     is a number you cannot use. -->
<section class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
    <?php
    $cards = [
        ['dash.total_users', $total_user,    'users.php',     $scopeNote],
        ['dash.online_now',  $user_online,   'livetrack.php', null],
        ['dash.channels',    $total_channel, 'channels.php',  $scopeNote],
        ['dash.calls_24h',   $calls_24h,     'logs.php',      t('dash.calls_note')],
    ];
    foreach ($cards as [$labelKey, $value, $href, $note]): ?>
        <a href="<?= $href ?>"
           class="group rounded-card border border-edge bg-card p-5 no-underline! text-ink!
                  transition-colors hover:border-brand/50 hover:bg-card-muted">
            <p class="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-ink-subtle">
                <span><?= e($labelKey) ?></span>
                <span aria-hidden="true" class="opacity-0 transition-opacity group-hover:opacity-100">&rarr;</span>
            </p>
            <p class="mt-3 flex items-baseline gap-2">
                <span class="font-mono text-4xl font-semibold leading-none tabular-nums">
                    <?= number_format((int) $value) ?>
                </span>
                <?php if ($labelKey === 'dash.online_now'): ?>
                    <span class="h-2 w-2 rounded-full <?= $user_online > 0 ? 'bg-ok' : 'bg-edge-strong' ?>"
                          aria-hidden="true"></span>
                <?php endif; ?>
            </p>
            <?php if ($note !== null): ?>
                <p class="mt-2 text-xs text-ink-muted"><?= htmlspecialchars($note) ?></p>
            <?php endif; ?>
        </a>
    <?php endforeach; ?>
</section>

<?php if ($quota !== null): ?>
<section class="mt-6 rounded-card border border-edge bg-card p-5">
    <h2 class="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-subtle"><?= e('dash.quota') ?></h2>
    <div class="mt-4 grid gap-5 sm:grid-cols-2">
        <?php foreach ([
            ['dash.quota_users', $quota['users_used'], $quota['users_max']],
            ['dash.quota_channels', $quota['channels_used'], $quota['channels_max']],
        ] as [$labelKey, $used, $max]):
            $pct = $max > 0 ? min(100, (int) round($used / $max * 100)) : 0;
            // Amber past three quarters, red when full: the point is to warn
            // before the branch is blocked from adding anyone.
            $bar = $pct >= 100 ? 'bg-bad' : ($pct >= 75 ? 'bg-warn' : 'bg-brand');
        ?>
            <div>
                <p class="flex items-baseline justify-between text-sm">
                    <span><?= e($labelKey) ?></span>
                    <span class="font-mono tabular-nums text-ink-muted">
                        <?= number_format($used) ?><span class="text-ink-subtle">/<?= $max > 0 ? number_format($max) : '∞' ?></span>
                    </span>
                </p>
                <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-card-muted"
                     role="progressbar" aria-valuenow="<?= $pct ?>" aria-valuemin="0" aria-valuemax="100">
                    <div class="h-full rounded-full <?= $bar ?>" style="width: <?= $pct ?>%"></div>
                </div>
            </div>
        <?php endforeach; ?>
    </div>
</section>
<?php endif; ?>

<div class="mt-6 grid gap-6 xl:grid-cols-[1.6fr_1fr]">

    <section class="rounded-card border border-edge bg-card" x-data="chartRange()">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-edge px-5 py-4">
            <div>
                <h2 class="text-sm font-semibold"><?= e('dash.traffic') ?></h2>
                <p class="mt-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                    <span id="liveClock">--:--:--</span> WIB
                    <span id="chartSyncIcon" style="display:none" class="ml-2 text-brand">•••</span>
                </p>
            </div>
            <div class="flex gap-1.5">
                <?php foreach ([['24h', 'dash.range_24h'], ['7d', 'dash.range_7d']] as [$val, $key]): ?>
                    <button type="button" @click="select('<?= $val ?>')"
                            :aria-pressed="range === '<?= $val ?>' ? 'true' : 'false'"
                            class="rounded-control border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors"
                            :class="range === '<?= $val ?>'
                                ? 'border-brand bg-brand/10 text-brand'
                                : 'border-edge text-ink-subtle hover:border-edge-strong hover:text-ink'">
                        <?= e($key) ?>
                    </button>
                <?php endforeach; ?>
            </div>
        </div>
        <div class="px-5 py-5">
            <div class="h-64 sm:h-72"><canvas id="activityChart"></canvas></div>
        </div>
    </section>

    <section class="rounded-card border border-edge bg-card">
        <div class="border-b border-edge px-5 py-4">
            <h2 class="text-sm font-semibold"><?= e('dash.channel_activity') ?></h2>
            <p class="mt-0.5 text-xs text-ink-muted"><?= e('dash.channel_activity_note') ?></p>
        </div>
        <?php if (empty($channel_rows)): ?>
            <p class="px-5 py-8 text-center text-sm text-ink-muted"><?= e('dash.no_channels') ?></p>
        <?php else: ?>
            <ul class="divide-y divide-edge">
                <?php foreach ($channel_rows as $ch): ?>
                    <li class="flex items-center gap-3 px-5 py-3">
                        <span class="h-1.5 w-1.5 shrink-0 rounded-full <?= (int) $ch['online_now'] > 0 ? 'bg-ok' : 'bg-edge-strong' ?>"
                              aria-hidden="true"></span>
                        <span class="min-w-0 flex-1 truncate text-sm"><?= htmlspecialchars($ch['display_name']) ?></span>
                        <span class="shrink-0 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                            <span class="tabular-nums text-ink-muted"><?= (int) $ch['online_now'] ?></span> <?= e('rail.online') ?>
                        </span>
                        <span class="w-16 shrink-0 text-right font-mono text-sm tabular-nums"><?= number_format((int) $ch['calls_24h']) ?></span>
                    </li>
                <?php endforeach; ?>
            </ul>
        <?php endif; ?>
    </section>
</div>

<section class="mt-6 grid gap-6 xl:grid-cols-2">

    <div class="rounded-card border border-edge bg-card">
        <div class="flex items-baseline justify-between border-b border-edge px-5 py-4">
            <h2 class="text-sm font-semibold"><?= e('dash.stranded') ?></h2>
            <span class="font-mono text-xs tabular-nums <?= empty($stranded) ? 'text-ink-subtle' : 'text-warn' ?>">
                <?= count($stranded) ?>
            </span>
        </div>
        <p class="px-5 pt-3 text-xs text-ink-muted"><?= e('dash.stranded_note') ?></p>
        <?php if (empty($stranded)): ?>
            <p class="px-5 py-6 text-sm text-ink-muted"><?= e('dash.stranded_none') ?></p>
        <?php else: ?>
            <ul class="mt-2 divide-y divide-edge">
                <?php foreach ($stranded as $u): ?>
                    <li class="flex items-center gap-3 px-5 py-2.5">
                        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true"></span>
                        <span class="min-w-0 flex-1 truncate text-sm"><?= htmlspecialchars($u['name']) ?></span>
                        <span class="shrink-0 font-mono text-[11px] text-ink-subtle"><?= htmlspecialchars($u['id']) ?></span>
                        <a href="user_access.php?search=<?= urlencode($u['id']) ?>"
                           class="shrink-0 font-mono text-[10px] uppercase tracking-[0.15em] text-brand! no-underline! hover:underline!">
                            <?= e('dash.fix') ?>
                        </a>
                    </li>
                <?php endforeach; ?>
            </ul>
        <?php endif; ?>
    </div>

    <?php if ($isSuper): ?>
    <div class="rounded-card border border-edge bg-card">
        <div class="flex items-baseline justify-between border-b border-edge px-5 py-4">
            <h2 class="text-sm font-semibold"><?= e('dash.expiring') ?></h2>
            <span class="font-mono text-xs tabular-nums <?= empty($expiring) ? 'text-ink-subtle' : 'text-warn' ?>">
                <?= count($expiring) ?>
            </span>
        </div>
        <p class="px-5 pt-3 text-xs text-ink-muted"><?= e('dash.expiring_note') ?></p>
        <?php if (empty($expiring)): ?>
            <p class="px-5 py-6 text-sm text-ink-muted"><?= e('dash.expiring_none') ?></p>
        <?php else: ?>
            <ul class="mt-2 divide-y divide-edge">
                <?php foreach ($expiring as $a): $d = (int) $a['days_left']; ?>
                    <li class="flex items-center gap-3 px-5 py-2.5">
                        <span class="h-1.5 w-1.5 shrink-0 rounded-full <?= $d <= 7 ? 'bg-bad' : 'bg-warn' ?>" aria-hidden="true"></span>
                        <span class="min-w-0 flex-1 truncate text-sm"><?= htmlspecialchars($a['username']) ?></span>
                        <span class="shrink-0 font-mono text-[11px] tabular-nums <?= $d <= 7 ? 'text-bad' : 'text-ink-subtle' ?>">
                            <?= $d < 0 ? e('dash.expired') : $d . ' ' . t('dash.days') ?>
                        </span>
                    </li>
                <?php endforeach; ?>
            </ul>
        <?php endif; ?>
    </div>
    <?php endif; ?>
</section>

<?php include "partials/shell_end.php"; ?>

<script src="<?= am2_asset('asset/js/chart.umd.min.js') ?>"></script>
<script>
    const AM2_ADMIN_ID   = <?= json_encode((string) $current_admin_id) ?>;
    const AM2_ADMIN_ROLE = <?= json_encode((string) $admin_role) ?>;
    const AM2_CALLS      = <?= json_encode(t('dash.calls')) ?>;

    // Read from the tokens so the chart follows the theme instead of pinning
    // its own hexes, which is what the previous version did.
    const css = (name, fallback) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

    const myChart = new Chart(document.getElementById('activityChart'), {
        type: 'line',
        data: {
            labels: <?= json_encode($chart_labels) ?>,
            datasets: [{
                label: AM2_CALLS,
                data: <?= json_encode(array_map('intval', $chart_values)) ?>,
                borderColor: css('--color-primary', '#f59e0b'),
                backgroundColor: 'rgba(245, 158, 11, 0.12)',
                borderWidth: 2, pointRadius: 0, pointHoverRadius: 4,
                tension: 0.35, fill: true,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: { displayColors: false, callbacks: { label: (c) => c.parsed.y + ' ' + AM2_CALLS } },
            },
            scales: {
                x: { grid: { display: false },
                     ticks: { color: css('--color-text-subtle', '#64748b'), font: { size: 10 } } },
                y: { beginAtZero: true,
                     grid: { color: css('--color-border', '#e2e8f0') },
                     ticks: { color: css('--color-text-subtle', '#64748b'), font: { size: 10 }, precision: 0 } },
            },
        },
    });

    const syncIcon = document.getElementById('chartSyncIcon');

    async function loadChart(range) {
        syncIcon.style.display = 'inline';
        try {
            const res = await fetch(
                `api_dashboard_chart.php?admin_id=${AM2_ADMIN_ID}&role=${AM2_ADMIN_ROLE}&range=${range}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            myChart.data.labels = data.labels;
            myChart.data.datasets[0].data = data.values;
            myChart.update('none');
        } catch (err) {
            console.error('Dashboard refresh failed:', err);
        } finally {
            setTimeout(() => { syncIcon.style.display = 'none'; }, 800);
        }
    }

    function chartRange() {
        return {
            range: '24h',
            select(r) {
                if (this.range === r) return;
                this.range = r;
                loadChart(r);
            },
            init() {
                // Only the 24h view refreshes on a timer. A week does not change
                // every ten seconds, and reloading it would fight the reader.
                setInterval(() => { if (this.range === '24h') loadChart('24h'); }, 10000);
            },
        };
    }

    /** The last few things that happened, from the endpoint the log page uses. */
    function activityFeed() {
        return {
            rows: [], stale: false,
            start() { this.tick(); setInterval(() => this.tick(), 8000); },
            async tick() {
                try {
                    const res = await fetch('fetch_logs.php', { headers: { Accept: 'application/json' } });
                    if (!res.ok) throw new Error(res.status);
                    const data = await res.json();
                    if (data.error) throw new Error(data.error);
                    this.rows = [...(data.ptt ?? []), ...(data.adm ?? [])]
                        .sort((a, b) => String(b.raw_time).localeCompare(String(a.raw_time)))
                        .slice(0, 8)
                        .map((r) => ({ ...r, key: r.kategori + ':' + r.id }));
                    this.stale = false;
                } catch {
                    // Say it is stale rather than leave old rows looking live.
                    this.stale = true;
                }
            },
        };
    }

    const clock = document.getElementById('liveClock');
    setInterval(() => {
        clock.textContent = new Date().toLocaleTimeString('<?= am2_locale() === 'id' ? 'id-ID' : 'en-GB' ?>', {
            hour12: false, timeZone: 'Asia/Jakarta',
        });
    }, 1000);
</script>
</body>
</html>
