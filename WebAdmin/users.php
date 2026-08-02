<?php
session_start();
require_once 'config.php';

if (!isset($_SESSION['admin_logged_in'])) {
    header("Location: login.php");
    exit;
}

$success_msg = "";
$error_msg = "";
$current_admin_id = $_SESSION['admin_id'];
$admin_role = $_SESSION['admin_role'];

function syncUserChannels($userId) {
    $url = AM2_NODE_BASE . "/api/admin/sync-channels?userId=" . urlencode($userId);
    @file_get_contents($url, false, stream_context_create(['http' => ['timeout' => 2]]));
}

function notifyPermissionUpdate($userId, $maps, $p2p, $video, $duplex = 'FULL DUPLEX') {
    $url = AM2_NODE_BASE . "/api/admin/update-permissions";
    $data = [
        'userId' => $userId,
        'enable_maps' => (bool)$maps,
        'enable_p2p' => (bool)$p2p,
        'enable_ptt_video' => (bool)$video,
        'duplex_mode' => $duplex
    ];
    $options = [
        'http' => [
            'header'  => "Content-type: application/json\r\n",
            'method'  => 'POST',
            'content' => json_encode($data),
            'timeout' => 2
        ]
    ];
    @file_get_contents($url, false, stream_context_create($options));
}

$stmt_auth = $pdo->prepare("SELECT can_manage_maps, can_manage_p2p, can_manage_video FROM public.admin WHERE id = ?");
$stmt_auth->execute([$current_admin_id]);
$auth = $stmt_auth->fetch();

if ($admin_role === 'superadmin') {
    $auth = ['can_manage_maps' => true, 'can_manage_p2p' => true, 'can_manage_video' => true];
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['add_user'])) {
    $id = trim($_POST['id']);
    $name = strtoupper(trim($_POST['name']));
    $pass = password_hash($_POST['password'], PASSWORD_BCRYPT);
    
    try {
        $pdo->beginTransaction();
        
        $stmt = $pdo->prepare("INSERT INTO public.users (id, name, password, role, status, admin_id, created_by, created_at, updated_at) VALUES (?, ?, ?, 'user', 'offline', ?, ?, NOW(), NOW())");
        $stmt->execute([$id, $name, $pass, $current_admin_id, $current_admin_id]);
        
        $stmt_p = $pdo->prepare("INSERT INTO public.user_app_permissions (user_id, enable_maps, enable_p2p, enable_ptt_video, updated_at) VALUES (?, false, false, false, NOW())");
        $stmt_p->execute([$id]);

        $stmtLog = $pdo->prepare("INSERT INTO public.admin_activity_logs (admin_id, aksi, keterangan, waktu) VALUES (?, 'CREATE_USER', ?, NOW())");
        $stmtLog->execute([$current_admin_id, "Mendaftarkan user baru: $name (ID: $id)"]);
        
        $pdo->commit();
        $success_msg = "User $name (User: $id) berhasil didaftarkan.";
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        $error_msg = ($e->getCode() == '23505') ? "ID $id sudah terdaftar." : "Database Error: " . am2_safe_error($e, 'users');
    }
}

if (isset($_GET['get_user_channels'])) {
    header('Content-Type: application/json');
    $stmt = $pdo->prepare("SELECT channel_id FROM public.user_channels WHERE user_id = ?");
    $stmt->execute([$_GET['u_id']]);
    echo json_encode($stmt->fetchAll(PDO::FETCH_COLUMN));
    exit;
}

