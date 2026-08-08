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

    /**
     * Seven days of growth for the two counts that have a creation date.
     *
     * Cumulative rather than per-day, because the card shows a total: the line
     * has to end where the number is. Both are correlated subqueries over a
     * generated date series -- 1.9ms and 0.3ms measured on the production copy,
     * against the 16 seconds a LEFT JOIN over ptt_logs used to cost here.
     *
     * Online has no series and gets none. Nothing records how many units were
     * connected an hour ago, and drawing something that looks like history
     * where there is none is worse than an empty space.
     */
    $days = "SELECT generate_series(CURRENT_DATE - 6, CURRENT_DATE, '1 day')::date AS day";

    if ($admin_role === 'superadmin') {  // $isSuper is not assigned until later
        $series_users = $pdo->query(
            "WITH d AS ($days)
             SELECT (SELECT COUNT(*) FROM public.users u
                      WHERE u.created_at::date <= d.day) AS n
             FROM d ORDER BY d.day"
        )->fetchAll(PDO::FETCH_COLUMN);

        $series_channels = $pdo->query(
            "WITH d AS ($days)
             SELECT (SELECT COUNT(*) FROM public.channels c
                      WHERE c.created_at::date <= d.day) AS n
             FROM d ORDER BY d.day"
        )->fetchAll(PDO::FETCH_COLUMN);
    } else {
        $stmt = $pdo->prepare(
            "WITH d AS ($days)
             SELECT (SELECT COUNT(*) FROM public.users u
                      WHERE u.admin_id = :aid AND u.created_at::date <= d.day) AS n
             FROM d ORDER BY d.day"
        );
        $stmt->execute(['aid' => $current_admin_id]);
        $series_users = $stmt->fetchAll(PDO::FETCH_COLUMN);

        $stmt = $pdo->prepare(
            "WITH d AS ($days)
             SELECT (SELECT COUNT(DISTINCT c.id) FROM public.channels c
                       LEFT JOIN public.admin_managed_channels amc
                              ON c.id = amc.channel_id
                      WHERE (c.created_by = :aid OR amc.admin_id = :aid2)
                        AND c.created_at::date <= d.day) AS n
             FROM d ORDER BY d.day"
        );
        $stmt->execute(['aid' => $current_admin_id, 'aid2' => $current_admin_id]);
        $series_channels = $stmt->fetchAll(PDO::FETCH_COLUMN);
    }


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
<?php
/**
 * Priority order, top to bottom: what is broken, then what is happening, then
 * what it looked like. The chart moved below the attention queue -- a chart is
 * context, and eight units that cannot sign in is a job.
 *
 * A sparkline is drawn only where a real series already exists. Calls have one
 * ($chart_values); total units and channels do not, and inventing a query to
 * manufacture one would be backend work this release does not do.
 */
$freshness = date('H.i');

/** A polyline over whatever series a card actually has. */
function am2_sparkline(array $values, string $class = 'text-brand'): string
{
    $values = array_map('intval', $values);
    if (count($values) < 2) {
        return '';
    }
    $max = max($values) ?: 1;
    $step = 100 / (count($values) - 1);
    $points = [];
    foreach ($values as $i => $v) {
        $points[] = round($i * $step, 2) . ',' . round(28 - ($v / $max) * 26, 2);
    }
    return '<svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"'
         . ' class="mt-3 h-7 w-full ' . $class . '">'
         . '<polyline fill="none" stroke="currentColor" stroke-width="1.5"'
         . ' stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"'
         . ' points="' . implode(' ', $points) . '"/></svg>';
}

/**
 * The change across a series, as a signed count and a percentage.
 *
 * Arithmetic on the seven cumulative daily counts each card already carries --
 * no second query, and nothing new to keep in step with the number above it.
 *
 * Returns null rather than a zero when there is nothing to say: a card
 * reporting "0%" every day is noise, and a single data point has no direction
 * at all. A card without a series simply does not get one.
 */
