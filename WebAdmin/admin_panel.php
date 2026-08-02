<?php
session_start();
require_once 'config.php';

if (!isset($_SESSION['admin_logged_in']) || $_SESSION['admin_role'] !== 'superadmin') {
    header("Location: dashboard.php");
    exit;
}

$success_msg = "";
$error_msg = "";

function notifyNodeServerToRefresh($adminId) {
    $url = AM2_NODE_BASE . "/api/admin/refresh-branch-permissions";
    $data = array('adminId' => $adminId);
    $options = array(
        'http' => array(
            'header'  => "Content-type: application/json\r\n",
            'method'  => 'POST',
            'content' => json_encode($data),
            'timeout' => 2
        )
    );
    $context  = stream_context_create($options);
    @file_get_contents($url, false, $context);
}

if (isset($_GET['delete_id'])) {
    $id_to_delete = (int)$_GET['delete_id'];
    $my_id = (int)$_SESSION['admin_id'];

    try {
        $stmt_check = $pdo->prepare("SELECT role FROM public.admin WHERE id = ?");
        $stmt_check->execute([$id_to_delete]);
        $target = $stmt_check->fetch();

        if (!$target) {
            $error_msg = "Admin tidak ditemukan.";
        } elseif ($target['role'] === 'superadmin') {
            $error_msg = "Keamanan: Akun level Superadmin tidak dapat dihapus!";
        } elseif ($id_to_delete === 1) {
            $error_msg = "Keamanan: Akun Master Sistem tidak dapat dihapus!";
        } else {
            $stmt = $pdo->prepare("DELETE FROM public.admin WHERE id = ? AND id != ?");
            $stmt->execute([$id_to_delete, $my_id]);
            $success_msg = "Akun admin cabang berhasil dihapus.";
        }
    } catch (PDOException $e) {
        $error_msg = "Gagal menghapus: " . am2_safe_error($e, 'admin_panel');
    }
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['save_admin'])) {
    $admin_id = !empty($_POST['admin_id']) ? (int)$_POST['admin_id'] : null;
    $username = trim($_POST['username']);
    $role = $_POST['role'];
    $u_quota = ($role === 'superadmin') ? 999999 : (int)$_POST['user_quota'];
    $c_quota = ($role === 'superadmin') ? 999999 : (int)$_POST['channel_quota'];

    $is_permanent = isset($_POST['is_permanent']);
    $expired_at = $is_permanent ? null : $_POST['expired_at'];

    $can_maps = isset($_POST['can_manage_maps']) ? 'true' : 'false';
    $can_p2p = isset($_POST['can_manage_p2p']) ? 'true' : 'false';
    $can_video = isset($_POST['can_manage_video']) ? 'true' : 'false';

    try {
        if ($admin_id) {
            $sql = "UPDATE public.admin SET username = ?, role = ?, user_quota = ?, channel_quota = ?, expired_at = ?, can_manage_maps = $can_maps, can_manage_p2p = $can_p2p, can_manage_video = $can_video, status = 'active'";
            $params = [$username, $role, $u_quota, $c_quota, $expired_at];

            if (!empty($_POST['password'])) {
                $sql .= ", password_hash = ?";
                $params[] = password_hash($_POST['password'], PASSWORD_BCRYPT);
            }
            $sql .= " WHERE id = ?";
            $params[] = $admin_id;
            $pdo->prepare($sql)->execute($params);

            notifyNodeServerToRefresh($admin_id);
        } else {
            $password = password_hash($_POST['password'], PASSWORD_BCRYPT);
            $stmt = $pdo->prepare("INSERT INTO public.admin (username, password_hash, role, user_quota, channel_quota, expired_at, can_manage_maps, can_manage_p2p, can_manage_video, status) VALUES (?, ?, ?, ?, ?, ?, $can_maps, $can_p2p, $can_video, 'active')");
            $stmt->execute([$username, $password, $role, $u_quota, $c_quota, $expired_at]);
        }
        $success_msg = "Konfigurasi admin berhasil disimpan.";
    } catch (PDOException $e) {
        $error_msg = "Gagal menyimpan: " . am2_safe_error($e, 'admin_panel');
    }
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['update_delegation'])) {
    $target_admin_id = (int)$_POST['target_admin_id'];
    $selected_channels = $_POST['channels'] ?? [];

    try {
        $pdo->beginTransaction();
        $pdo->prepare("DELETE FROM public.admin_managed_channels WHERE admin_id = ?")->execute([$target_admin_id]);

        if (!empty($selected_channels)) {
            $stmt_ch = $pdo->prepare("INSERT INTO public.admin_managed_channels (admin_id, channel_id) VALUES (?, ?)");
            foreach ($selected_channels as $ch_id) {
                $stmt_ch->execute([$target_admin_id, (int)$ch_id]);
            }
        }
        $pdo->commit();
        $success_msg = "Delegasi channel berhasil diperbarui.";
    } catch (PDOException $e) {
        $pdo->rollBack();
        $error_msg = "Gagal delegasi: " . am2_safe_error($e, 'admin_panel');
    }
}