if (isset($_POST['save_user_channels'])) {
    header('Content-Type: application/json');
    $u_id = $_POST['u_id'];
    if (!am2_admin_owns_user($pdo, $current_admin_id, $admin_role, $u_id)) {
        echo json_encode(['success' => false, 'msg' => 'Akses ditolak']);
        exit;
    }
    $channels = json_decode($_POST['channels'], true) ?: [];
    try {
        $pdo->beginTransaction();
        $pdo->prepare("DELETE FROM public.user_channels WHERE user_id = ?")->execute([$u_id]);
        if (!empty($channels)) {
            $stmt = $pdo->prepare("INSERT INTO public.user_channels (user_id, channel_id, is_default, permission) VALUES (?, ?, ?, 'FULL DUPLEX')");
            foreach ($channels as $idx => $ch_id) {
                $stmt->execute([$u_id, $ch_id, ($idx === 0 ? 'true' : 'false')]);
            }
        }
        $pdo->commit();
        syncUserChannels($u_id);
        echo json_encode(['success' => true]);
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        echo json_encode(['success' => false, 'msg' => am2_safe_error($e, 'users')]);
    }
    exit;
}

if (isset($_POST['update_feature'])) {
    header('Content-Type: application/json');
    if (!am2_admin_owns_user($pdo, $current_admin_id, $admin_role, $_POST['u_id'] ?? '')) {
        echo json_encode(['success' => false, 'msg' => 'Akses ditolak']);
        exit;
    }
    $u_id = $_POST['u_id'];
    $feature = $_POST['feature'];

    if ($feature === 'duplex_mode') {
        $val = $_POST['val'];
        $sql_val = $pdo->quote($val);
        $status_label = "MENGUBAH MODE KE $val";
    } else {
        $val = ($_POST['val'] === 'true') ? 'true' : 'false';
        $sql_val = $val;
        $status_label = ($val === 'true') ? 'MENGAKTIFKAN' : 'MENONAKTIFKAN';
    }

    $feature_names = [
        'enable_maps' => 'Fitur Lokasi/Maps',
        'enable_p2p' => 'Fitur P2P Chat',
        'enable_ptt_video' => 'Fitur PTT Video',
        'duplex_mode' => 'Mode Duplex'
    ];

    if (!array_key_exists($feature, $feature_names)) {
        echo json_encode(['success' => false, 'msg' => 'Fitur tidak valid']); exit;
    }

    $can_change = false;
    if ($feature == 'enable_maps' && $auth['can_manage_maps']) $can_change = true;
    if ($feature == 'enable_p2p' && $auth['can_manage_p2p']) $can_change = true;
    if ($feature == 'enable_ptt_video' && $auth['can_manage_video']) $can_change = true;
    if ($feature == 'duplex_mode') $can_change = true;

    if ($can_change) {
        try {
            $pdo->beginTransaction();
            $stmtTarget = $pdo->prepare("SELECT name FROM public.users WHERE id = ?");
            $stmtTarget->execute([$u_id]);
            $target_name = $stmtTarget->fetchColumn() ?: $u_id;

            $sql_upsert = "INSERT INTO public.user_app_permissions (user_id, $feature, updated_at)
                           VALUES (?, $sql_val, NOW())
                           ON CONFLICT (user_id)
                           DO UPDATE SET $feature = EXCLUDED.$feature, updated_at = NOW()";
            $pdo->prepare($sql_upsert)->execute([$u_id]);

            $stmtLogFeat = $pdo->prepare("INSERT INTO public.admin_activity_logs (admin_id, aksi, keterangan, waktu) VALUES (?, 'UPDATE_FEATURE', ?, NOW())");
            $stmtLogFeat->execute([$current_admin_id, "$status_label " . $feature_names[$feature] . " untuk: $target_name ($u_id)"]);

            $p = $pdo->prepare("SELECT * FROM public.user_app_permissions WHERE user_id = ?");
            $p->execute([$u_id]);
            $row = $p->fetch();

            $pdo->commit();
            notifyPermissionUpdate($u_id, $row['enable_maps'], $row['enable_p2p'], $row['enable_ptt_video'], $row['duplex_mode']);
            echo json_encode(['success' => true]);
        } catch (Exception $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            echo json_encode(['success' => false, 'msg' => am2_safe_error($e, 'users')]);
        }
        exit;
    }
    echo json_encode(['success' => false, 'msg' => 'Akses ditolak']); exit;
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['edit_user'])
        && !am2_admin_owns_user($pdo, $current_admin_id, $admin_role, $_POST['edit_id'] ?? '')) {
    $error_msg = "Akses ditolak.";
    unset($_POST['edit_user']);
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['edit_user'])) {
    $edit_id = $_POST['edit_id'];
    $edit_name = strtoupper(trim($_POST['edit_name']));
    try {
        $pdo->beginTransaction();
        if (!empty($_POST['edit_password'])) {
            $hashed = password_hash($_POST['edit_password'], PASSWORD_BCRYPT);
            $pdo->prepare("UPDATE public.users SET name = ?, password = ?, created_by = ?, updated_at = NOW() WHERE id = ?")->execute([$edit_name, $hashed, $current_admin_id, $edit_id]);
            $ket = "Update nama & password user: $edit_id ($edit_name)";
        } else {
            $pdo->prepare("UPDATE public.users SET name = ?, created_by = ?, updated_at = NOW() WHERE id = ?")->execute([$edit_name, $current_admin_id, $edit_id]);
            $ket = "Update nama user: $edit_id ke $edit_name";
        }

        $pdo->prepare("INSERT INTO public.admin_activity_logs (admin_id, aksi, keterangan, waktu) VALUES (?, 'UPDATE_USER', ?, NOW())")->execute([$current_admin_id, $ket]);

        $pdo->commit();
        $success_msg = "Data $edit_id diperbarui.";
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        $error_msg = am2_safe_error($e, 'users');
    }
}