function am2_delta(?array $series): ?array
{
    if (!$series || count($series) < 2) {
        return null;
    }
    $values = array_map('intval', array_values($series));
    $first = $values[0];
    $last  = $values[count($values) - 1];
    $change = $last - $first;
    if ($change === 0) {
        return null;
    }
    // Against a starting zero any growth is infinite, so the percentage is
    // withheld and the count speaks for itself.
    $percent = $first > 0 ? (int) round($change / $first * 100) : null;

    // A single unit added to a fleet of 219 rounds to 0%, and "↑ 0%" is a
    // contradiction on the face of the card. Below a whole percent the count is
    // the honest figure -- it is also the smaller number, which is the one that
    // fits.
    if ($percent === 0) {
        $percent = null;
    }
    return ['change' => $change, 'percent' => $percent, 'up' => $change > 0];
}

$cards = [
    ['key' => 'dash.total_users', 'value' => $total_user, 'href' => 'users.php',
     'context' => count($stranded) > 0
         ? t('dash.ctx_stranded', ['n' => count($stranded)])
         : $scopeNote,
     'tone' => count($stranded) > 0 ? 'warn' : 'muted', 'series' => $series_users],

    ['key' => 'dash.online_now', 'value' => $user_online, 'href' => 'livetrack.php',
     'context' => $total_user > 0
         ? t('dash.ctx_share', ['p' => round($user_online / $total_user * 100)])
         : null,
     'tone' => 'muted', 'series' => null, 'live' => true],

    ['key' => 'dash.channels', 'value' => $total_channel, 'href' => 'channels.php',
     'context' => $scopeNote, 'tone' => 'muted', 'series' => $series_channels],

    ['key' => 'dash.calls_24h', 'value' => $calls_24h, 'href' => 'logs.php',
     'context' => t('dash.calls_note'), 'tone' => 'muted', 'series' => $chart_values],
];
?>

<!--
    Metric cards. Preline card composition:
    https://preline.co/docs/card.html
    Every one of these links somewhere, so every one carries the affordance --
    the arrow and the border change. A card that did not link would get neither.

    Four columns from lg, not xl. The band between 1024 and 1279px was the one
    place these stayed two-up, and with a 272px rail the content budget there is
    already wide enough for four -- so half the row was empty card while the
    reader scrolled to find the fourth metric.