$stmt_list = $pdo->prepare("
    SELECT a.*,
    CASE
        WHEN a.expired_at IS NOT NULL AND a.expired_at < NOW() THEN 'expired'
        ELSE a.status
    END as current_status,
    (
        SELECT json_agg(channel_id) FROM (
            SELECT channel_id FROM public.admin_managed_channels WHERE admin_id = a.id
            UNION
            SELECT id AS channel_id FROM public.channels WHERE created_by = a.id
        ) as combined_channels
    ) as channel_ids
    FROM public.admin a WHERE a.id != ? ORDER BY a.id DESC
");
$stmt_list->execute([$_SESSION['admin_id']]);
$admins = $stmt_list->fetchAll(PDO::FETCH_ASSOC);

foreach ($admins as &$adm) {
    $adm['channel_ids'] = json_decode($adm['channel_ids'] ?? '[]', true) ?: [];
    unset($adm['password_hash']);
}
unset($adm);

$all_channels = $pdo->query("SELECT id, display_name FROM public.channels ORDER BY display_name ASC")->fetchAll(PDO::FETCH_ASSOC);
?>

<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Manajemen Otoritas - am²</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="asset/css/am2-ui.css">
    <style>
        body { background-color: var(--color-bg); font-family: 'Inter', 'Segoe UI', sans-serif; }
        .main-content { padding: 20px; transition: all 0.3s; }
        .card-custom { border-radius: 12px; border: 1px solid var(--color-border); box-shadow: var(--am2-shadow-sm); background: var(--color-surface); }
        .ch-box { max-height: 350px; overflow-y: auto; border: 1px solid var(--color-border); padding: 10px; border-radius: 8px; background: var(--color-surface); }
        .status-expired { background-color: var(--color-danger-surface) !important; }
        .table thead { background: var(--color-sidebar-surface); color: var(--color-sidebar-hover-text); border: none; }
        .table thead th { font-weight: 600; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.5px; border: none; }

        .btn-action { width: 38px; height: 38px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; transition: 0.2s; }
        .btn-action:hover { transform: translateY(-2px); }

        .header-title { font-weight: 800; color: var(--color-text); border-bottom: 4px solid var(--color-primary); display: inline-block; padding-bottom: 5px; }
        .admin-row { cursor: pointer; transition: background 0.2s; }
        .admin-row:hover { background-color: var(--color-surface-muted) !important; }
        .perm-badge { font-size: 0.65rem; padding: 4px 8px; border-radius: 6px; margin-right: 2px; font-weight: 700; letter-spacing: 0.3px; }
        .admin-config-modal .modal-content,
        .admin-delegate-modal .modal-content {
            max-height: min(720px, calc(100dvh - 96px));
        }
        .admin-config-modal .modal-body,
        .admin-delegate-modal .modal-body {
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
        }
        .admin-config-modal .modal-body {
            max-height: min(560px, calc(100dvh - 220px));
        }
        .admin-delegate-modal .modal-body {
            max-height: min(420px, calc(100dvh - 190px));
        }

        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: var(--color-surface-muted); }
        ::-webkit-scrollbar-thumb { background: var(--color-border-strong); border-radius: 10px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--color-text-subtle); }

        @media (max-width: 768px) {
            .header-title { font-size: 1.15rem; }

            .table-responsive { border: none; }

            .btn-action-mobile { width: 100%; height: 45px; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 8px; border-radius: 10px; }
            .action-container { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; width: 100%; }

            .admin-config-modal,
            .admin-delegate-modal {
                margin: 12px auto !important;
                max-width: calc(100% - 24px) !important;
            }

            .admin-config-modal .modal-content,
            .admin-delegate-modal .modal-content {
                border-radius: 15px !important;
                min-height: 0 !important;
            }

            .admin-config-modal .modal-body {
                max-height: min(520px, calc(100dvh - 210px));
            }

            .admin-delegate-modal .modal-body {
                max-height: min(380px, calc(100dvh - 180px));
            }

            .admin-config-modal #featurePerms .row > [class*="col-"] {
                width: 100%;
            }
        }
    </style>
