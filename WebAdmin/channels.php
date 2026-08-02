<?php
require_once 'auth.php';
require_once 'config.php';



$success_msg = "";
$error_msg = "";
$current_admin_id = $_SESSION['admin_id'];
$role_user = $_SESSION['admin_role'];

function syncUserChannels($userId) {
    $url = AM2_NODE_BASE . "/api/admin/sync-channels?userId=" . urlencode($userId);
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 2);
        curl_setopt($ch, CURLOPT_HTTPHEADER, array_filter([trim(am2_node_auth_header())]));
        @curl_exec($ch);
        curl_close($ch);
    } else {
        $options = ['http' => ['timeout' => 2, 'header' => am2_node_auth_header()]];
        $context = stream_context_create($options);
        @file_get_contents($url, false, $context);
    }
}

if (isset($_GET['ajax_action'])) {
    header('Content-Type: application/json');
    if ($_GET['ajax_action'] === 'get_channel_users') {
        $ch_id = (int)$_GET['channel_id'];
        $stmt = $pdo->prepare("SELECT user_id FROM public.user_channels WHERE channel_id = ?");
        $stmt->execute([$ch_id]);
        echo json_encode($stmt->fetchAll(PDO::FETCH_COLUMN));
        exit;
    }
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['add_channel'])) {
    $display_name = strtoupper(trim($_POST['display_name']));
    $name = strtolower(str_replace(' ', '_', $display_name));
    $category = 'public';

    try {
        $stmt = $pdo->prepare("INSERT INTO public.channels (name, display_name, category, created_by) VALUES (?, ?, ?, ?)");
        $stmt->execute([$name, $display_name, $category, $current_admin_id]);
        $success_msg = "Channel <strong>$display_name</strong> berhasil dibuat.";
    } catch (PDOException $e) {
        $error_msg = ($e->getCode() == 23505) ? "Gagal: Nama channel sudah terdaftar." : "Error: " . am2_safe_error($e, 'channels');
    }
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['save_channel_access'])) {
    $ch_id = (int)$_POST['manage_ch_id'];
    $selected_users = $_POST['users'] ?? [];

    try {
        $pdo->beginTransaction();

        $stmt_old = $pdo->prepare("SELECT user_id FROM public.user_channels WHERE channel_id = ?");
        $stmt_old->execute([$ch_id]);
        $old_users = $stmt_old->fetchAll(PDO::FETCH_COLUMN);

        if (strtolower($role_user) === 'superadmin') {
            $pdo->prepare("DELETE FROM public.user_channels WHERE channel_id = ?")->execute([$ch_id]);
        } else {
            $pdo->prepare("DELETE FROM public.user_channels WHERE channel_id = ? AND user_id IN (SELECT id FROM public.users WHERE admin_id = ?)")
                ->execute([$ch_id, $current_admin_id]);
        }

        if (!empty($selected_users)) {
            $stmt_ins = $pdo->prepare("INSERT INTO public.user_channels (user_id, channel_id, is_default, permission) VALUES (?, ?, 'false', 'FULL DUPLEX')");
            foreach ($selected_users as $u_id) {
                $stmt_ins->execute([$u_id, $ch_id]);
            }
        }

        $pdo->commit();

        $all_affected_users = array_unique(array_merge($old_users, $selected_users));
        foreach ($all_affected_users as $uid) {
            syncUserChannels($uid);
        }

        $success_msg = "Izin akses channel berhasil diperbarui.";
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        $error_msg = "Gagal menyimpan akses: " . am2_safe_error($e, 'channels');
    }
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['edit_channel'])) {
    $edit_id = (int)$_POST['edit_id'];
    $edit_display = strtoupper(trim($_POST['edit_display_name']));
    $edit_category = 'public';

    try {
        if (strtolower($role_user) === 'superadmin') {
            $stmt = $pdo->prepare("UPDATE public.channels SET display_name = ?, category = ? WHERE id = ?");
            $stmt->execute([$edit_display, $edit_category, $edit_id]);
        } else {
            $stmt = $pdo->prepare("UPDATE public.channels SET display_name = ?, category = ? WHERE id = ? AND created_by = ?");
            $stmt->execute([$edit_display, $edit_category, $edit_id, $current_admin_id]);
        }
        $success_msg = "Perubahan channel berhasil disimpan.";
    } catch (PDOException $e) {
        $error_msg = "Gagal memperbarui channel: " . am2_safe_error($e, 'channels');
    }
}

