<?php
session_start();
require_once 'config.php';

if (!isset($_SESSION['admin_logged_in'])) {
    header("Location: login.php");
    exit;
}

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
    die("Kesalahan Database: " . $e->getMessage());
}

if (empty($ptt_activity)) {
    $chart_labels = ['06:00', '09:00', '12:00', '15:00', '18:00', '21:00', 'Sekarang'];
    $chart_values = [0, 0, 0, 0, 0, 0, 0];
} else {
    $chart_labels = array_column($ptt_activity, 'jam');
    $chart_values = array_column($ptt_activity, 'total');
}

?>

<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Dashboard - am²</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="asset/css/am2-ui.css">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body {
            --dashboard-bg: #eef7f8;
            --dashboard-bg-soft: #f8fbfc;
            --dashboard-panel: rgba(255, 255, 255, 0.94);
            --dashboard-line: #dbeafe;
            --dashboard-ink: #0f172a;
            --dashboard-muted: #64748b;
            --dashboard-teal: #14b8a6;
            --dashboard-teal-strong: #0f766e;
            --dashboard-indigo: #6366f1;
            --dashboard-indigo-soft: #eef2ff;
            --dashboard-success: #10b981;
            --dashboard-info: #38bdf8;
            --dashboard-chart-fill: rgba(20, 184, 166, 0.17);
            --dashboard-card-radius: 20px;
            background:
                radial-gradient(circle at 20% 6%, rgba(20, 184, 166, 0.16), transparent 24rem),
                radial-gradient(circle at 92% 0%, rgba(99, 102, 241, 0.14), transparent 22rem),
                linear-gradient(180deg, var(--dashboard-bg-soft) 0%, var(--dashboard-bg) 100%);
            color: var(--dashboard-ink);
            font-family: 'Segoe UI', sans-serif;
            overflow-x: hidden;
        }
        .main-content {
            background:
                radial-gradient(circle at 14% 8%, rgba(20, 184, 166, 0.12), transparent 24rem),
                radial-gradient(circle at 88% 0%, rgba(99, 102, 241, 0.12), transparent 22rem);
            padding: 25px;
            transition: all 0.3s;
        }
        .card-custom {
            background: var(--dashboard-panel); border-radius: var(--dashboard-card-radius) !important; padding: 25px;
            box-shadow: 0 18px 45px rgba(15, 23, 42, 0.08); border: 1px solid rgba(219, 234, 254, 0.95);
            height: 100%; position: relative; overflow: hidden;
            transition: transform 0.2s ease;
        }
        .card-custom:hover { transform: translateY(-5px); }
        .card-custom::after { content: ""; position: absolute; top: 0; right: 0; width: 6px; height: 100%; background: var(--line-color, var(--dashboard-teal)); }
        .dashboard-hero {
            background:
                linear-gradient(135deg, rgba(8, 17, 31, 0.96), rgba(15, 118, 110, 0.9)),
                radial-gradient(circle at 88% 18%, rgba(99, 102, 241, 0.32), transparent 16rem);
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: var(--dashboard-card-radius) !important;
            box-shadow: 0 24px 60px rgba(2, 6, 23, 0.18);
            color: #ffffff;
            padding: 22px;
        }
        .dashboard-hero .breadcrumb a,
        .dashboard-hero .breadcrumb-item,
        .dashboard-hero .breadcrumb-item.active {
            color: rgba(255,255,255,0.76) !important;
        }
        .dashboard-title-row {
            align-items: center;
        }
        .stat-label { color: var(--dashboard-muted); font-size: 0.75rem; text-transform: uppercase; font-weight: 700; letter-spacing: 1px; margin-bottom: 8px; display: block; }
        .stat-value { font-size: 2.8rem; font-weight: 800; margin: 0; line-height: 1; letter-spacing: -1px; }
        .header-title {
            border: 0;
            color: #f8fafc !important;
            font-size: 1.75rem;
            font-weight: 800;
            letter-spacing: 0;
            line-height: 1.15;
            padding-left: 0;
            text-transform: none;
            text-shadow: 0 12px 30px rgba(2, 6, 23, 0.32);
        }
        .time-display {
            background: rgba(255,255,255,0.12) !important;
            border: 1px solid rgba(204, 251, 241, 0.22) !important;
            color: rgba(255,255,255,0.88);
            font-size: 0.85rem;
            font-weight: 700;
        }
        .time-display i,
        .time-display .text-navy {
            color: #5eead4 !important;
        }
        .time-display .text-muted {
            color: rgba(255,255,255,0.45) !important;
        }
        .chart-container { position: relative; height: 350px; width: 100%; }
        .role-badge {
            background: linear-gradient(135deg, var(--dashboard-teal), var(--dashboard-indigo)) !important;
            border: 1px solid rgba(255,255,255,0.18);
            color: #ffffff !important;
            font-size: 0.75rem;
            padding: 7px 14px;
            letter-spacing: 0.04em;
        }
        .dashboard-title-area { min-width: 0; max-width: 100%; }
        .stat-card-total { --line-color: var(--dashboard-indigo); }
        .stat-card-online { --line-color: var(--dashboard-success); }
        .stat-card-channel { --line-color: var(--dashboard-info); }
        .stat-card-total .stat-value { color: var(--dashboard-indigo) !important; }
        .stat-card-online .stat-value { color: var(--dashboard-success) !important; }
        .stat-card-channel .stat-value { color: var(--dashboard-teal-strong) !important; }
        .stat-icon {
            align-items: center;
            border-radius: 14px;
            display: inline-flex;
            height: 40px;
            justify-content: center;
            margin-bottom: 14px;
            width: 40px;
        }
        .stat-icon.total { background: var(--dashboard-indigo-soft); color: var(--dashboard-indigo); }
        .stat-icon.online { background: #dcfce7; color: var(--dashboard-success); }
        .stat-icon.channel { background: #ccfbf1; color: var(--dashboard-teal-strong); }
        .dashboard-chart-card h5 {
            color: var(--dashboard-ink) !important;
        }
        .dashboard-chart-card h5 i {
            color: var(--dashboard-teal) !important;
        }
        .realtime-badge {
            background: #f8fafc !important;
            border-color: var(--dashboard-line) !important;
            color: var(--dashboard-muted) !important;
        }
        .realtime-badge i {
            color: var(--dashboard-success) !important;
        }

        @media (min-width: 1200px) {
            .header-title { font-size: 2rem; }
        }

        @media (max-width: 991.98px) {
            .header-title { font-size: 1.65rem; }
        }

        @media (max-width: 768px) {
            .main-content { padding: 15px 10px; }
            .dashboard-hero { padding: 18px; }
            .header-title { font-size: 1.52rem; }
            .stat-value { font-size: 2.2rem; }
            .card-custom { padding: 20px; }
            .time-display { font-size: 0.75rem; width: auto; text-align: left; }
            .chart-container { height: 280px; }
            .role-badge { width: fit-content; }
        }

        @media (max-width: 575.98px) {
            .header-title { font-size: 1.38rem; }
        }

        @media (max-width: 390px) {
            .header-title { font-size: 1.28rem; }
        }
    </style>
</head>
<body>

<div class="container-fluid">
    <div class="row">
        <?php include 'sidebar.php'; ?>

        <main class="col-md-9 ms-sm-auto col-lg-10 main-content">
            <div class="row g-3 g-md-4 mb-4">
                <div class="col-12">
                    <div class="app-toolbar dashboard-hero d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-3">
                        <div class="dashboard-title-area">
                            <div class="dashboard-title-row mb-1">
                                <h4 class="header-title">Sistem Monitoring</h4>
                                <span class="badge rounded-pill role-badge <?= $admin_role === 'superadmin' ? 'bg-danger' : 'bg-primary' ?>">
                                    <i class="fas <?= $admin_role === 'superadmin' ? 'fa-shield-heart' : 'fa-building-shield' ?> me-1"></i>
                                    <?= strtoupper($admin_role) ?>
                                </span>
                            </div>
                            <nav aria-label="breadcrumb">
                                <ol class="breadcrumb mb-0 small">
                                    <li class="breadcrumb-item"><a href="dashboard.php" class="text-decoration-none text-muted">Portal</a></li>
                                    <li class="breadcrumb-item active text-navy fw-bold">Dashboard Utama</li>
                                </ol>
                            </nav>
                        </div>
                        <div class="text-md-end">
                            <div class="time-display px-3 py-2 rounded-3 shadow-sm border-0">
                                <i class="far fa-calendar-alt text-navy me-2"></i><?= date('d M Y') ?>
                                <span class="mx-2 text-muted">|</span>
                                <i class="far fa-clock text-navy me-1"></i><span id="liveClock" class="fw-bold"><?= date('H:i:s') ?></span> WIB
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="row g-3 g-md-4 mb-4">
                <div class="col-12 col-sm-6 col-lg-4">
                    <div class="card-custom stat-card-total">
                        <span class="stat-icon total"><i class="fas fa-users-viewfinder"></i></span>
                        <span class="stat-label">Total User</span>
                        <div class="stat-value" id="stat-total-user"><?= number_format($total_user) ?></div>
                        <p class="small text-muted mt-2 mb-0 d-none d-lg-block">
                            <?= $admin_role === 'superadmin' ? 'Terdaftar di server' : 'User di bawah wewenang Anda' ?>
                        </p>
                    </div>
                </div>
                <div class="col-12 col-sm-6 col-lg-4">
                    <div class="card-custom stat-card-online">
                        <span class="stat-icon online"><i class="fas fa-signal"></i></span>
                        <span class="stat-label">User Online</span>
                        <div class="stat-value" id="stat-user-online"><?= number_format($user_online) ?></div>
                        <p class="small text-muted mt-2 mb-0 d-none d-lg-block">User aktif real-time</p>
                    </div>
                </div>
                <div class="col-12 col-sm-6 col-lg-4">
                    <div class="card-custom stat-card-channel">
                        <span class="stat-icon channel"><i class="fas fa-tower-broadcast"></i></span>
                        <span class="stat-label">Channels</span>
                        <div class="stat-value" id="stat-total-channel"><?= number_format($total_channel) ?></div>
                        <p class="small text-muted mt-2 mb-0 d-none d-lg-block">
                            <?= $admin_role === 'superadmin' ? 'Total semua channel' : 'Channel mandiri & delegasi' ?>
                        </p>
                    </div>
                </div>
            </div>

            <div class="row g-3 g-md-4 mb-4">
                <div class="col-12">
                    <div class="card-custom dashboard-chart-card">
                        <div class="d-flex flex-column flex-sm-row justify-content-between align-items-sm-center mb-4 gap-2">
                            <h5 class="fw-bold m-0 text-dark">
                                <i class="fas fa-chart-line me-2"></i>Trafik Komunikasi (PTT)
                            </h5>
                            <div>
                                <span class="badge realtime-badge border px-3">
                                    <i class="fas fa-sync fa-spin me-1 text-success" id="chartSyncIcon" style="display:none;"></i>
                                    Real-time 24 Jam
                                </span>
                            </div>
                        </div>
                        <div class="chart-container">
                            <canvas id="activityChart"></canvas>
                        </div>
                    </div>
                </div>
            </div>

            <footer class="pt-4 pb-2 text-center text-muted small border-top">
                <p class="mb-0"><strong>&copy; <?= date('Y') ?> am²</strong></p>
                <span class="opacity-75">Manajemen Push-to-Talk Terintegrasi</span>
            </footer>
        </main>
    </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script>
    let myChart;

    function updateClock() {
        const now = new Date();
        const timeStr = now.getHours().toString().padStart(2, '0') + ':' +
                        now.getMinutes().toString().padStart(2, '0') + ':' +
                        now.getSeconds().toString().padStart(2, '0');
        const clockEl = document.getElementById('liveClock');
        if(clockEl) clockEl.textContent = timeStr;
    }
    setInterval(updateClock, 1000);

    async function refreshDashboardData() {
        const syncIcon = document.getElementById('chartSyncIcon');
        if(syncIcon) syncIcon.style.display = 'inline-block';

        try {
            const response = await fetch('api_dashboard_chart.php');
            const data = await response.json();

            if(data.error) throw new Error(data.error);

            myChart.data.labels = data.labels;
            myChart.data.datasets[0].data = data.values;
            myChart.update('none');

        } catch (error) {
            console.error('Fetch error:', error);
        } finally {
            if(syncIcon) setTimeout(() => syncIcon.style.display = 'none', 1000);
        }
    }

    document.addEventListener('DOMContentLoaded', function() {
        const canvas = document.getElementById('activityChart');
        if(!canvas) return;

        const theme = getComputedStyle(document.body);
        const chartAccent = theme.getPropertyValue('--dashboard-teal').trim() || '#14b8a6';
        const chartFill = theme.getPropertyValue('--dashboard-chart-fill').trim() || 'rgba(20, 184, 166, 0.17)';
        const chartGrid = theme.getPropertyValue('--dashboard-line').trim() || '#dbeafe';
        const chartText = theme.getPropertyValue('--dashboard-muted').trim() || '#64748b';
        const chartTooltipBg = theme.getPropertyValue('--dashboard-ink').trim() || '#0f172a';
        const chartPointBg = theme.getPropertyValue('--dashboard-panel').trim() || '#ffffff';

        const ctx = canvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 300);
        gradient.addColorStop(0, chartFill);
        gradient.addColorStop(1, 'transparent');

        myChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: <?= json_encode($chart_labels) ?>,
                datasets: [{
                    label: 'Panggilan PTT',
                    data: <?= json_encode($chart_values) ?>,
                    borderColor: chartAccent,
                    borderWidth: 3,
                    backgroundColor: gradient,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 5,
                    pointBackgroundColor: chartPointBg,
                    pointBorderColor: chartAccent,
                    pointHoverRadius: 7,
                    pointHoverBorderWidth: 3
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: chartTooltipBg,
                        padding: 12,
                        displayColors: false,
                        callbacks: {
                            label: function(context) { return context.parsed.y + ' Aktivitas'; }
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: chartGrid, drawBorder: false },
                        ticks: { stepSize: 1, color: chartText, font: { size: 11 } }
                    },
                    x: {
                        grid: { display: false, drawBorder: false },
                        ticks: { color: chartText, font: { weight: '600', size: 11 } }
                    }
                }
            }
        });

        setInterval(refreshDashboardData, 10000);
    });
</script>
</body>
</html>