</head>
<body>

<div class="container-fluid">
    <div class="row">
        <?php include 'sidebar.php'; ?>

        <main class="col-md-9 ms-sm-auto col-lg-10 px-md-4 py-4 main-content">
            <div class="row g-3 g-md-4 mb-4">
                <div class="col-12">
                    <div class="app-toolbar am2-page-hero d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-3">
                        <div>
                            <h4 class="header-title m-0"><i class="fas fa-user-shield me-2"></i> Kontrol Otoritas Admin</h4>
                            <p class="am2-hero-subtext small mb-0 mt-1">Manajemen akses dan kuota untuk admin cabang.</p>
                        </div>
                        <button type="button" class="btn btn-primary fw-bold px-4 shadow-sm rounded-pill d-flex align-items-center justify-content-center py-2 am2-hero-action" onclick="openAddModal()">
                            <i class="fas fa-plus-circle me-2"></i> TAMBAH ADMIN
                        </button>
                    </div>
                </div>
            </div>

            <?php if($success_msg): ?>
                <div class="alert alert-success border-0 shadow-sm alert-dismissible fade show small mb-4"><i class="fas fa-check-circle me-2"></i><?= $success_msg ?><button type="button" class="btn-close" data-bs-dismiss="alert"></button></div>
            <?php endif; ?>
            <?php if($error_msg): ?>
                <div class="alert alert-danger border-0 shadow-sm alert-dismissible fade show small mb-4"><i class="fas fa-exclamation-triangle me-2"></i><?= $error_msg ?><button type="button" class="btn-close" data-bs-dismiss="alert"></button></div>
            <?php endif; ?>

            <div class="row g-3 g-md-4 mb-4">
                <div class="col-12">
                    <div class="card card-custom overflow-hidden">
                        <div class="table-responsive">
                            <table class="table table-hover align-middle mb-0 data-table">
                        <thead>
                            <tr>
                                <th class="px-4 py-3">Admin / Username</th>
                                <th>Otoritas Fitur</th>
                                <th class="text-center">Kuota (U/C)</th>
                                <th>Masa Aktif</th>
                                <th class="text-center">Aksi</th>
                            </tr>
                        </thead>
                        <tbody>
                            <?php if (empty($admins)): ?>
                                <tr>
                                    <td data-label="" colspan="5" class="text-center py-5 text-muted">
                                        <i class="fas fa-user-slash fa-3x mb-3 opacity-25"></i>
                                        <p>Belum ada admin cabang yang terdaftar.</p>
                                    </td>
                                </tr>
                            <?php endif; ?>
                            <?php foreach ($admins as $a):
                                $jsonData = htmlspecialchars(json_encode($a), ENT_QUOTES, 'UTF-8');
                            ?>
                            <tr class="<?= $a['current_status'] === 'expired' ? 'status-expired' : '' ?> admin-row"
                                data-id="<?= $a['id'] ?>"
                                data-user="<?= htmlspecialchars($a['username']) ?>"
                                data-role="<?= $a['role'] ?>"
                                data-channels='<?= json_encode($a['channel_ids']) ?>'>
                                <td data-label="Admin / Username" class="px-4">
                                    <div class="d-flex align-items-center">
                                        <div class="bg-light rounded-circle p-2 me-3 d-none d-md-flex align-items-center justify-content-center" style="width: 40px; height: 40px;">
                                            <i class="fas fa-user text-secondary"></i>
                                        </div>
                                        <div>
                                            <div class="fw-bold text-dark"><?= htmlspecialchars($a['username']) ?></div>
                                            <span class="badge <?= $a['current_status'] === 'active' ? 'bg-success' : 'bg-danger' ?> rounded-pill" style="font-size:0.6rem; padding: 3px 8px;">
                                                <?= strtoupper($a['current_status']) ?>
                                            </span>
                                        </div>
                                    </div>
                                </td>
                                <td data-label="Otoritas Fitur">
                                    <?php if($a['role'] === 'admin'): ?>
                                        <div class="d-flex flex-wrap gap-1">
                                            <span class="perm-badge <?= ($a['can_manage_maps'] === true || $a['can_manage_maps'] === 'true') ? 'bg-primary text-white' : 'bg-light text-muted border' ?>">MAPS</span>
                                            <span class="perm-badge <?= ($a['can_manage_p2p'] === true || $a['can_manage_p2p'] === 'true') ? 'bg-primary text-white' : 'bg-light text-muted border' ?>">P2P</span>
                                            <span class="perm-badge <?= ($a['can_manage_video'] === true || $a['can_manage_video'] === 'true') ? 'bg-primary text-white' : 'bg-light text-muted border' ?>">VIDEO</span>
                                        </div>
                                    <?php else: ?>
                                        <span class="small text-primary fw-bold"><i class="fas fa-shield-alt me-1"></i> FULL ACCESS</span>
                                    <?php endif; ?>
                                </td>
                                <td data-label="Kuota (U/C)" class="text-center">
                                    <span class="badge bg-primary-subtle text-primary border border-primary-subtle px-3 py-2">
                                        <?= $a['role'] === 'superadmin' ? '<i class="fas fa-infinity me-1"></i> UNLIMITED' : $a['user_quota'].' / '.$a['channel_quota'] ?>
                                    </span>
                                </td>
                                <td data-label="Masa Aktif" class="small fw-bold text-nowrap">
                                    <?php if($a['expired_at']): ?>
                                        <div class="d-flex align-items-center justify-content-end justify-content-md-start">
                                            <i class="far fa-calendar-alt me-2 text-muted"></i>
                                            <span><?= date('d M Y', strtotime($a['expired_at'])) ?></span>
                                        </div>
                                    <?php else: ?>
                                        <div class="text-primary d-flex align-items-center justify-content-end justify-content-md-start">
                                            <i class="fas fa-infinity me-2"></i> <span>PERMANEN</span>
                                        </div>
                                    <?php endif; ?>
                                </td>
                                <td data-label="Aksi" class="text-center">
                                    <div class="d-flex justify-content-center gap-2 action-container">
                                        <button type="button" class="btn btn-outline-primary btn-action-mobile btn-edit-trigger"
                                                data-admin='<?= $jsonData ?>'
                                                onclick="event.stopPropagation();"
                                                title="Edit Profil">
                                            <i class="fas fa-edit"></i> <span class="d-md-none">EDIT PROFIL</span>
                                        </button>
                                        <a href="?delete_id=<?= $a['id'] ?>"
                                           class="btn btn-outline-danger btn-danger-soft btn-action-mobile"
                                           onclick="event.stopPropagation(); return confirm('Hapus admin ini? Seluruh anggota di bawahnya akan kehilangan akses!')"
                                           title="Hapus">
                                            <i class="fas fa-trash"></i> <span class="d-md-none">HAPUS</span>
                                        </a>
                                    </div>
                                </td>
                            </tr>
                            <?php endforeach; ?>
                        </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        </main>
    </div>