-->
<section class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
    <?php foreach ($cards as $c): ?>
        <a href="<?= $c['href'] ?>" data-kpi
           class="am2-surface am2-surface-accent am2-clickable group flex flex-col rounded-card p-5
                  no-underline! text-ink!">
            <p class="flex items-center justify-between font-mono text-[10px] uppercase
                      tracking-[0.18em] text-ink-subtle">
                <span><?= e($c['key']) ?></span>
                <span aria-hidden="true"
                      class="opacity-0 transition-opacity duration-[var(--duration-micro)]
                             group-hover:opacity-100">&rarr;</span>
            </p>

            <p class="mt-3 flex items-baseline gap-2">
                <span class="font-mono text-4xl font-semibold leading-none tabular-nums"
                      data-metric="<?= htmlspecialchars($c['key']) ?>"
                      data-am2-value="<?= (int) $c['value'] ?>">
                    <?= number_format((int) $c['value']) ?>
                </span>
                <?php if (!empty($c['live'])): ?>
                    <span class="h-2 w-2 rounded-full <?= $user_online > 0 ? 'bg-ok am2-live' : 'bg-edge-strong' ?>"
                          aria-hidden="true"></span>
                <?php endif; ?>

                <?php
                /*
                 * Which way the number has moved over the week the sparkline
                 * draws. Absent when the series is flat or missing, rather than
                 * printing a "0%" that says nothing on a card read every day.
                 *
                 * Growth is not good news here and a fall is not bad -- more
                 * units is a bigger fleet, fewer is decommissioning -- so the
                 * colour stays neutral and only the arrow states direction.
                 */
                $delta = am2_delta($c['series'] ?? null);
                if ($delta): ?>
                    <span class="ms-auto inline-flex items-baseline gap-1 self-center rounded-control
                                 bg-card-muted px-1.5 py-0.5 font-mono text-[10px] text-ink-muted"
                          title="<?= e('dash.delta_since') ?>">
                        <span aria-hidden="true"><?= $delta['up'] ? '↑' : '↓' ?></span>
                        <?= $delta['percent'] !== null
                            ? abs($delta['percent']) . '%'
                            : ($delta['up'] ? '+' : '−') . abs($delta['change']) ?>
                    </span>
                <?php endif; ?>
            </p>

            <?php if ($c['context']): ?>
                <p class="mt-1.5 text-xs <?= $c['tone'] === 'warn' ? 'text-warn' : 'text-ink-muted' ?>">
                    <?= htmlspecialchars($c['context']) ?>
                </p>
            <?php endif; ?>

            <?php if (!empty($c['series'])): ?>
                <?= am2_sparkline($c['series']) ?>
            <?php endif; ?>

            <!-- Freshness. A number with no time on it is a number you have to
                 trust blindly; this one says when it was true. -->
            <p class="mt-auto pt-3 font-mono text-[9px] uppercase tracking-[0.15em] text-ink-subtle">
                <span data-kpi-stale hidden class="text-warn">⚠ <?= e('state.stale_title') ?> · </span>
                <span data-kpi-time><?= $freshness ?></span> WIB
            </p>
        </a>
    <?php endforeach; ?>
</section>

<div class="mt-4 grid gap-4 lg:grid-cols-2" data-reveal>

    <!-- What is happening right now. -->
    <section class="am2-surface flex flex-col rounded-card">
        <header class="border-b border-edge px-5 py-4">
            <h2 class="text-sm font-semibold tracking-tight"><?= e('dash.channel_activity') ?></h2>
            <p class="mt-0.5 text-xs text-ink-muted"><?= e('dash.channel_activity_note') ?></p>
        </header>
        <?php if (empty($channel_rows)): ?>
            <?= am2_state('empty', t('dash.no_channels'), t('dash.no_channels_note')) ?>
        <?php else: ?>
            <ul class="divide-y divide-edge">
                <?php foreach ($channel_rows as $ch): $on = (int) $ch['online_now']; ?>
                    <li class="flex h-11 items-center gap-3 px-5">
                        <span class="h-1.5 w-1.5 shrink-0 rounded-full <?= $on > 0 ? 'bg-ok' : 'bg-edge-strong' ?>"
                              aria-hidden="true"></span>
                        <span class="min-w-0 flex-1 truncate text-sm"><?= htmlspecialchars($ch['display_name']) ?></span>
                        <span class="shrink-0 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                            <?= $on ?> <?= e('rail.online') ?>
                        </span>
                        <span class="w-16 shrink-0 text-right font-mono text-sm tabular-nums">
                            <?= number_format((int) $ch['calls_24h']) ?>
                        </span>
                    </li>
                <?php endforeach; ?>
            </ul>
        <?php endif; ?>
    </section>

    <!-- What needs doing. Above the chart on purpose. -->
    <section class="am2-surface flex flex-col rounded-card">
        <header class="flex items-center justify-between border-b border-edge px-5 py-4">
            <div>
                <h2 class="text-sm font-semibold tracking-tight"><?= e('dash.stranded') ?></h2>
                <p class="mt-0.5 text-xs text-ink-muted"><?= e('dash.stranded_note') ?></p>
            </div>
            <?php if (!empty($stranded)): ?>
                <span class="shrink-0 rounded-control bg-warn/10 px-2 py-1 font-mono text-[11px]
                             font-semibold text-warn"><?= count($stranded) ?></span>
            <?php endif; ?>
        </header>
        <?php if (empty($stranded)): ?>
            <?= am2_state('empty', t('dash.stranded_none'), t('dash.stranded_none_note')) ?>
        <?php else: ?>
            <ul class="divide-y divide-edge">
                <?php foreach ($stranded as $u): ?>
                    <li class="flex h-11 items-center gap-3 px-5">
                        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true"></span>
                        <span class="min-w-0 flex-1 truncate text-sm"><?= htmlspecialchars($u['name']) ?></span>
                        <span class="shrink-0 font-mono text-[10px] text-ink-subtle">
                            <?= htmlspecialchars($u['id']) ?>
                        </span>
                        <a href="user_access.php?search=<?= urlencode($u['id']) ?>"
                           class="shrink-0 font-mono text-[10px] uppercase tracking-[0.15em]
                                  no-underline! text-brand! hover:underline!"><?= e('dash.fix') ?></a>
                    </li>
                <?php endforeach; ?>
            </ul>
        <?php endif; ?>
    </section>
