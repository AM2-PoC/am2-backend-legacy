<?php
if (!isset($_SESSION['admin_logged_in'])) {
    exit(t('nav.access_denied'));
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
        <button class="navbar-toggler border-0 shadow-none" type="button" id="mobileMenuToggle" aria-label="<?= e('nav.open_menu') ?>" aria-controls="sidebarMenu" aria-expanded="false">
            <i class="fas fa-bars text-white"></i>
        </button>
        <span class="navbar-brand mb-0 h1 fs-6">am²</span>
        <div class="d-flex align-items-center">
             <img src="asset/image/logo.jpeg" alt="Logo" width="35" height="35" class="rounded-circle border border-warning">
        </div>
    </div>
</nav>

<div id="sidebarOverlay" aria-hidden="true"></div>

<div id="sidebarMenu" class="sidebar" aria-label="<?= e('nav.main_navigation') ?>">
    <div class="sidebar-brand">
        <img src="asset/image/logo.jpeg" alt="Logo" class="logo-img rounded-circle">
        <div class="brand-text-main">am²</div>
    </div>

    <div class="nav-wrapper">
        <h6 class="sidebar-heading"><?= e('nav.home') ?></h6>
        <a class="nav-link <?= ($current_page == 'dashboard.php') ? 'active' : '' ?>" href="dashboard.php">
            <i class="fas fa-th-large"></i> <?= e('nav.dashboard') ?>
        </a>

        <h6 class="sidebar-heading"><?= e('nav.management') ?></h6>
        <a class="nav-link <?= ($current_page == 'users.php') ? 'active' : '' ?>" href="users.php">
            <i class="fas fa-users-cog"></i> <?= e('nav.users') ?>
        </a>
        <a class="nav-link <?= ($current_page == 'channels.php') ? 'active' : '' ?>" href="channels.php">
            <i class="fas fa-broadcast-tower"></i> <?= e('nav.channels') ?>
        </a>
        <a class="nav-link <?= ($current_page == 'user_access.php') ? 'active' : '' ?>" href="user_access.php">
            <i class="fas fa-key"></i> <?= e('nav.channel_access') ?>
        </a>

        <h6 class="sidebar-heading"><?= e('nav.monitoring') ?></h6>
        <a class="nav-link <?= ($current_page == 'livetrack.php') ? 'active' : '' ?>" href="livetrack.php">
            <i class="fas fa-map-marked-alt"></i> <?= e('nav.live_track') ?>
        </a>
        <a class="nav-link <?= ($current_page == 'logs.php') ? 'active' : '' ?>" href="logs.php">
            <i class="fas fa-history"></i> <?= e('nav.activity_log') ?>
        </a>

        <h6 class="sidebar-heading"><?= e('nav.system') ?></h6>
        <a class="nav-link <?= ($current_page == 'settings.php') ? 'active' : '' ?>" href="settings.php">
            <i class="fas fa-sliders-h"></i> <?= e('nav.settings') ?>
        </a>

        <?php if ($role_user === 'superadmin'): ?>
            <h6 class="sidebar-heading"><?= e('nav.administrator') ?></h6>
            <a class="nav-link <?= ($current_page == 'admin_panel.php') ? 'active' : '' ?>" href="admin_panel.php">
                <i class="fas fa-user-shield"></i> <?= e('nav.admin_panel') ?>
            </a>
        <?php endif; ?>
    </div>

    
    <div class="am2-prefs px-3 py-2 d-flex align-items-center justify-content-between gap-2">
        <div class="btn-group btn-group-sm" role="group" aria-label="<?= e('pref.language') ?>">
            <?php foreach (AM2_LOCALES as $loc): ?>
                <a class="btn btn-sm <?= am2_locale() === $loc ? 'btn-secondary' : 'btn-outline-secondary' ?>"
                   href="?lang=<?= $loc ?>"><?= strtoupper($loc) ?></a>
            <?php endforeach; ?>
        </div>
        <button type="button" class="btn btn-sm btn-outline-secondary" id="am2ThemeToggle"
                title="<?= e('pref.theme') ?>" aria-pressed="<?= am2_theme() === 'dark' ? 'true' : 'false' ?>">
            <i class="fas <?= am2_theme() === 'dark' ? 'fa-sun' : 'fa-moon' ?>"></i>
        </button>
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
            <a href="logout.php" class="logout-power-btn" onclick="return confirm(<?= json_encode(t('nav.logout_confirm')) ?>)" title="<?= e('nav.logout') ?>">
                <i class="fas fa-power-off"></i>
            </a>
        </div>
    </div>
</div>

<script>
    document.addEventListener('DOMContentLoaded', function() {
    const themeBtn = document.getElementById('am2ThemeToggle');
    if (themeBtn) {
        themeBtn.addEventListener('click', function () {
            const root = document.documentElement;
            const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            root.setAttribute('data-theme', next);
            document.cookie = 'am2_theme=' + next + ';path=/;max-age=31536000;samesite=lax';
            themeBtn.setAttribute('aria-pressed', next === 'dark' ? 'true' : 'false');
            const icon = themeBtn.querySelector('i');
            if (icon) icon.className = next === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
        });
    }

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