</div>

<div class="modal fade" id="adminModal" tabindex="-1" aria-hidden="true">
    <div class="modal-dialog modal-dialog-centered modal-lg admin-config-modal">
        <form method="POST" class="modal-content border-0 shadow-lg" style="border-radius: 15px;">
            <div class="modal-header bg-light border-0">
                <h6 class="fw-bold m-0 text-navy" id="modalTitle">Konfigurasi Otoritas</h6>
                <button type="button" class="btn-close shadow-none" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
                <input type="hidden" name="admin_id" id="f_id">

                <div class="mb-3">
                    <label class="small fw-bold text-secondary text-uppercase mb-1">Username</label>
                    <div class="input-group">
                        <span class="input-group-text bg-light border-0"><i class="fas fa-user text-muted"></i></span>
                        <input type="text" name="username" id="f_username" class="form-control border-0 bg-light shadow-none" required placeholder="Username admin">
                    </div>
                </div>

                <div class="mb-3">
                    <label class="small fw-bold text-secondary text-uppercase mb-1">Password</label>
                    <div class="input-group">
                        <span class="input-group-text bg-light border-0"><i class="fas fa-lock text-muted"></i></span>
                        <input type="password" name="password" id="f_password" class="form-control border-0 bg-light shadow-none" placeholder="Isi untuk ganti password">
                    </div>
                    <small class="text-muted mt-1 d-block" id="pwHint">Kosongkan jika tidak ingin mengubah password.</small>
                </div>

                <div class="mb-3">
                    <label class="small fw-bold text-secondary text-uppercase mb-1">Role / Otoritas</label>
                    <div class="input-group">
                        <span class="input-group-text bg-light border-0"><i class="fas fa-user-tag text-muted"></i></span>
                        <select name="role" id="f_role" class="form-select border-0 bg-light shadow-none" onchange="toggleQuotaView()">
                            <option value="admin">Admin Cabang (Terbatas)</option>
                            <option value="superadmin">Superadmin (Akses Penuh)</option>
                        </select>
                    </div>
                </div>

                <div id="featurePerms" class="p-3 border rounded mb-3 bg-light border-0 shadow-none">
                    <label class="small fw-bold text-primary text-uppercase mb-3 d-block"><i class="fas fa-check-square me-2"></i>Izin Kelola Fitur (Anggota)</label>
                    <div class="row g-3">
                        <div class="col-4">
                            <div class="form-check form-switch custom-switch">
                                <input class="form-check-input" type="checkbox" name="can_manage_maps" id="f_can_maps" checked>
                                <label class="form-check-label small fw-bold">Maps</label>
                            </div>
                        </div>
                        <div class="col-4">
                            <div class="form-check form-switch custom-switch">
                                <input class="form-check-input" type="checkbox" name="can_manage_p2p" id="f_can_p2p" checked>
                                <label class="form-check-label small fw-bold">P2P</label>
                            </div>
                        </div>
                        <div class="col-4">
                            <div class="form-check form-switch custom-switch">
                                <input class="form-check-input" type="checkbox" name="can_manage_video" id="f_can_video">
                                <label class="form-check-label small fw-bold">Video</label>
                            </div>
                        </div>
                    </div>
                </div>

                <div id="quotaView" class="p-3 bg-light rounded mb-3 border-0">
                    <label class="small fw-bold text-primary text-uppercase mb-3 d-block"><i class="fas fa-chart-pie me-2"></i>Alokasi Kuota</label>
                    <div class="row g-3">
                        <div class="col-6">
                            <label class="small text-muted fw-bold mb-1">KUOTA USER</label>
                            <input type="number" name="user_quota" id="f_user_quota" class="form-control border-0 bg-white" placeholder="0">
                        </div>
                        <div class="col-6">
                            <label class="small text-muted fw-bold mb-1">KUOTA CHANNEL</label>
                            <input type="number" name="channel_quota" id="f_channel_quota" class="form-control border-0 bg-white" placeholder="0">
                        </div>
                    </div>
                </div>

                <div class="mb-2 p-3 border-0 rounded bg-light">
                    <label class="small fw-bold text-primary text-uppercase mb-3 d-block"><i class="fas fa-history me-2"></i>Masa Aktif Akun</label>
                    <div class="form-check form-switch mb-3">
                        <input class="form-check-input" type="checkbox" name="is_permanent" id="f_permanent" onchange="toggleDateInput()">
                        <label class="form-check-label small fw-bold text-dark">AKUN PERMANEN (TANPA EXPIRED)</label>
                    </div>
                    <div id="dateContainer">
                        <div class="input-group">
                            <input type="date" name="expired_at" id="f_expired" class="form-control border-0">
                            <button type="button" class="btn btn-primary" onclick="add30Days()">+30 Hari</button>
                        </div>
                    </div>
                </div>
            </div>
            <div class="modal-footer border-0 pt-0">
                <button type="submit" name="save_admin" class="btn btn-primary w-100 fw-bold py-3 shadow-sm rounded-3">SIMPAN KONFIGURASI</button>
            </div>
        </form>
    </div>
