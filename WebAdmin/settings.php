<?php
require_once 'auth.php';
require_once 'config.php';



$role_user = $_SESSION['admin_role'];
$admin_id = $_SESSION['admin_id'];
$admin_user = $_SESSION['admin_username'];
$msg = "";
$error = "";

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['update_password'])) {
    $new_pass = $_POST['new_password'];
    $confirm_pass = $_POST['confirm_password'];

    if (strlen($new_pass) < 8) {
        $error = "Password minimal harus 8 karakter.";
    } elseif ($new_pass === $confirm_pass) {
        $hashed_password = password_hash($new_pass, PASSWORD_BCRYPT);
        try {
            $stmt = $pdo->prepare("UPDATE public.admin SET password_hash = ? WHERE id = ?");
            $stmt->execute([$hashed_password, $admin_id]);
            $msg = "Password profil berhasil diperbarui.";
        } catch (PDOException $e) {
            $error = "Gagal memperbarui database: " . am2_safe_error($e, 'settings');
        }
    } else {
        $error = "Konfirmasi password tidak cocok.";
    }
}

if ($role_user === 'superadmin' && isset($_POST['upload_apk']) && isset($_FILES['apk_file'])) {
    $target_dir = "update/";
    if (!is_dir($target_dir)) {
        mkdir($target_dir, 0755, true);
    }
    
    $file_name = basename($_FILES["apk_file"]["name"]);
    $target_file = $target_dir . $file_name;
    $file_type = strtolower(pathinfo($target_file, PATHINFO_EXTENSION));

    if ($file_type != "apk") {
        $error = "Hanya file format .APK yang diizinkan.";
    } else {
        if (move_uploaded_file($_FILES["apk_file"]["tmp_name"], $target_file)) {
            $msg = "Berhasil mengunggah APK ke folder update: " . htmlspecialchars($file_name);
        } else {
            $error = "Gagal mengunggah file ke server.";
        }
    }
}

if (isset($_POST['export_db'])) {
    $timestamp = date('Ymd_His');
    $filename = ($role_user === 'superadmin' ? "FULL_BACKUP_" : "BACKUP_" . strtoupper($admin_user) . "_") . $timestamp . ".sql";
    
    header('Content-Type: application/octet-stream');
    header("Content-disposition: attachment; filename=\"" . $filename . "\"");
    
    putenv("PGPASSWORD=" . $password);
    
    if ($role_user === 'superadmin') {
        $command = "pg_dump -h " . $host . " -U " . $user . " -d " . $dbname . " -n public";
    } else {
        $command = "pg_dump -h " . $host . " -U " . $user . " -d " . $dbname . " -t public.users -t public.channels --column-inserts";
    }
    
    passthru($command);
    exit;
}

if (isset($_POST['import_db']) && isset($_FILES['sql_file'])) {
    $file = $_FILES['sql_file']['tmp_name'];
    $file_name = $_FILES['sql_file']['name'];
    $ext = pathinfo($file_name, PATHINFO_EXTENSION);

    if ($ext !== 'sql') {
        $error = "Format file tidak valid. Gunakan file .sql.";
    } elseif (is_uploaded_file($file)) {
        try {
            putenv("PGPASSWORD=" . $password);
            $command = "psql -h " . $host . " -U " . $user . " -d " . $dbname . " < " . $file;
            shell_exec($command);
            
            $stmt_log = $pdo->prepare("INSERT INTO public.ptt_logs (user_id, event_type, channel_id, event_time) VALUES (?, 'RESTORE', 0, NOW())");
            $stmt_log->execute([$admin_user]);

            $msg = "Proses pemulihan data berhasil dijalankan.";
        } catch (Exception $e) {
            $error = "Gagal memulihkan database: " . am2_safe_error($e, 'settings');
        }
    }
}

try {
    $stmt = $pdo->prepare("SELECT * FROM public.admin WHERE id = ?");
    $stmt->execute([$admin_id]);
    $settings = $stmt->fetch();

    if ($role_user === 'superadmin') {
        $total_admins = $pdo->query("SELECT COUNT(*) FROM public.admin WHERE role = 'admin'")->fetchColumn();
        $total_users = $pdo->query("SELECT COUNT(*) FROM public.users")->fetchColumn();
        $total_channels = $pdo->query("SELECT COUNT(*) FROM public.channels")->fetchColumn();
        $sisa_user = "UNLIMITED";
        $sisa_channel = "UNLIMITED";
    } else {
        $total_admins = 0;
        $stmt_u = $pdo->prepare("SELECT COUNT(*) FROM public.users WHERE admin_id = ?");
        $stmt_u->execute([$admin_id]);
        $total_users = $stmt_u->fetchColumn();

        $stmt_c = $pdo->prepare("SELECT COUNT(*) FROM public.channels WHERE created_by = ?");
        $stmt_c->execute([$admin_id]);
        $total_channels = $stmt_c->fetchColumn();

        $sisa_user = max(0, (int)$settings['user_quota'] - (int)$total_users);
        $sisa_channel = max(0, (int)$settings['channel_quota'] - (int)$total_channels);
    }
} catch (PDOException $e) {
    die("Kesalahan database: " . am2_safe_error($e, 'settings'));
}
?>