if (isset($_POST['delete_channel'])) {
    $id = (int)$_POST['delete_channel'];
    try {
        $pdo->beginTransaction();
        $stmt_get = $pdo->prepare("SELECT name FROM public.channels WHERE id = ?");
        $stmt_get->execute([$id]);
        $channel_info = $stmt_get->fetch(PDO::FETCH_ASSOC);
        if ($channel_info) {
            $channel_name = $channel_info['name'];
            $pdo->prepare("UPDATE public.users SET current_channel = NULL WHERE current_channel = ?")->execute([$channel_name]);
            $pdo->prepare("DELETE FROM public.ptt_logs WHERE channel_id = ?")->execute([$id]);
            $pdo->prepare("DELETE FROM public.admin_managed_channels WHERE channel_id = ?")->execute([$id]);
            $pdo->prepare("DELETE FROM public.user_channels WHERE channel_id = ?")->execute([$id]);

            if (strtolower($role_user) === 'superadmin') {
                $stmt_del = $pdo->prepare("DELETE FROM public.channels WHERE id = ?");
                $stmt_del->execute([$id]);
            } else {
                $stmt_del = $pdo->prepare("DELETE FROM public.channels WHERE id = ? AND created_by = ?");
                $stmt_del->execute([$id, $current_admin_id]);
            }

            if ($stmt_del->rowCount() > 0) {
                $pdo->commit();
                header("Location: channels.php?success=deleted"); exit;
            }
        }
        $pdo->rollBack();
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        $error_msg = "Gagal menghapus: " . am2_safe_error($e, 'channels');
    }
}