</div>

<div class="modal fade" id="delegateModal" tabindex="-1" aria-hidden="true">
    <div class="modal-dialog modal-dialog-centered admin-delegate-modal">
        <form method="POST" class="modal-content border-0 shadow-lg" style="border-radius: 15px;">
            <div class="modal-header bg-light border-0">
                <div>
                    <h6 class="fw-bold m-0 text-navy">Delegasi Channel</h6>
                    <p class="text-primary small mb-0" id="delegateUserText"></p>
                </div>
                <button type="button" class="btn-close shadow-none" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
                <input type="hidden" name="target_admin_id" id="delegate_admin_id">
                <p class="small text-muted mb-3">Pilih channel yang dapat dikelola oleh admin ini:</p>
                <div class="ch-box shadow-none border-0 bg-light p-2 rounded-3">
                    <?php if (empty($all_channels)): ?>
                        <div class="text-center py-4 text-muted small">Belum ada channel yang dibuat.</div>
                    <?php endif; ?>
                    <?php foreach ($all_channels as $ch): ?>
                    <div class="form-check border-bottom py-3 mx-2">
                        <input class="form-check-input del-check" type="checkbox" name="channels[]" value="<?= $ch['id'] ?>" id="del_ch<?= $ch['id'] ?>">
                        <label class="form-check-label small fw-bold text-dark w-100 cursor-pointer" for="del_ch<?= $ch['id'] ?>">
                            <?= htmlspecialchars($ch['display_name']) ?>
                        </label>
                    </div>
                    <?php endforeach; ?>
                </div>
            </div>
            <div class="modal-footer border-0 pt-0">
                <button type="submit" name="update_delegation" class="btn btn-warning w-100 fw-bold shadow-sm text-white rounded-3 py-3">SIMPAN DELEGASI CHANNEL</button>
            </div>
        </form>
    </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script>