</div>

<!-- Context, not a task, so it sits last. -->
<section class="am2-surface mt-4 rounded-card" data-reveal>
    <header class="flex flex-wrap items-center justify-between gap-3 border-b border-edge px-5 py-4">
        <div>
            <h2 class="text-sm font-semibold tracking-tight"><?= e('dash.traffic') ?></h2>
            <p class="mt-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                <span id="liveClock"><?= $freshness ?></span> WIB
                <span id="chartSyncIcon" style="display:none" class="ml-2 text-brand">•••</span>
            </p>
        </div>
        <div class="flex gap-1.5" role="group" aria-label="<?= e('dash.range') ?>">
            <?php foreach ([['24h', 'dash.range_24h'], ['7d', 'dash.range_7d']] as [$r, $k]): ?>
                <button type="button" data-range="<?= $r ?>"
                        aria-pressed="<?= $r === '24h' ? 'true' : 'false' ?>"
                        class="am2-range h-11 rounded-control border px-3 font-mono text-[10px]
                               uppercase tracking-[0.15em] transition-colors
                               duration-[var(--duration-micro)]
                               <?= $r === '24h'
                                   ? 'border-brand bg-brand/10 text-brand'
                                   : 'border-edge text-ink-subtle hover:border-edge-strong hover:text-ink' ?>">
                    <?= e($k) ?>
                </button>
            <?php endforeach; ?>
        </div>
    </header>

    <div class="relative px-5 py-4">
        <!-- The canvas id is the Chart.js contract and does not change. -->
        <div id="chartWrap" class="h-64 sm:h-72"><canvas id="activityChart"></canvas></div>

        <div id="chartError" hidden class="absolute inset-0 grid place-items-center bg-card/80">
            <?= am2_state('error', t('state.error_title'), t('state.error_body'),
                          '<button type="button" id="chartRetry" class="rounded-control border border-edge px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted hover:border-brand hover:text-brand">' . e('common.retry') . '</button>') ?>
        </div>
    </div>
</section>

<?php if ($isSuper && !empty($expiring)): ?>
    <section class="am2-surface mt-4 rounded-card" data-reveal>
        <header class="border-b border-edge px-5 py-4">
            <h2 class="text-sm font-semibold tracking-tight"><?= e('dash.expiring') ?></h2>
            <p class="mt-0.5 text-xs text-ink-muted"><?= e('dash.expiring_note') ?></p>
        </header>
        <ul class="divide-y divide-edge">
            <?php foreach ($expiring as $a): $d = (int) $a['days_left']; ?>
                <li class="flex h-11 items-center gap-3 px-5">
                    <span class="h-1.5 w-1.5 shrink-0 rounded-full <?= $d <= 7 ? 'bg-bad' : 'bg-warn' ?>"
                          aria-hidden="true"></span>
                    <span class="min-w-0 flex-1 truncate text-sm"><?= htmlspecialchars($a['username']) ?></span>
                    <span class="shrink-0 font-mono text-[10px] uppercase tracking-[0.15em]
                                 <?= $d <= 7 ? 'text-bad' : 'text-warn' ?>">
                        <?= $d ?> <?= e('dash.days_left') ?>
                    </span>
                </li>
            <?php endforeach; ?>
        </ul>
    </section>