if (isset($_POST['delete_user'])
        && !am2_admin_owns_user($pdo, $current_admin_id, $admin_role, $_POST['delete_user'])) {
    $error_msg = "Akses ditolak.";
    unset($_POST['delete_user']);
}

if (isset($_POST['delete_user'])) {
    $del_id = $_POST['delete_user'];
    try {
        $pdo->beginTransaction();
        $stmtN = $pdo->prepare("SELECT name FROM public.users WHERE id = ?");
        $stmtN->execute([$del_id]);
        $old_name = $stmtN->fetchColumn();

        $pdo->prepare("UPDATE public.users SET created_by = ? WHERE id = ?")->execute([$current_admin_id, $del_id]);
        $pdo->prepare("DELETE FROM public.users WHERE id = ? AND role = 'user'")->execute([$del_id]);

        $pdo->prepare("INSERT INTO public.admin_activity_logs (admin_id, aksi, keterangan, waktu) VALUES (?, 'DELETE_USER', ?, NOW())")->execute([$current_admin_id, "Menghapus user: $old_name ($del_id)"]);

        $pdo->commit();
        header("Location: users.php?success=deleted"); exit;
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        $error_msg = "Gagal menghapus user.";
    }
}

$search = isset($_GET['search']) ? trim($_GET['search']) : '';
$params = [];
$sql = "SELECT u.*, p.enable_maps, p.enable_p2p, p.enable_ptt_video, p.duplex_mode FROM public.users u
        LEFT JOIN public.user_app_permissions p ON u.id = p.user_id 
        WHERE u.role = 'user'";

if ($admin_role !== 'superadmin') {
    $sql .= " AND u.admin_id = ?";
    $params[] = $current_admin_id;
}

if ($search !== '') {
    $sql .= " AND (u.name ILIKE ? OR u.id ILIKE ?)";
    $params[] = "%$search%";
    $params[] = "%$search%";
}

$stmt_users = $pdo->prepare($sql . " ORDER BY u.created_at DESC");
$stmt_users->execute($params);
$users = $stmt_users->fetchAll();

if ($admin_role === 'superadmin') {
    $all_channels = $pdo->query("SELECT id, display_name FROM public.channels ORDER BY display_name ASC")->fetchAll();
} else {
    $stmt_ch = $pdo->prepare("SELECT DISTINCT c.id, c.display_name FROM public.channels c LEFT JOIN public.admin_managed_channels amc ON c.id = amc.channel_id WHERE c.created_by = ? OR amc.admin_id = ? ORDER BY c.display_name ASC");
    $stmt_ch->execute([$current_admin_id, $current_admin_id]);
    $all_channels = $stmt_ch->fetchAll();
}
?>