function getAdminModalInstance() {
    const modalEl = document.getElementById('adminModal');
    return modalEl ? bootstrap.Modal.getOrCreateInstance(modalEl) : null;
}

function getDelegateModalInstance() {
    const modalEl = document.getElementById('delegateModal');
    return modalEl ? bootstrap.Modal.getOrCreateInstance(modalEl) : null;
}

function fillAdminModal(data) {
    document.getElementById('modalTitle').innerText = "Edit Otoritas: " + data.username;
    document.getElementById('f_id').value = data.id;
    document.getElementById('f_username').value = data.username;
    document.getElementById('f_password').value = "";
    document.getElementById('f_password').required = false;
    document.getElementById('f_role').value = data.role;
    document.getElementById('f_user_quota').value = data.user_quota || "";
    document.getElementById('f_channel_quota').value = data.channel_quota || "";

    document.getElementById('f_can_maps').checked = (data.can_manage_maps == true || data.can_manage_maps == 'true');
    document.getElementById('f_can_p2p').checked = (data.can_manage_p2p == true || data.can_manage_p2p == 'true');
    document.getElementById('f_can_video').checked = (data.can_manage_video == true || data.can_manage_video == 'true');

    if (data.expired_at) {
        document.getElementById('f_expired').value = data.expired_at.split(' ')[0];
        document.getElementById('f_permanent').checked = false;
    } else {
        document.getElementById('f_permanent').checked = true;
    }

    toggleDateInput();
    toggleQuotaView();
}