<?php endif; ?>

<?php include 'partials/shell_end.php'; ?>

<script src="<?= am2_asset('asset/js/chart.umd.min.js') ?>"></script>
<script>
(() => {
    'use strict';

    const wrap = document.getElementById('chartWrap');
    const errBox = document.getElementById('chartError');
    const sync = document.getElementById('chartSyncIcon');

    // Chart.js reads its colours from the document, so a theme change has to be
    // handed to it rather than inherited.
    const css = (n, f) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f;

    const chart = new Chart(document.getElementById('activityChart'), {
        type: 'line',
        data: {
            labels: <?= json_encode($chart_labels) ?>,
            datasets: [{
                data: <?= json_encode(array_map('intval', $chart_values)) ?>,
                borderColor: css('--color-primary', '#f59e0b'),
                backgroundColor: 'rgba(245, 158, 11, 0.12)',
                borderWidth: 2, fill: true, tension: 0.4,
                pointRadius: 0, pointHitRadius: 12,
            }],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { display: false }, ticks: { color: css('--color-text-subtle', '#64748b') } },
                y: { beginAtZero: true, ticks: { color: css('--color-text-subtle', '#64748b') } },
            },
        },
    });

    let range = '24h';

    async function loadChart(r) {
        sync.style.display = '';
        try {
            // The endpoint, its parameters and its response keys are unchanged.
            const res = await fetch(
                `api_dashboard_chart.php?admin_id=${<?= json_encode((string) $current_admin_id) ?>}` +
                `&role=${<?= json_encode((string) $admin_role) ?>}&range=${r}`);
            if (!res.ok) throw new Error(res.status);
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            chart.data.labels = data.labels;
            chart.data.datasets[0].data = data.values;
            chart.update();
            errBox.hidden = true;
            document.querySelectorAll('[data-kpi-stale]').forEach((el) => { el.hidden = true; });
            document.getElementById('liveClock').textContent =
                new Date().toLocaleTimeString('<?= am2_locale() === 'id' ? 'id-ID' : 'en-GB' ?>',
                    { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' })
                    .replace(':', '.');
        } catch {
            // Say it failed. Leaving the last good line on screen with no sign
            // that it stopped being true is the thing this replaces.
            errBox.hidden = false;
            document.querySelectorAll('[data-kpi-stale]').forEach((el) => { el.hidden = false; });
        } finally {
            sync.style.display = 'none';
        }
    }

    document.querySelectorAll('.am2-range').forEach((btn) => {
        btn.addEventListener('click', () => {
            range = btn.dataset.range;
            document.querySelectorAll('.am2-range').forEach((b) => {
                const on = b === btn;
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
                b.classList.toggle('border-brand', on);
                b.classList.toggle('bg-brand/10', on);
                b.classList.toggle('text-brand', on);
                b.classList.toggle('border-edge', !on);
                b.classList.toggle('text-ink-subtle', !on);
            });
            // The set changed; the container says so without redrawing the page.
            window.AM2?.filtered(wrap);
            loadChart(range);
        });
    });

    document.getElementById('chartRetry')?.addEventListener('click', () => loadChart(range));

    loadChart('24h');
    // Ten seconds, and only while looking at the live range.
    setInterval(() => { if (range === '24h') loadChart('24h'); }, 10000);

    window.addEventListener('load', () => {
        const AM2 = window.AM2;
        if (!AM2) return;
        // Once. Polling rewrites these numbers several times a minute and
        // replaying the entrance would make the page flicker on a timer.
        AM2.enterOnce('[data-kpi]');
        AM2.revealOnScroll('[data-reveal]');
    });
})();
</script>
</body>
</html>
