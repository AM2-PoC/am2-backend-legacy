<?php
function render_layout($content, $title = "PTT SYSTEM - am²", $me = [], $stats = []) {
    $admin_name = $_SESSION['admin_name'] ?? 'Admin';
    $admin_role = $_SESSION['admin_role'] ?? 'User';
?>
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?php echo $title; ?> | am²</title>
    
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="asset/css/am2-ui.css">
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
    <script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>

    <style>
        :root {
            --primary: #111111;
            --navy: #003566;
            --accent: #ffc300;
            --sidebar-bg: #111111;
            --bg-body: #f4f7f9;
            --sidebar-width: 240px;
        }

        body {
            font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
            margin: 0;
            background-color: var(--bg-body);
            display: flex;
            min-height: 100vh;
            overflow-x: hidden;
        }
        
        .sidebar {
            width: var(--sidebar-width);
            background: var(--sidebar-bg);
            color: white;
            position: fixed;
            height: 100vh;
            display: flex;
            flex-direction: column;
            z-index: 1050;
            transition: transform 0.3s ease;
            border-right: 1px solid rgba(255,255,255,0.05);
        }

        .sidebar-brand { padding: 20px; text-align: center; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .sidebar-brand img { width: 45px; margin-bottom: 10px; border-radius: 50%; border: 2px solid var(--accent); }
        .sidebar-brand h3 { font-size: 0.9rem; font-weight: 800; color: white; margin: 0; letter-spacing: 1px; }
        .sidebar-brand span { font-size: 0.6rem; color: var(--accent); font-weight: 700; text-transform: uppercase; }

        .nav-menu { padding: 10px 0; flex-grow: 1; overflow-y: auto; }
        .nav-link {
            padding: 10px 20px;
            color: rgba(255,255,255,0.6);
            text-decoration: none;
            display: flex;
            align-items: center;
            transition: 0.2s;
            font-size: 0.8rem;
            margin: 2px 12px;
            border-radius: 8px;
        }
        .nav-link i { width: 22px; font-size: 1rem; margin-right: 10px; text-align: center; }

        .nav-link:hover {
            background: rgba(255,255,255,0.05);
            color: var(--accent);
        }

        .nav-link.active {
            background: var(--accent);
            color: var(--primary) !important;
            font-weight: 700;
        }

        .main-content {
            margin-left: var(--sidebar-width);
            width: calc(100% - var(--sidebar-width));
            padding: 20px;
            transition: all 0.3s ease;
        }
        
        .header-panel {
            background: white;
            padding: 12px 20px;
            border-radius: 12px;
            box-shadow: 0 2px 12px rgba(0,0,0,0.03);
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            border: 1px solid rgba(0,0,0,0.05);
        }

        @media (max-width: 992px) {
            .sidebar { transform: translateX(-100%); }
            .sidebar.active { transform: translateX(0); box-shadow: 10px 0 30px rgba(0,0,0,0.5); }
            .main-content { margin-left: 0; width: 100%; padding: 15px; }
            .header-panel { flex-direction: row; text-align: left; }
        }

        .toggle-btn {
            display: none; background: var(--navy); color: white; border: none;
            padding: 8px 12px; border-radius: 8px; cursor: pointer;
        }
        @media (max-width: 992px) { .toggle-btn { display: block; } }
    </style>
</head>
<body>
    <div class="sidebar" id="sidebar">
        <div class="sidebar-brand">
            <img src="asset/image/logo.jpeg" alt="Logo">
            <h3>am²</h3>
            <span>Command Center</span>
        </div>
        <nav class="nav-menu">
            <a href="dashboard.php" class="nav-link <?= ($current_page == 'dashboard.php') ? 'active' : '' ?>">
                <i class="fas fa-th-large"></i> Dashboard
            </a>
            <a href="users.php" class="nav-link <?= ($current_page == 'users.php') ? 'active' : '' ?>">
                <i class="fas fa-users-cog"></i> User
            </a>
            <a href="channels.php" class="nav-link <?= ($current_page == 'channels.php') ? 'active' : '' ?>">
                <i class="fas fa-broadcast-tower"></i> Channels
            </a>
            <a href="user_access.php" class="nav-link <?= ($current_page == 'user_access.php') ? 'active' : '' ?>">
                <i class="fas fa-key"></i> Akses Channel
            </a>
            <a href="livetrack.php" class="nav-link <?= ($current_page == 'livetrack.php') ? 'active' : '' ?>">
                <i class="fas fa-map-marked-alt"></i> Live Track
            </a>

            <div class="mt-auto" style="padding-bottom: 20px;">
                <a href="logout.php" class="nav-link text-danger" onclick="return confirm('Keluar dari sistem?')">
                    <i class="fas fa-sign-out-alt"></i> KELUAR
                </a>
            </div>
        </nav>
    </div>

    <div class="main-content">
        <div class="header-panel">
            <div class="d-flex align-items-center">
                <button class="toggle-btn me-3" id="menu-toggle"><i class="fas fa-bars"></i></button>
                <div>
                    <h6 class="mb-0 fw-bold" style="font-size: 0.9rem;">Halo, <?= htmlspecialchars($admin_name) ?></h6>
                    <small class="text-muted" style="font-size: 0.7rem;"><?= strtoupper($admin_role) ?></small>
                </div>
            </div>
            <div class="text-end">
                <div id="clock" class="fw-bold text-navy" style="font-size: 0.85rem;"></div>
                <div style="font-size: 9px;" class="text-success fw-bold">
                    <i class="fas fa-circle-check"></i> SERVER ONLINE
                </div>
            </div>
        </div>

        <div class="container-fluid p-0">
            <?php echo $content; ?>
        </div>
    </div>

    <script>
        document.getElementById('menu-toggle')?.addEventListener('click', function() {
            document.getElementById('sidebar').classList.toggle('active');
        });

        function updateClock() {
            const now = new Date();
            const time = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const date = now.toLocaleDateString('id-ID', { weekday: 'short', day: '2-digit', month: 'short' });
            const el = document.getElementById('clock');
            if (el) el.innerText = `${date} | ${time} WIB`;
        }
        setInterval(updateClock, 1000);
        updateClock();
    </script>
</body>
</html>
<?php
}
?>