window.openAddModal = function() {
    document.getElementById('modalTitle').innerText = "Tambah Admin Baru";
    document.getElementById('f_id').value = "";
    document.getElementById('f_username').value = "";
    document.getElementById('f_password').value = "";
    document.getElementById('f_password').required = true;
    document.getElementById('f_role').value = "admin";
    document.getElementById('f_user_quota').value = "";
    document.getElementById('f_channel_quota').value = "";
    document.getElementById('f_permanent').checked = false;

    document.getElementById('f_can_maps').checked = true;
    document.getElementById('f_can_p2p').checked = true;
    document.getElementById('f_can_video').checked = false;

    const date = new Date();
    date.setDate(date.getDate() + 30);
    document.getElementById('f_expired').value = date.toISOString().split('T')[0];

    toggleDateInput();
    toggleQuotaView();
    const modal = getAdminModalInstance();
    if (modal) modal.show();
};

window.toggleDateInput = function() {
    const isPerm = document.getElementById('f_permanent').checked;
    const dateContainer = document.getElementById('dateContainer');
    if(dateContainer) {
        dateContainer.style.display = isPerm ? 'none' : 'block';
        document.getElementById('f_expired').required = !isPerm;
    }
};

window.add30Days = function() {
    const expInput = document.getElementById('f_expired');
    let currentValue = expInput.value ? new Date(expInput.value) : new Date();
    if (isNaN(currentValue.getTime())) currentValue = new Date();

    currentValue.setDate(currentValue.getDate() + 30);
    expInput.value = currentValue.toISOString().split('T')[0];
};

window.toggleQuotaView = function() {
    const roleEl = document.getElementById('f_role');
    if(!roleEl) return;
    const role = roleEl.value;
    const isSuper = (role === 'superadmin');
    const qv = document.getElementById('quotaView');
    const fp = document.getElementById('featurePerms');
    if(qv) qv.style.display = isSuper ? 'none' : 'block';
    if(fp) fp.style.display = isSuper ? 'none' : 'block';
};

document.addEventListener('DOMContentLoaded', function() {
    const delegateModalObj = getDelegateModalInstance();

    document.querySelectorAll('.admin-row').forEach(row => {
        row.addEventListener('click', function(e) {
            if (e.target.closest('button') || e.target.closest('a')) return;

            const role = this.getAttribute('data-role');
            if (role === 'superadmin') return;

            const adminId = this.getAttribute('data-id');
            const username = this.getAttribute('data-user');

            let channelIds = [];
            try {
                channelIds = JSON.parse(this.getAttribute('data-channels') || '[]');
            } catch (err) { channelIds = []; }

            document.getElementById('delegate_admin_id').value = adminId;
            document.getElementById('delegateUserText').innerText = "Admin: " + username;

            document.querySelectorAll('.del-check').forEach(checkbox => {
                const cid = parseInt(checkbox.value);
                checkbox.checked = Array.isArray(channelIds) && channelIds.includes(cid);
            });

            if (delegateModalObj) delegateModalObj.show();
        });
    });

    document.querySelectorAll('.btn-edit-trigger').forEach(btn => {
        btn.addEventListener('click', function(event) {
            event.stopPropagation();
            let data;
            try {
                data = JSON.parse(this.getAttribute('data-admin') || '{}');
            } catch (err) {
                console.error('Invalid admin modal data', err);
                return;
            }
            fillAdminModal(data);
            const modal = getAdminModalInstance();
            if (modal) modal.show();
        });
    });
});
</script>
</body>
</html>