<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>User - am²</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="asset/css/am2-ui.css">
    <style>
        body { background-color: var(--color-bg); font-family: 'Segoe UI', sans-serif; }
        .main-content { padding: 20px; transition: 0.3s; }
        .card-custom { background: var(--color-surface); border-radius: 15px; border: 1px solid var(--color-border); box-shadow: var(--am2-shadow-sm); }
        .header-title { font-weight: 800; color: var(--color-text); border-left: 5px solid var(--color-primary); padding-left: 15px; }
        .table thead { background-color: var(--color-sidebar-surface); color: var(--color-sidebar-hover-text); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px; }
        .form-switch .form-check-input { width: 2.5em; height: 1.25em; cursor: pointer; }
        .form-switch .form-check-input:checked { background-color: var(--color-success); border-color: var(--color-success); }

        @media (max-width: 768px) {
            .header-title { font-size: 1.1rem; }

            .card-custom form .col-md-3, .card-custom form .col-md-4, .card-custom form .col-md-2 {
                margin-bottom: 15px;
            }
            .card-custom form .col-md-2 { margin-bottom: 0; }
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
                        <h4 class="header-title m-0">Manajemen User</h4>
                        <div class="am2-hero-actions">
                            <span class="badge am2-hero-pill px-3 py-2 rounded-pill">Total: <?= count($users) ?> User</span>
                        </div>
                    </div>
                </div>
            </div>

            <?php if($success_msg): ?>
                <div class="alert alert-success alert-dismissible fade show small" role="alert">
                    <i class="fas fa-check-circle me-2"></i> <?= $success_msg ?>
                    <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
                </div>
            <?php endif; ?>
            <?php if($error_msg): ?>
                <div class="alert alert-danger alert-dismissible fade show small" role="alert">
                    <i class="fas fa-exclamation-triangle me-2"></i> <?= $error_msg ?>
                    <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
                </div>
            <?php endif; ?>

            <div class="row g-3 g-md-4 mb-4">
                <div class="col-12">
                    <div class="card card-custom toolbar-card p-3 p-md-4">
                        <form method="POST" class="row g-2 g-md-3">
                    <?= am2_csrf_field() ?>
                            <div class="col-md-3">
                                <label class="small fw-bold text-muted">ID / USERNAME</label>
                                <input type="text" name="id" class="form-control form-control-sm" placeholder="Contoh: 12345" required>
                            </div>
                            <div class="col-md-4">
                                <label class="small fw-bold text-muted">NAMA LENGKAP</label>
                                <input type="text" name="name" class="form-control form-control-sm" placeholder="Nama User" style="text-transform: uppercase;" required>
                            </div>
                            <div class="col-md-3">
                                <label class="small fw-bold text-muted">PASSWORD</label>
                                <div class="input-group input-group-sm">
                                    <input type="password" name="password" id="pass_add" class="form-control" placeholder="******" required>
                                    <span class="input-group-text" style="cursor:pointer" onclick="togglePass('pass_add', this)"><i class="fas fa-eye"></i></span>
                                </div>
                            </div>
                            <div class="col-md-2 d-grid">
                                <button type="submit" name="add_user" class="btn btn-dark btn-sm fw-bold align-self-end mt-2 mt-md-0 py-2 py-md-1">TAMBAH</button>
                            </div>
                        </form>
                    </div>
                </div>
            </div>

            <div class="row g-3 g-md-4 mb-4">
                <div class="col-12">
                    <div class="card card-custom toolbar-card p-3">
                        <form method="GET" class="row g-2">
                            <div class="col-md-10">
                                <div class="input-group input-group-sm">
                                    <span class="input-group-text bg-white border-end-0"><i class="fas fa-search text-muted"></i></span>
                                    <input type="text" name="search" class="form-control border-start-0" placeholder="Cari berdasarkan Nama atau ID..." value="<?= htmlspecialchars($search) ?>">
                                </div>
                            </div>
                            <div class="col-md-2 d-grid">
                                <button type="submit" class="btn btn-primary btn-sm py-2 py-md-1">CARI</button>
                            </div>
                        </form>
                    </div>
                </div>
            </div>

            <div class="row g-3 g-md-4 mb-4">
                <div class="col-12">
                    <div class="card card-custom overflow-hidden">
                        <div class="table-responsive">
                            <table class="table table-hover align-middle mb-0 data-table">
                        <thead>
                            <tr>
                                <th class="px-4 py-3">USER</th>
                                <th class="text-center">FULL-Duplex</th>
                                <th class="text-center">Maps</th>
                                <th class="text-center">PTP</th>
                                <th class="text-center">Video</th>
                                <th class="text-center">Aksi</th>
                            </tr>
                        </thead>
                        <tbody>
                            <?php if (count($users) > 0): ?>
                                <?php foreach ($users as $u): ?>
                                <tr>
                                    <td data-label="User" class="px-4" onclick="openChannelModal(<?= htmlspecialchars(json_encode((string)$u['id']), ENT_QUOTES, 'UTF-8') ?>, <?= htmlspecialchars(json_encode((string)$u['name']), ENT_QUOTES, 'UTF-8') ?>)" style="cursor: pointer;">
                                        <div class="fw-bold text-dark text-decoration-underline"><?= htmlspecialchars($u['name']) ?></div>
                                        <div class="text-muted" style="font-size: 0.7rem;">ID: <?= htmlspecialchars($u['id']) ?></div>
                                    </td>
                                    <td data-label="Duplex" class="text-center">
                                        <div class="form-check form-switch d-inline-block">
                                            <input class="form-check-input" type="checkbox" <?= ($u['duplex_mode'] === 'FULL DUPLEX') ? 'checked' : '' ?>
                                             onchange="updateDuplex('<?= $u['id'] ?>', this.checked)">
                                        </div>
                                    </td>
                                    <td data-label="Maps" class="text-center">
                                        <div class="form-check form-switch d-inline-block">
                                            <input class="form-check-input" type="checkbox" <?= ($u['enable_maps'] ?? false) ? 'checked' : '' ?>
                                            <?= !$auth['can_manage_maps'] ? 'disabled' : '' ?> onchange="updateFeature('<?= $u['id'] ?>', 'enable_maps', this.checked)">
                                        </div>
                                    </td>
                                    <td data-label="PTP" class="text-center">
                                        <div class="form-check form-switch d-inline-block">
                                            <input class="form-check-input" type="checkbox" <?= ($u['enable_p2p'] ?? false) ? 'checked' : '' ?>
                                            <?= !$auth['can_manage_p2p'] ? 'disabled' : '' ?> onchange="updateFeature('<?= $u['id'] ?>', 'enable_p2p', this.checked)">
                                        </div>
                                    </td>
                                    <td data-label="Video" class="text-center">
                                        <div class="form-check form-switch d-inline-block">
                                            <input class="form-check-input" type="checkbox" <?= ($u['enable_ptt_video'] ?? false) ? 'checked' : '' ?>
                                            <?= !$auth['can_manage_video'] ? 'disabled' : '' ?> onchange="updateFeature('<?= $u['id'] ?>', 'enable_ptt_video', this.checked)">
                                        </div>
                                    </td>
                                    <td data-label="Aksi" class="text-center">
                                        <div class="btn-group user-action-group">
                                            <button type="button" class="btn btn-sm btn-light border btn-action-mobile" onclick="event.stopPropagation(); openEditModal(<?= htmlspecialchars(json_encode((string)$u['id']), ENT_QUOTES, 'UTF-8') ?>, <?= htmlspecialchars(json_encode((string)$u['name']), ENT_QUOTES, 'UTF-8') ?>)">
                                                <i class="fas fa-edit text-primary"></i> <span class="d-md-none">EDIT</span>
                                            </button>
                                            <form method="POST" class="d-inline" onsubmit="return confirm('Hapus user ini?')">
                                                <?= am2_csrf_field() ?>
                                                <input type="hidden" name="delete_user" value="<?= htmlspecialchars($u['id'], ENT_QUOTES, 'UTF-8') ?>">
                                                <button type="submit" class="btn btn-sm btn-light border btn-danger-soft">
                                                    <i class="fas fa-trash text-danger"></i> <span class="d-md-none">HAPUS</span>
                                                </button>
                                            </form>
                                        </div>
                                    </td>
                                </tr>
                                <?php endforeach; ?>
                            <?php else: ?>
                                <tr><td data-label="" colspan="6" class="text-center py-4 text-muted small">Data tidak ditemukan.</td></tr>
                            <?php endif; ?>
                        </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        </main>
    </div>
</div>

<div class="modal fade" id="editModal" tabindex="-1">
    <div class="modal-dialog modal-dialog-centered">
        <form method="POST" class="modal-content border-0 shadow-lg" style="border-radius: 15px;">
                    <?= am2_csrf_field() ?>
            <div class="modal-header border-0 pb-0">
                 <h6 class="fw-bold mb-0">Update Data User</h6>
                 <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
                <input type="hidden" name="edit_id" id="edit_id">
                <div class="mb-3">
                    <label class="small fw-bold">Nama Lengkap</label>
                    <input type="text" name="edit_name" id="edit_name" class="form-control" style="text-transform: uppercase;" required>
                </div>
                <div class="mb-3">
                    <label class="small fw-bold">Password Baru (Kosongkan jika tidak ganti)</label>
                    <div class="input-group">
                        <input type="password" name="edit_password" id="pass_edit" class="form-control" placeholder="******">
                        <span class="input-group-text" style="cursor:pointer" onclick="togglePass('pass_edit', this)"><i class="fas fa-eye"></i></span>
                    </div>
                </div>
            </div>
            <div class="modal-footer border-0 pt-0 d-flex gap-2">
                <button type="button" class="btn btn-light flex-fill py-2" data-bs-dismiss="modal">Batal</button>
                <button type="submit" name="edit_user" class="btn btn-dark flex-fill py-2">Simpan Perubahan</button>
            </div>
        </form>
    </div>
</div>

<div class="modal fade" id="channelModal" tabindex="-1">
    <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content border-0 shadow-lg" style="border-radius: 15px;">
            <div class="modal-header bg-light border-0">
                <h6 class="fw-bold mb-0"><i class="fas fa-broadcast-tower me-2"></i> Akses Channel: <span id="ch_user_name"></span></h6>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
                <input type="hidden" id="ch_user_id">
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <label class="small fw-bold text-muted">DAFTAR CHANNEL</label>
                    <div class="form-check">
                        <input class="form-check-input" type="checkbox" id="selectAllChannels">
                        <label class="form-check-label small fw-bold" for="selectAllChannels">Pilih Semua</label>
                    </div>
                </div>
                <div id="quickChannelList" class="choice-list" style="max-height: 300px; overflow-y: auto; padding: 10px;">
                    <?php foreach ($all_channels as $c): ?>
                    <label class="d-flex align-items-center p-2 border-bottom" style="cursor: pointer;">
                        <input type="checkbox" class="quick-ch-checkbox me-3" value="<?= $c['id'] ?>">
                        <span class="small fw-bold text-dark"><?= htmlspecialchars($c['display_name']) ?></span>
                    </label>
                    <?php endforeach; ?>
                </div>
            </div>
            <div class="modal-footer border-0">
                <button type="button" class="btn btn-light btn-sm px-4" data-bs-dismiss="modal">Batal</button>
                <button type="button" class="btn btn-dark btn-sm px-4" onclick="saveQuickChannels()">Simpan Akses</button>
            </div>
        </div>
    </div>
</div>

<div class="toast-container position-fixed bottom-0 end-0 p-3">
    <div id="liveToast" class="toast align-items-center text-white bg-success border-0 shadow-lg" role="alert" aria-live="assertive" aria-atomic="true">
        <div class="d-flex">
            <div class="toast-body" id="toastMsg">Izin fitur diperbarui secara real-time.</div>
            <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
        </div>
    </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script>
    const AM2_CSRF = <?= json_encode(am2_csrf_token()) ?>;
    const toastObj = new bootstrap.Toast(document.getElementById('liveToast'));
    const channelModal = bootstrap.Modal.getOrCreateInstance(document.getElementById('channelModal'));

    function getEditModalInstance() {
        const modalEl = document.getElementById('editModal');
        return modalEl ? bootstrap.Modal.getOrCreateInstance(modalEl) : null;
    }

    function togglePass(inputId, iconEl) {
        const input = document.getElementById(inputId);
        const icon = iconEl.querySelector('i');
        if (input.type === "password") {
            input.type = "text";
            icon.classList.replace('fa-eye', 'fa-eye-slash');
        } else {
            input.type = "password";
            icon.classList.replace('fa-eye-slash', 'fa-eye');
        }
    }

    function updateFeature(uId, feature, val) {
        const fd = new FormData();
        fd.append('update_feature', '1');
        fd.append('_csrf', AM2_CSRF);
        fd.append('u_id', uId);
        fd.append('feature', feature);
        fd.append('val', val);

        fetch('users.php', { method: 'POST', body: fd })
        .then(res => res.json())
        .then(data => {
            if(data.success) {
                toastObj.show();
            } else {
                alert(data.msg);
                location.reload();
            }
        }).catch(() => location.reload());
    }

    function updateDuplex(uId, isFull) {
        const mode = isFull ? 'FULL DUPLEX' : 'HALF DUPLEX';
        const fd = new FormData();
        fd.append('update_feature', '1');
        fd.append('_csrf', AM2_CSRF);
        fd.append('u_id', uId);
        fd.append('feature', 'duplex_mode');
        fd.append('val', mode);

        fetch('users.php', { method: 'POST', body: fd })
        .then(res => res.json())
        .then(data => {
            if(data.success) {
                toastObj.show();
            } else {
                alert(data.msg);
                location.reload();
            }
        }).catch(() => location.reload());
    }

    function openEditModal(id, name) {
        document.getElementById('edit_id').value = id;
        document.getElementById('edit_name').value = name;
        document.getElementById('pass_edit').value = "";
        const modal = getEditModalInstance();
        if (modal) modal.show();
    }

    function openChannelModal(id, name) {
        document.getElementById('ch_user_id').value = id;
        document.getElementById('ch_user_name').innerText = name;

        document.querySelectorAll('.quick-ch-checkbox').forEach(cb => cb.checked = false);
        document.getElementById('selectAllChannels').checked = false;

        fetch(`users.php?get_user_channels=1&u_id=${id}`)
        .then(res => res.json())
        .then(data => {
            data.forEach(chId => {
                const cb = document.querySelector(`.quick-ch-checkbox[value="${chId}"]`);
                if(cb) cb.checked = true;
            });
            updateSelectAllState();
            channelModal.show();
        });
    }

    document.getElementById('selectAllChannels').addEventListener('change', function() {
        document.querySelectorAll('.quick-ch-checkbox').forEach(cb => cb.checked = this.checked);
    });

    document.querySelectorAll('.quick-ch-checkbox').forEach(cb => {
        cb.addEventListener('change', updateSelectAllState);
    });

    function updateSelectAllState() {
        const total = document.querySelectorAll('.quick-ch-checkbox').length;
        const checked = document.querySelectorAll('.quick-ch-checkbox:checked').length;
        document.getElementById('selectAllChannels').checked = (total > 0 && total === checked);
    }

    function saveQuickChannels() {
        const userId = document.getElementById('ch_user_id').value;
        const selected = Array.from(document.querySelectorAll('.quick-ch-checkbox:checked')).map(cb => cb.value);

        const fd = new FormData();
        fd.append('save_user_channels', '1');
        fd.append('_csrf', AM2_CSRF);
        fd.append('u_id', userId);
        fd.append('channels', JSON.stringify(selected));

        fetch('users.php', { method: 'POST', body: fd })
        .then(res => res.json())
        .then(data => {
            if(data.success) {
                toastObj.show();
                channelModal.hide();
            } else {
                alert(data.msg);
            }
        });
    }
</script>
</body>
</html>