<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Konfigurasi - am²</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="asset/css/am2-ui.css">
    <style>
        body { background: var(--color-bg); font-family: 'Segoe UI', sans-serif; }
        .main-content { padding: 20px; transition: 0.3s; }
        .settings-card { border-radius: 15px; border: 1px solid var(--color-border); box-shadow: var(--am2-shadow-sm); background: var(--color-surface); margin-bottom: 20px; }
        .stat-icon { width: 45px; height: 45px; display: flex; align-items: center; justify-content: center; border-radius: 10px; margin-bottom: 10px; }
        .bg-am2 { background-color: var(--color-primary); color: var(--color-on-primary); }
        .header-title { font-weight: 800; color: var(--color-text); border-bottom: 3px solid var(--color-primary); display: inline-block; padding-bottom: 5px; }
        .btn-backup { background-color: var(--color-secondary); color: var(--color-on-secondary); font-weight: 600; border: none; }
        .btn-restore { background-color: var(--color-danger); color: var(--color-text-inverse); font-weight: 600; border: none; }
        .quota-box { background: var(--color-surface-muted); border: 1px solid var(--color-border); border-radius: 10px; padding: 15px; height: 100%; }
        .input-group-text { cursor: pointer; background: var(--color-surface); border-left: none; }
        .pw-input { border-right: none; }
        .btn-upload-apk { background-color: var(--color-secondary); color: var(--color-on-secondary); border: none; font-weight: bold; }
        .border-dashed { border: 2px dashed var(--color-border-strong) !important; }

        @media (max-width: 768px) {
            .main-content { padding: 15px 10px; }
            .header-title { font-size: 1.1rem; }
            .settings-card { padding: 15px !important; }
            .settings-card .border-end { border-right: none !important; border-bottom: 1px solid var(--color-border); padding-bottom: 15px; margin-bottom: 15px; }
            .stat-icon { width: 40px; height: 40px; }
            .stat-value { font-size: 1.5rem; }
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
                    <div class="app-toolbar am2-page-hero d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-3">
                        <h4 class="header-title m-0"><i class="fas fa-cogs me-2"></i> Konfigurasi</h4>
                        <div class="am2-hero-actions">
                            <span class="badge role-badge <?= ($role_user === 'superadmin') ? 'bg-danger' : 'bg-dark' ?> px-3 py-2 shadow-sm rounded-pill">
                                <i class="fas fa-user-shield me-1"></i> <?= strtoupper($role_user) ?>
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <?php if($msg): ?>
                <div class="alert alert-success border-0 shadow-sm alert-dismissible fade show small">
                    <i class="fas fa-check-circle me-2"></i> <?= $msg ?>
                    <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
                </div>
            <?php endif; ?>
            <?php if($error): ?>
                <div class="alert alert-danger border-0 shadow-sm alert-dismissible fade show small">
                    <i class="fas fa-exclamation-triangle me-2"></i> <?= $error ?>
                    <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
                </div>
            <?php endif; ?>

            <div class="row g-3 g-md-4 mb-4">
                <div class="col-12">
                    <div class="card settings-card p-4 text-center shadow-sm">
                        <div class="row g-0">
                            <?php if ($role_user === 'superadmin'): ?>
                            <div class="col-md-4 border-end">
                                <div class="stat-icon bg-primary text-white mx-auto shadow-sm"><i class="fas fa-user-shield"></i></div>
                                <h3 class="fw-bold m-0 stat-value"><?= $total_admins ?></h3>
                                <p class="text-muted small mb-0 text-uppercase fw-bold" style="font-size: 0.65rem;">Admin Satwil</p>
                            </div>
                            <?php endif; ?>

                            <div class="<?= ($role_user === 'superadmin') ? 'col-md-4 border-end' : 'col-md-6 border-end' ?>">
                                <div class="stat-icon bg-success text-white mx-auto shadow-sm"><i class="fas fa-mobile-alt"></i></div>
                                <h3 class="fw-bold m-0 stat-value"><?= $total_users ?></h3>
                                <p class="text-muted small mb-0 text-uppercase fw-bold" style="font-size: 0.65rem;">Perangkat Terdaftar</p>
                            </div>
                            <div class="<?= ($role_user === 'superadmin') ? 'col-md-4' : 'col-md-6' ?>">
                                <div class="stat-icon bg-warning text-white mx-auto shadow-sm"><i class="fas fa-broadcast-tower"></i></div>
                                <h3 class="fw-bold m-0 stat-value"><?= $total_channels ?></h3>
                                <p class="text-muted small mb-0 text-uppercase fw-bold" style="font-size: 0.65rem;">Channel Aktif</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="row g-3 g-md-4 mb-4">
                <div class="col-lg-6">
                    <div class="card settings-card p-4 h-100">
                        <h6 class="fw-bold border-bottom pb-2 mb-3"><i class="fas fa-lock me-2 text-danger"></i> Keamanan Akun</h6>
                        <form method="POST">
                    <?= am2_csrf_field() ?>
                            <div class="mb-3 small fw-bold">USERNAME: <span class="text-primary"><?= htmlspecialchars($settings['username']) ?></span></div>
                            
                            <div class="mb-3">
                                <label class="small fw-bold mb-1">Password Baru</label>
                                <div class="input-group input-group-sm safety-input-group">
                                    <input type="password" name="new_password" id="new_password" class="form-control pw-input" placeholder="Minimal 8 karakter" required>
                                    <span class="input-group-text toggle-password" data-target="new_password">
                                        <i class="fas fa-eye text-muted"></i>
                                    </span>
                                </div>
                            </div>

                            <div class="mb-3">
                                <label class="small fw-bold mb-1">Konfirmasi Password</label>
                                <div class="input-group input-group-sm">
                                    <input type="password" name="confirm_password" id="confirm_password" class="form-control pw-input" placeholder="Ulangi password" required>
                                    <span class="input-group-text toggle-password" data-target="confirm_password">
                                        <i class="fas fa-eye text-muted"></i>
                                    </span>
                                </div>
                            </div>

                            <button type="submit" name="update_password" class="btn bg-am2 w-100 fw-bold shadow-sm py-2">
                                <i class="fas fa-key me-2"></i> UPDATE PASSWORD
                            </button>
                        </form>

                        <div class="safety-panel mt-4">
                             <h6 class="fw-bold mb-3"><i class="fas fa-database me-2 text-danger"></i> Management Database</h6>
                             <form method="POST" class="mb-3">
                    <?= am2_csrf_field() ?>
                                <button type="submit" name="export_db" class="btn btn-backup w-100 shadow-sm py-2">
                                    <i class="fas fa-file-export me-2"></i> EKSPOR DATA (.SQL)
                                </button>
                             </form>
                             <form method="POST" enctype="multipart/form-data">
                    <?= am2_csrf_field() ?>
                                <label class="small fw-bold text-danger mb-2 text-uppercase" style="font-size: 0.65rem;">Pulihkan Cadangan</label>
                                <div class="input-group input-group-sm">
                                    <input type="file" name="sql_file" class="form-control" accept=".sql" required>
                                    <button type="submit" name="import_db" class="btn btn-restore btn-danger-soft px-3" onclick="return confirm('PERINGATAN: Seluruh data saat ini akan ditimpa. Lanjutkan?')">
                                        RESTORE
                                    </button>
                                </div>
                             </form>
                        </div>
                    </div>
                </div>

                <div class="col-lg-6">
                    <div class="card settings-card p-4 h-100 d-flex flex-column">
                        <h6 class="fw-bold border-bottom pb-2 mb-3"><i class="fas fa-id-card me-2 text-info"></i> Lisensi & Kuota Akun</h6>
                        
                        <div class="mb-4 p-3 bg-light rounded shadow-sm border-start border-primary border-4 text-center">
                            <label class="small text-muted d-block mb-1 text-uppercase fw-bold" style="font-size: 0.65rem;">Masa Aktif Layanan</label>
                            <span class="fw-bold text-dark m-0" style="font-size: 1.1rem;">
                                <?= ($settings['expired_at'] && $settings['expired_at'] != 'infinity') ? date('d F Y', strtotime($settings['expired_at'])) : 'LIFETIME ACCESS' ?>
                            </span>
                        </div>

                        <div class="row g-2 mb-4">
                            <div class="col-6">
                                <div class="quota-box text-center shadow-sm">
                                    <label class="small text-muted d-block mb-1 fw-bold" style="font-size: 0.6rem;">KUOTA USER</label>
                                    <span class="h5 fw-bold text-primary m-0"><?= is_numeric($settings['user_quota']) ? number_format($settings['user_quota']) : $settings['user_quota'] ?></span>
                                    <hr class="my-2">
                                    <small class="text-muted fw-bold" style="font-size: 0.6rem;">Sisa: <span class="text-danger"><?= $sisa_user ?></span></small>
                                </div>
                            </div>
                            <div class="col-6">
                                <div class="quota-box text-center shadow-sm">
                                    <label class="small text-muted d-block mb-1 fw-bold" style="font-size: 0.6rem;">KUOTA CHANNEL</label>
                                    <span class="h5 fw-bold text-primary m-0"><?= is_numeric($settings['channel_quota']) ? number_format($settings['channel_quota']) : $settings['channel_quota'] ?></span>
                                    <hr class="my-2">
                                    <small class="text-muted fw-bold" style="font-size: 0.6rem;">Sisa: <span class="text-danger"><?= $sisa_channel ?></span></small>
                                </div>
                            </div>
                        </div>
                        
                        <h6 class="fw-bold small mb-2 text-muted text-uppercase" style="font-size: 0.65rem;">Izin Fitur Aktif:</h6>
                        <ul class="list-group list-group-flush mb-4 shadow-sm border rounded">
                            <li class="list-group-item d-flex justify-content-between align-items-center py-2 px-3 small">
                                <span><i class="fas fa-video me-2 text-primary"></i> Video Call Group</span>
                                <i class="fas <?= ($settings['can_manage_video']) ? 'fa-check-circle text-success' : 'fa-times-circle text-danger' ?> fa-lg"></i>
                            </li>
                            <li class="list-group-item d-flex justify-content-between align-items-center py-2 px-3 small">
                                <span><i class="fas fa-map-marker-alt me-2 text-primary"></i> Tracking GPS</span>
                                <i class="fas <?= ($settings['can_manage_maps']) ? 'fa-check-circle text-success' : 'fa-times-circle text-danger' ?> fa-lg"></i>
                            </li>
                            <li class="list-group-item d-flex justify-content-between align-items-center py-2 px-3 small">
                                <span><i class="fas fa-comment-dots me-2 text-primary"></i> Chat P2P & Group</span>
                                <i class="fas <?= ($settings['can_manage_p2p']) ? 'fa-check-circle text-success' : 'fa-times-circle text-danger' ?> fa-lg"></i>
                            </li>
                        </ul>

                        <?php if ($role_user === 'superadmin'): ?>
                        <div class="safety-panel mt-auto">
                            <h6 class="fw-bold mb-2 text-uppercase text-dark small" style="font-size: 0.7rem;"><i class="fas fa-cloud-upload-alt me-2 text-primary"></i> App Distribution</h6>
                            <div class="p-3 bg-light rounded border border-dashed shadow-sm">
                                <form method="POST" enctype="multipart/form-data">
                    <?= am2_csrf_field() ?>
                                    <div class="input-group input-group-sm safety-input-group mb-2">
                                        <input type="file" name="apk_file" class="form-control" accept=".apk" required>
                                        <button type="submit" name="upload_apk" class="btn btn-upload-apk px-3">
                                            UPLOAD
                                        </button>
                                    </div>
                                    <div class="d-flex justify-content-between">
                                        <small class="text-muted" style="font-size: 0.6rem;">Format: .apk</small>
                                        <a href="update/" target="_blank" class="text-decoration-none small fw-bold" style="font-size: 0.6rem;"><i class="fas fa-folder-open me-1"></i> Buka Folder</a>
                                    </div>
                                </form>
                            </div>
                        </div>
                        <?php endif; ?>
                    </div>
                </div>
            </div>

            <footer class="footer-text mt-4 text-center text-muted">
                <small><strong>&copy; <?= date('Y') ?> am² - Terintegrasi</strong></small>
            </footer>
        </main>
    </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script>
document.querySelectorAll('.toggle-password').forEach(button => {
    button.addEventListener('click', function() {
        const targetId = this.getAttribute('data-target');
        const input = document.getElementById(targetId);
        const icon = this.querySelector('i');

        if (input.type === "password") {
            input.type = "text";
            icon.classList.remove('fa-eye');
            icon.classList.add('fa-eye-slash');
        } else {
            input.type = "password";
            icon.classList.remove('fa-eye-slash');
            icon.classList.add('fa-eye');
        }
    });
});
</script>
</body>
</html>