try {
    if (strtolower($role_user) === 'superadmin') {
        $stmt = $pdo->prepare("
            SELECT c.*, a.username as creator_name, 'OWNER' as ownership_type,
            (SELECT COUNT(*) FROM public.users u WHERE u.current_channel = c.name AND u.status = 'online') as online_count,
            (SELECT COUNT(*) FROM public.user_channels uc WHERE uc.channel_id = c.id) as total_access
            FROM public.channels c 
            LEFT JOIN public.admin a ON c.created_by = a.id
            ORDER BY c.display_name ASC
        ");
        $stmt->execute();
    } else {
        $stmt = $pdo->prepare("
            SELECT c.*, a.username as creator_name, 
            CASE WHEN c.created_by = ? THEN 'OWNER' ELSE 'DELEGATED' END as ownership_type,
            (SELECT COUNT(*) FROM public.users u WHERE u.current_channel = c.name AND u.status = 'online') as online_count,
            (SELECT COUNT(*) FROM public.user_channels uc WHERE uc.channel_id = c.id AND uc.user_id IN (SELECT id FROM public.users WHERE admin_id = ?)) as total_access
            FROM public.channels c
            LEFT JOIN public.admin a ON c.created_by = a.id
            LEFT JOIN public.admin_managed_channels amc ON c.id = amc.channel_id
            WHERE c.created_by = ? OR amc.admin_id = ?
            ORDER BY ownership_type DESC, c.display_name ASC
        ");
        $stmt->execute([$current_admin_id, $current_admin_id, $current_admin_id, $current_admin_id]);
    }
    $channels = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $count_owned = 0; $count_delegated = 0;
    foreach ($channels as $c) {
        if ($c['ownership_type'] === 'OWNER') $count_owned++; else $count_delegated++;
    }
} catch (PDOException $e) { $channels = []; $count_owned = 0; $count_delegated = 0; }

$role_check = strtolower($role_user);
if ($role_check === 'superadmin') {
    $stmt_u = $pdo->query("SELECT id, name FROM public.users WHERE role = 'user' ORDER BY name ASC");
} else {
    $stmt_u = $pdo->prepare("SELECT id, name FROM public.users WHERE role = 'user' AND admin_id = ? ORDER BY name ASC");
    $stmt_u->execute([$current_admin_id]);
}
$managed_users = $stmt_u->fetchAll(PDO::FETCH_ASSOC);
?>

<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Manajemen Channel - am²</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="asset/css/am2-ui.css">
    <style>
        body { background-color: var(--color-bg); font-family: 'Segoe UI', sans-serif; }
        .main-content { padding: 20px; }
        .header-title { font-weight: 800; color: var(--color-text); border-bottom: 3px solid var(--color-primary); display: inline-block; padding-bottom: 5px; margin-bottom: 20px; }
        .card-table { background: var(--color-surface); border-radius: 12px; border: 1px solid var(--color-border); box-shadow: var(--am2-shadow-sm); overflow: hidden; }
        .stat-card { border-radius: 12px; border: 1px solid var(--color-border); padding: 15px; background: var(--color-surface); box-shadow: var(--am2-shadow-sm); }
        .table thead { background-color: var(--color-sidebar-surface); color: var(--color-sidebar-hover-text); font-size: 0.85rem; }
        .table td { vertical-align: middle; padding: 10px 15px; font-size: 0.9rem; }
        .btn-am2 { background-color: var(--color-primary); color: var(--color-on-primary); border: none; font-weight: 600; transition: 0.2s; }
        .btn-am2:hover { background-color: var(--color-primary-hover); color: var(--color-on-primary); }
        .online-dot { height: 8px; width: 8px; background-color: var(--color-success); border-radius: 50%; display: inline-block; margin-right: 5px; }
        .search-box input { padding-left: 40px; border-radius: 20px; border: 1px solid var(--color-border-strong); height: 40px; }
        .search-box i { position: absolute; left: 15px; top: 50%; transform: translateY(-50%); color: var(--color-text-subtle); }
        .badge-compact { font-size: 0.7rem; padding: 3px 8px; }
        .user-item { cursor: pointer; padding: 8px 12px; border-radius: 8px; transition: 0.2s; border: 1px solid transparent; }
        .user-item:hover { background: var(--color-surface-muted); border-color: var(--color-border-strong); }
        .user-item.selected { background: var(--color-info-surface); border-color: var(--color-secondary); }
        .btn-manage-access {
            background-color: var(--color-info-surface);
            color: var(--color-secondary);
            border: 1px solid color-mix(in srgb, var(--color-secondary) 36%, var(--color-border));
            font-size: 0.8rem;
            font-weight: 700;
            padding: 5px 15px;
            border-radius: 20px;
            transition: 0.2s;
        }
        .btn-manage-access:hover {
            background-color: var(--color-secondary);
            color: var(--color-on-secondary);
        }
    </style>
</head>
<body>

<div class="container-fluid">
    <div class="row">
        <?php include 'sidebar.php'; ?>

        <main class="col-md-10 ms-sm-auto px-md-4 py-4 main-content">
            <div class="row g-3 g-md-4 mb-4">
                <div class="col-12">
                    <div class="app-toolbar am2-page-hero d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-3">
                        <h4 class="header-title m-0"><i class="fas fa-broadcast-tower me-2"></i> Manajemen Channel</h4>
                        <div class="am2-hero-actions">
                            <div class="am2-hero-stat">
                                <small class="d-block" style="font-size: 0.65rem;">MILIK SAYA</small>
                                <span class="fw-bold"><?= $count_owned ?></span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <?php if($success_msg): ?>
                <div class="alert alert-success border-0 py-2 shadow-sm alert-dismissible fade show small"><i class="fas fa-check-circle me-2"></i><?= $success_msg ?><button type="button" class="btn-close" data-bs-dismiss="alert"></button></div>
            <?php endif; ?>
            <?php if($error_msg): ?>
                <div class="alert alert-danger border-0 py-2 shadow-sm alert-dismissible fade show small"><i class="fas fa-exclamation-triangle me-2"></i><?= $error_msg ?><button type="button" class="btn-close" data-bs-dismiss="alert"></button></div>
            <?php endif; ?>

            <div class="row g-3 g-md-4 mb-4">
                <div class="col-lg-7">
                    <div class="card card-table toolbar-card p-3">
                        <form method="POST" class="row g-2 align-items-end">
                    <?= am2_csrf_field() ?>
                            <div class="col-md-9">
                                <label class="small fw-bold text-muted">NAMA CHANNEL</label>
                                <input type="text" name="display_name" class="form-control form-control-sm text-uppercase" placeholder="Contoh: Channel Test" required>
                            </div>
                            <div class="col-md-3">
                                <button type="submit" name="add_channel" class="btn btn-sm btn-am2 w-100 py-2">TAMBAH</button>
                            </div>
                        </form>
                    </div>
                </div>
                <div class="col-lg-5 d-flex align-items-end justify-content-lg-end">
                    <div class="search-box position-relative w-100" style="max-width: 350px;">
                        <i class="fas fa-search"></i>
                        <input type="text" id="searchInput" class="form-control shadow-sm border-0" placeholder="Cari channel...">
                    </div>
                </div>
            </div>

            <div class="row g-3 g-md-4 mb-4">
                <div class="col-12">
                    <div class="card card-table">
                        <div class="table-responsive">
                            <table class="table table-hover mb-0 data-table" id="channelTable">
                        <thead>
                            <tr>
                                <th class="ps-4">NAMA CHANNEL</th>
                                <th>ID CHANNEL</th>
                                <th class="text-center">AKSES USER</th>
                                <th>PEMBUAT</th>
                                <th class="text-center pe-4">AKSI</th>
                            </tr>
                        </thead>
                        <tbody>
                            <?php foreach ($channels as $c): ?>
                            <tr class="channel-row">
                                <td data-label="Nama Channel" class="ps-4 fw-bold text-dark">
                                    <?= htmlspecialchars($c['display_name']) ?>
                                    <?php if($c['ownership_type'] === 'DELEGATED'): ?>
                                        <i class="fas fa-share-nodes text-warning ms-1" title="Delegasi"></i>
                                    <?php endif; ?>
                                </td>
                                <td data-label="ID Channel" class="text-muted small"><?= htmlspecialchars($c['name']) ?></td>
                                <td data-label="Akses User" class="text-center">
                                    <button type="button" class="btn-manage-access" onclick="openAccessModal(<?= $c['id'] ?>, '<?= htmlspecialchars($c['display_name']) ?>')">
                                        <i class="fas fa-users-cog me-1"></i> <?= $c['total_access'] ?> User
                                    </button>
                                </td>
                                <td data-label="Pembuat" class="small text-muted"><?= htmlspecialchars($c['creator_name'] ?? 'System') ?></td>
                                <td data-label="Aksi" class="text-center pe-4">
                                    <div class="btn-group">
                                        <button class="btn btn-sm btn-outline-secondary" onclick="openEditModal(<?= $c['id'] ?>, '<?= htmlspecialchars($c['display_name']) ?>')"><i class="fas fa-edit"></i></button>
                                        <form method="POST" class="d-inline" onsubmit="return confirm('Hapus channel?')">
                                            <?= am2_csrf_field() ?>
                                            <input type="hidden" name="delete_channel" value="<?= (int) $c['id'] ?>">
                                            <button type="submit" class="btn btn-sm btn-outline-danger btn-danger-soft"><i class="fas fa-trash"></i></button>
                                        </form>
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

<div class="modal fade" id="accessModal" tabindex="-1">
    <div class="modal-dialog modal-dialog-centered">
        <form method="POST" class="modal-content border-0 shadow-lg" style="border-radius: 15px;">
                    <?= am2_csrf_field() ?>
            <div class="modal-header bg-light border-0">
                <h6 class="fw-bold mb-0 text-navy"><i class="fas fa-user-shield me-2"></i> Kelola Akses User</h6>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
                <div class="bg-primary-subtle p-3 rounded-3 mb-3 border border-primary-subtle">
                    <small class="text-muted d-block text-uppercase fw-bold" style="font-size: 10px;">Channel</small>
                    <h5 id="target_ch_name" class="fw-bold text-navy m-0"></h5>
                    <input type="hidden" name="manage_ch_id" id="target_ch_id">
                </div>

                <div class="d-flex justify-content-between align-items-center mb-2">
                    <label class="small fw-bold text-muted">DAFTAR USER (<?= count($managed_users) ?>)</label>
                    <div class="form-check">
                        <input class="form-check-input" type="checkbox" id="selectAllUsers">
                        <label class="form-check-label small fw-bold" for="selectAllUsers">Pilih Semua</label>
                    </div>
                </div>

                <div id="userListContainer" class="choice-list" style="max-height: 350px; overflow-y: auto; padding: 10px;">
                    <?php foreach ($managed_users as $u): ?>
                    <label class="user-item d-flex align-items-center mb-1">
                        <input type="checkbox" name="users[]" value="<?= $u['id'] ?>" class="user-checkbox me-3">
                        <div class="flex-grow-1">
                            <span class="fw-bold d-block" style="font-size: 14px;"><?= htmlspecialchars($u['name']) ?></span>
                            <small class="text-muted" style="font-size: 11px;">#<?= $u['id'] ?></small>
                        </div>
                    </label>
                    <?php endforeach; ?>
                </div>
            </div>
            <div class="modal-footer border-0">
                <button type="submit" name="save_channel_access" class="btn btn-navy w-100 py-3 rounded-3 fw-bold shadow">
                    <i class="fas fa-save me-2"></i> SIMPAN PERUBAHAN AKSES
                </button>
            </div>
        </form>
    </div>
</div>

<div class="modal fade" id="editModal" tabindex="-1">
    <div class="modal-dialog modal-dialog-centered">
        <form method="POST" class="modal-content border-0 shadow-lg" style="border-radius: 15px;">
                    <?= am2_csrf_field() ?>
            <div class="modal-header border-0 pb-0">
                <h6 class="fw-bold mb-0">Update Channel</h6>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
                <input type="hidden" name="edit_id" id="edit_id">
                <div class="mb-3">
                    <label class="small fw-bold">NAMA DISPLAY</label>
                    <input type="text" name="edit_display_name" id="edit_display_name" class="form-control text-uppercase" required>
                </div>
            </div>
            <div class="modal-footer border-0 pt-0">
                <button type="submit" name="edit_channel" class="btn btn-am2 w-100 py-2">SIMPAN PERUBAHAN</button>
            </div>
        </form>
    </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script>
    const accessModal = new bootstrap.Modal(document.getElementById('accessModal'));

    async function openAccessModal(id, name) {
        document.getElementById('target_ch_id').value = id;
        document.getElementById('target_ch_name').innerText = name;

        document.querySelectorAll('.user-checkbox').forEach(cb => {
            cb.checked = false;
            cb.closest('.user-item').classList.remove('selected');
        });
        document.getElementById('selectAllUsers').checked = false;

        try {
            const resp = await fetch(`channels.php?ajax_action=get_channel_users&channel_id=${id}`);
            const userIds = await resp.json();

            userIds.forEach(uid => {
                const cb = document.querySelector(`.user-checkbox[value="${uid}"]`);
                if(cb) {
                    cb.checked = true;
                    cb.closest('.user-item').classList.add('selected');
                }
            });
            updateSelectAllState();
        } catch (e) { console.error(e); }

        accessModal.show();
    }

    document.getElementById('selectAllUsers').addEventListener('change', function() {
        document.querySelectorAll('.user-checkbox').forEach(cb => {
            cb.checked = this.checked;
            cb.closest('.user-item').classList.toggle('selected', this.checked);
        });
    });

    document.querySelectorAll('.user-checkbox').forEach(cb => {
        cb.addEventListener('change', function() {
            this.closest('.user-item').classList.toggle('selected', this.checked);
            updateSelectAllState();
        });
    });

    function updateSelectAllState() {
        const cbs = document.querySelectorAll('.user-checkbox');
        const checked = document.querySelectorAll('.user-checkbox:checked');
        document.getElementById('selectAllUsers').checked = (cbs.length > 0 && cbs.length === checked.length);
    }

    function openEditModal(id, name) {
        document.getElementById('edit_id').value = id;
        document.getElementById('edit_display_name').value = name;
        new bootstrap.Modal(document.getElementById('editModal')).show();
    }

    document.getElementById('searchInput').addEventListener('input', function(e) {
        let kw = e.target.value.toLowerCase();
        document.querySelectorAll('.channel-row').forEach(row => {
            row.style.display = row.innerText.toLowerCase().includes(kw) ? "" : "none";
        });
    });
</script>
</body>
</html>
