<?php
if (!isset($_SESSION['admin_logged_in'])) {
    exit('Akses ditolak');
}

$current_page = basename($_SERVER['PHP_SELF']);
$display_name = $_SESSION['admin_username'] ?? $_SESSION['admin_name'] ?? 'Admin';
$role_user = $_SESSION['admin_role'] ?? 'admin';
?>

<script>
    document.body.classList.add('has-mobile-sidebar');
</script>

<nav class="navbar navbar-dark d-md-none shadow-sm fixed-top mobile-navbar">
    <div class="container-fluid">
        <button class="navbar-toggler border-0 shadow-none" type="button" id="mobileMenuToggle" aria-label="Buka menu navigasi" aria-controls="sidebarMenu" aria-expanded="false">
            <i class="fas fa-bars text-white"></i>
        </button>
        <span class="navbar-brand mb-0 h1 fs-6">am²</span>
        <div class="d-flex align-items-center">
             <img src="asset/image/logo.jpeg" alt="Logo" width="35" height="35" class="rounded-circle border border-warning">
        </div>
    </div>
</nav>

<div id="sidebarOverlay" aria-hidden="true"></div>

<div id="sidebarMenu" class="sidebar" aria-label="Navigasi utama">
    <div class="sidebar-brand">
        <img src="asset/image/logo.jpeg" alt="Logo" class="logo-img rounded-circle">
        <div class="brand-text-main">am²</div>
    </div>

    <div class="nav-wrapper">
        <h6 class="sidebar-heading">Home</h6>
        <a class="nav-link <?= ($current_page == 'dashboard.php') ? 'active' : '' ?>" href="dashboard.php">
            <i class="fas fa-th-large"></i> Dashboard
        </a>

        <h6 class="sidebar-heading">Manajemen</h6>
        <a class="nav-link <?= ($current_page == 'users.php') ? 'active' : '' ?>" href="users.php">
            <i class="fas fa-users-cog"></i> User
        </a>
        <a class="nav-link <?= ($current_page == 'channels.php') ? 'active' : '' ?>" href="channels.php">
            <i class="fas fa-broadcast-tower"></i> Channels
        </a>
        <a class="nav-link <?= ($current_page == 'user_access.php') ? 'active' : '' ?>" href="user_access.php">
            <i class="fas fa-key"></i> Akses Channel
        </a>

        <h6 class="sidebar-heading">Monitoring</h6>
        <a class="nav-link <?= ($current_page == 'livetrack.php') ? 'active' : '' ?>" href="livetrack.php">
            <i class="fas fa-map-marked-alt"></i> Live Track
        </a>
        <a class="nav-link <?= ($current_page == 'logs.php') ? 'active' : '' ?>" href="logs.php">
            <i class="fas fa-history"></i> Aktivitas Log
        </a>

        <h6 class="sidebar-heading">Sistem</h6>
        <a class="nav-link <?= ($current_page == 'settings.php') ? 'active' : '' ?>" href="settings.php">
            <i class="fas fa-sliders-h"></i> Pengaturan
        </a>

        <?php if ($role_user === 'superadmin'): ?>
            <h6 class="sidebar-heading">Administrator</h6>
            <a class="nav-link <?= ($current_page == 'admin_panel.php') ? 'active' : '' ?>" href="admin_panel.php">
                <i class="fas fa-user-shield"></i> Admin Panel
            </a>
        <?php endif; ?>
    </div>

    <div class="profile-card">
        <div class="profile-info">
            <div class="profile-main d-flex align-items-center gap-2 overflow-hidden">
                <div class="profile-avatar">
                    <?= strtoupper(substr($display_name, 0, 1)) ?>
                </div>
                <div class="profile-details overflow-hidden">
                    <p class="profile-name"><?= htmlspecialchars($display_name) ?></p>
                    <span class="profile-role <?= ($role_user === 'superadmin') ? 'bg-danger text-white' : 'bg-warning text-dark' ?>">
                        <?= strtoupper($role_user) ?>
                    </span>
                </div>
            </div>
            <a href="logout.php" class="logout-power-btn" onclick="return confirm('Keluar dari sistem?')" title="Logout">
                <i class="fas fa-power-off"></i>
            </a>
        </div>
    </div>
</div>

<script>
    document.addEventListener('DOMContentLoaded', function() {
        const mobileToggle = document.getElementById('mobileMenuToggle');
        const sidebar = document.getElementById('sidebarMenu');
        const overlay = document.getElementById('sidebarOverlay');

        function setSidebar(open) {
            if (!sidebar || !overlay) return;
            sidebar.classList.toggle('show', open);
            overlay.classList.toggle('show', open);
            document.body.classList.toggle('sidebar-open', open);
            overlay.setAttribute('aria-hidden', open ? 'false' : 'true');
            if (mobileToggle) {
                mobileToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            }
        }

        function toggleSidebar() {
            setSidebar(!sidebar.classList.contains('show'));
        }

        if(mobileToggle) mobileToggle.addEventListener('click', toggleSidebar);
        if(overlay) overlay.addEventListener('click', function() { setSidebar(false); });

        document.addEventListener('keydown', function(event) {
            if (event.key === 'Escape' && sidebar && sidebar.classList.contains('show')) {
                setSidebar(false);
            }
        });

        window.addEventListener('resize', function() {
            if (window.innerWidth >= 768) {
                setSidebar(false);
            }
        });
    });
</script>
