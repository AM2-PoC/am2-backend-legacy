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

?>
<?php
$pageTitle = t('dash.heading');
$pageLede  = t('dash.lede');
$scopeNote = $admin_role === 'superadmin' ? t('dash.scope_all') : t('dash.scope_branch');

$stats = [
    ['dash.total_users', $total_user,    $scopeNote],
    ['dash.online_now',  $user_online,   null],
    ['dash.channels',    $total_channel, $scopeNote],
];

include 'partials/head.php';
include 'partials/shell.php';
?>

<section class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
    <?php foreach ($stats as $i => [$labelKey, $value, $note]): ?>
        <article class="rounded-card border border-edge bg-card p-5">
            <p class="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-subtle">
                <?= e($labelKey) ?>
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
        </article>
    <?php endforeach; ?>
</section>

<section class="mt-6 rounded-card border border-edge bg-card">
    <div class="flex items-center justify-between border-b border-edge px-5 py-4">
        <div>
            <h2 class="text-sm font-semibold"><?= e('dash.traffic') ?></h2>
            <p class="mt-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                <span id="liveClock">--:--:--</span> WIB
            </p>
        </div>
        <!-- Shown only while a refresh is in flight, so the page says when it is
             working rather than silently changing under the reader. -->
        <span id="chartSyncIcon" style="display:none"
              class="font-mono text-[10px] uppercase tracking-[0.15em] text-brand">•••</span>
    </div>
    <div class="px-5 py-5">
        <div class="h-64 sm:h-72"><canvas id="activityChart"></canvas></div>
    </div>
</section>

<?php include 'partials/shell_end.php'; ?>

<script src="<?= am2_asset('asset/js/chart.umd.min.js') ?>"></script>
<script>
    const AM2_ADMIN_ID   = <?= json_encode((string) $current_admin_id) ?>;
    const AM2_ADMIN_ROLE = <?= json_encode((string) $admin_role) ?>;

    // Read from the tokens so the chart follows the theme instead of pinning
    // its own hexes, which is what the previous version did.
    const css = (name, fallback) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

    const ctx = document.getElementById('activityChart');
    const myChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: <?= json_encode($chart_labels) ?>,
            datasets: [{
                label: <?= json_encode(t('dash.calls')) ?>,
                data: <?= json_encode(array_map('intval', $chart_values)) ?>,
                borderColor: css('--color-primary', '#f59e0b'),
                backgroundColor: 'rgba(245, 158, 11, 0.12)',
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                tension: 0.35,
                fill: true,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    displayColors: false,
                    callbacks: {
                        label: (c) => c.parsed.y + ' ' + <?= json_encode(t('dash.calls')) ?>,
                    },
                },
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: css('--color-text-subtle', '#64748b'), font: { size: 10 } },
                },
                y: {
                    beginAtZero: true,
                    grid: { color: css('--color-border', '#e2e8f0') },
                    ticks: { color: css('--color-text-subtle', '#64748b'), font: { size: 10 }, precision: 0 },
                },
            },
        },
    });

    const clock = document.getElementById('liveClock');
    setInterval(() => {
        clock.textContent = new Date().toLocaleTimeString('<?= am2_locale() === 'id' ? 'id-ID' : 'en-GB' ?>', {
            hour12: false, timeZone: 'Asia/Jakarta',
        });
    }, 1000);

    const syncIcon = document.getElementById('chartSyncIcon');
    async function refreshDashboardData() {
        syncIcon.style.display = 'inline-block';
        try {
            const res = await fetch(
                `api_dashboard_chart.php?admin_id=${AM2_ADMIN_ID}&role=${AM2_ADMIN_ROLE}`);
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
    setInterval(refreshDashboardData, 10000);
</script>
</body>
</html>
