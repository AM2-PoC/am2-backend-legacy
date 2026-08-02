<?php
session_start();
require_once 'config.php';

if (!isset($_SESSION['admin_logged_in'])) {
    header("Location: login.php"); exit;
}

$success_msg = "";
$error_msg = "";
$current_admin_id = $_SESSION['admin_id'];
$role_user = $_SESSION['admin_role'];

function syncUserChannels($userId) {
    $url = "http://localhost:5000/api/admin/sync-channels?userId=" . urlencode($userId);
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 2);
        @curl_exec($ch);
        curl_close($ch);
    } else {
        $options = ['http' => ['timeout' => 2]];
        $context = stream_context_create($options);
        @file_get_contents($url, false, $context);
    }
}

function notifyForceLogout($userId) {
    $url = "http://localhost:5000/api/admin/force-logout";
    $data = json_encode(['userId' => $userId]);
    $options = [
        'http' => [
            'header'  => "Content-type: application/json\r\n",
            'method'  => 'POST',
            'content' => $data,
            'timeout' => 2
        ]
    ];
    $context  = stream_context_create($options);
    @file_get_contents($url, false, $context);
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['action']) && $_POST['action'] == 'db_force_logout') {
    $uid_to_kick = $_POST['user_id'];
    try {
        $pdo->beginTransaction();

        $stmtU = $pdo->prepare("SELECT name FROM public.users WHERE id = ?");
        $stmtU->execute([$uid_to_kick]);
        $target_name = $stmtU->fetchColumn() ?: "ID: $uid_to_kick";

        $sqlKick = "UPDATE public.users
                    SET force_logout = TRUE, 
                        status = 'offline', 
                        current_device_id = NULL 
                    WHERE id = ?";
        $stmtKick = $pdo->prepare($sqlKick);
        $stmtKick->execute([$uid_to_kick]);

        $stmtLog = $pdo->prepare("INSERT INTO public.admin_activity_logs (admin_id, aksi, keterangan, waktu) VALUES (?, ?, ?, NOW())");
        $stmtLog->execute([$current_admin_id, 'FORCE_LOGOUT', "Memutus paksa koneksi user: $target_name"]);

        $pdo->commit();

        notifyForceLogout($uid_to_kick);

        header('Content-Type: application/json');
        echo json_encode(['success' => true]);
        exit;
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        header('Content-Type: application/json', true, 500);
        echo json_encode(['success' => false, 'message' => $e->getMessage()]);
        exit;
    }
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['update_multi_access'])) {
    $user_id = $_POST['user_id'];
    $selected_channels = $_POST['channels'] ?? [];
    $default_channel_id = $_POST['default_channel'] ?? null;
    $permissions_input = $_POST['permissions'] ?? [];

    try {
        $pdo->beginTransaction();

        $stmtUser = $pdo->prepare("SELECT name FROM public.users WHERE id = ?");
        $stmtUser->execute([$user_id]);
        $target_name = $stmtUser->fetchColumn() ?: "ID: $user_id";

        $pdo->prepare("DELETE FROM public.user_channels WHERE user_id = ?")->execute([$user_id]);

        $channel_names_added = [];

        if (!empty($selected_channels)) {
            if (!$default_channel_id || !in_array($default_channel_id, $selected_channels)) {
                $default_channel_id = $selected_channels[0];
            }

            $stmtIns = $pdo->prepare("INSERT INTO public.user_channels (user_id, channel_id, is_default, permission) VALUES (?, ?, ?, ?)");
            $stmtChName = $pdo->prepare("SELECT display_name FROM public.channels WHERE id = ?");

            foreach ($selected_channels as $ch_id) {
                $is_default = ($ch_id == $default_channel_id);
                $perm = (isset($permissions_input[$ch_id]) && $permissions_input[$ch_id] == 'RX') ? 'RX' : 'FULL DUPLEX';
                $stmtIns->execute([$user_id, $ch_id, $is_default ? 'true' : 'false', $perm]);
                
                if ($is_default) {
                    $pdo->prepare("UPDATE public.users SET last_channel_id = ? WHERE id = ?")->execute([$ch_id, $user_id]);
                }

                $stmtChName->execute([$ch_id]);
                $c_name = $stmtChName->fetchColumn();
                $channel_names_added[] = $c_name . ($is_default ? " (Main)" : "") . " [$perm]";
            }
            $keterangan_log = "Update akses $target_name ke: " . implode(", ", $channel_names_added);
        } else {
            $pdo->prepare("UPDATE public.users SET last_channel_id = NULL WHERE id = ?")->execute([$user_id]);
            $keterangan_log = "Mencabut semua akses channel dari user: $target_name";
        }

        $stmtLogAccess = $pdo->prepare("INSERT INTO public.admin_activity_logs (admin_id, aksi, keterangan, waktu) VALUES (?, ?, ?, NOW())");
        $stmtLogAccess->execute([$current_admin_id, 'UPDATE_ACCESS', $keterangan_log]);

        $pdo->commit();
        syncUserChannels($user_id);
        $success_msg = "Otoritas akses user berhasil diperbarui.";
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        $error_msg = "Gagal memperbarui database: " . $e->getMessage();
    }
}

if ($role_user !== 'superadmin') {
    $sql_ch = "SELECT DISTINCT c.id, c.display_name
               FROM public.channels c
               LEFT JOIN public.admin_managed_channels amc ON c.id = amc.channel_id
               WHERE c.created_by = ? OR amc.admin_id = ?
               ORDER BY c.display_name ASC";
    $stmt_ch = $pdo->prepare($sql_ch);
    $stmt_ch->execute([$current_admin_id, $current_admin_id]);
} else {
    $stmt_ch = $pdo->query("SELECT id, display_name FROM public.channels ORDER BY display_name ASC");
}
$all_channels = $stmt_ch->fetchAll(PDO::FETCH_ASSOC);

$search = isset($_GET['search']) ? trim($_GET['search']) : '';
$params = [];

$sql_access = "SELECT u.id, u.name, 
               STRING_AGG(CASE WHEN uc.is_default THEN '*' || c.display_name ELSE c.display_name END, ', ' ORDER BY uc.is_default DESC) as allowed_channels,
               json_agg(c.id ORDER BY uc.is_default DESC) as channel_ids_json,
               json_agg(uc.permission ORDER BY uc.is_default DESC) as permissions_json,
               MAX(CASE WHEN uc.is_default THEN uc.channel_id END) as default_id
               FROM public.users u
               LEFT JOIN public.user_channels uc ON u.id = uc.user_id
               LEFT JOIN public.channels c ON uc.channel_id = c.id
               WHERE u.role = 'user'";

if ($role_user !== 'superadmin') {
    $sql_access .= " AND u.admin_id = ?";
    $params[] = $current_admin_id;
}

if ($search !== '') {
    $sql_access .= " AND (u.name ILIKE ? OR u.id::text ILIKE ?)";
    $params[] = "%$search%";
    $params[] = "%$search%";
}

$sql_access .= " GROUP BY u.id, u.name ORDER BY u.name ASC";

$stmt_acc = $pdo->prepare($sql_access);
$stmt_acc->execute($params);
$access_list = $stmt_acc->fetchAll(PDO::FETCH_ASSOC);
?>

<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Akses Channel - am²</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="asset/css/am2-ui.css">
    <style>
        body { background-color: var(--color-bg); font-family: 'Segoe UI', sans-serif; }
        .main-content { padding: 20px; transition: all 0.3s; }
        .card-custom {
            background: var(--color-surface); border-radius: 15px; padding: 25px;
            box-shadow: var(--am2-shadow-sm); border: 1px solid var(--color-border);
            border-top: 5px solid var(--color-primary);
        }
        .header-title { font-weight: 800; color: var(--color-text); text-transform: uppercase; letter-spacing: 1px; }
        .ch-badge {
            display: inline-flex;
            align-items: center;
            max-width: 100%;
            background: var(--color-surface-muted); color: var(--color-text-muted); padding: 4px 12px;
            border-radius: 20px; font-size: 11px; margin: 2px; font-weight: 600;
            line-height: 1.2; overflow-wrap: anywhere; white-space: normal;
        }
        .ch-badge.default { background: var(--color-secondary); color: var(--color-on-secondary); }
        .channel-item {
            cursor: pointer; transition: 0.2s; border-radius: 12px;
            margin-bottom: 8px; border: 2px solid var(--color-border); background: var(--color-surface-muted);
        }
        .access-channel-main,
        .access-channel-text {
            min-width: 0;
        }
        .access-channel-main {
            flex: 1 1 auto;
        }
        .access-channel-text label {
            overflow-wrap: anywhere;
        }
        .access-rx-toggle {
            flex: 0 0 auto;
        }
        .access-row {
            cursor: pointer;
        }
        .channel-item:hover { border-color: var(--color-primary); }
        .channel-item.is-default { background-color: var(--color-warning-surface); border-color: var(--color-primary); }
        .btn-navy { background-color: var(--color-primary); color: var(--color-on-primary); border-radius: 10px; }

        @media (max-width: 768px) {
            .card-custom { padding: 15px; border-radius: 10px; }
            .header-title { font-size: 1.1rem; }
            .table-responsive { border: none; }

            .ch-badge { font-size: 10px; padding: 3px 8px; }

            .modal-dialog { margin: 10px; }
            .channel-item { padding: 10px !important; }
            .access-channel-option {
                align-items: stretch !important;
            }
            .access-rx-toggle {
                justify-content: flex-start;
            }
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
                        <h4 class="header-title m-0"><i class="fas fa-key me-2"></i>Izin Akses User</h4>
                        <form method="GET" class="input-group input-group-sm am2-hero-form shadow-sm">
                            <input type="text" name="search" class="form-control border-0" placeholder="Cari User..." value="<?= htmlspecialchars($search) ?>" style="border-radius: 10px 0 0 10px;">
                            <button class="btn btn-navy" type="submit" style="border-radius: 0 10px 10px 0;"><i class="fas fa-search"></i></button>
                        </form>
                    </div>
                </div>
            </div>

            <?php if($success_msg): ?>
                <div class="alert alert-success border-0 shadow-sm rounded-3 small animate__animated animate__fadeIn"><?= $success_msg ?></div>
            <?php endif; ?>
            <?php if($error_msg): ?>
                <div class="alert alert-danger border-0 shadow-sm rounded-3 small animate__animated animate__fadeIn"><?= $error_msg ?></div>
            <?php endif; ?>

            <div class="row g-3 g-md-4 mb-4">
                <div class="col-12">
                    <div class="card-custom">
                        <div class="table-responsive">
                            <table class="table table-hover align-middle mb-0 data-table">
                        <thead>
                            <tr>
                                <th>ID / USERNAME</th>
                                <th>USER</th>
                                <th>AKSES CHANNEL</th>
                                <th class="text-center">AKSI</th>
                            </tr>
                        </thead>
                        <tbody>
                            <?php foreach ($access_list as $row):
                                $ids_array = json_decode($row['channel_ids_json'] ?? '[]', true) ?: [];
                                $perms_array = json_decode($row['permissions_json'] ?? '[]', true) ?: [];
                                $perm_map = [];
                                foreach($ids_array as $idx => $id) {
                                    if($id) $perm_map[$id] = $perms_array[$idx] ?? 'FULL DUPLEX';
                                }
                            ?>
                            <tr class="access-row"
                                data-user-id="<?= htmlspecialchars($row['id'], ENT_QUOTES, 'UTF-8') ?>"
                                data-user-name="<?= htmlspecialchars($row['name'], ENT_QUOTES, 'UTF-8') ?>"
                                data-current-ids='<?= htmlspecialchars(json_encode($ids_array), ENT_QUOTES, 'UTF-8') ?>'
                                data-default-id="<?= htmlspecialchars($row['default_id'] ?? '', ENT_QUOTES, 'UTF-8') ?>"
                                data-perm-map='<?= htmlspecialchars(json_encode($perm_map), ENT_QUOTES, 'UTF-8') ?>'>
                                <td data-label="ID" class="fw-bold text-navy">#<?= $row['id'] ?></td>
                                <td data-label="USER" class="fw-bold text-uppercase"><?= htmlspecialchars($row['name']) ?></td>
                                <td data-label="AKSES CHANNEL">
                                    <?php if ($row['allowed_channels']):
                                        $ch_names = explode(', ', $row['allowed_channels']);
                                        foreach($ch_names as $idx => $n):
                                            $is_def = (strpos($n, '*') === 0);
                                            $display_n = $is_def ? substr($n, 1) : $n;
                                            $is_rx = ($perms_array[$idx] ?? '') === 'RX';
                                    ?>
                                        <span class="ch-badge <?= $is_def?'default':'' ?>">
                                            <?= htmlspecialchars($display_n) ?>
                                            <?= $is_rx ? '<i class="fas fa-volume-mute ms-1 text-danger"></i>' : '' ?>
                                        </span>
                                    <?php endforeach; else: echo "<span class='text-muted small italic'>Belum ada akses</span>"; endif; ?>
                                </td>
                                <td data-label="Aksi" class="text-center">
                                    <button type="button" class="btn btn-outline-danger btn-danger-soft btn-sm rounded-pill px-3" onclick="event.stopPropagation(); forceLogout(<?= htmlspecialchars(json_encode((string)$row['id']), ENT_QUOTES, 'UTF-8') ?>, <?= htmlspecialchars(json_encode((string)$row['name']), ENT_QUOTES, 'UTF-8') ?>)">
                                        <i class="fas fa-power-off me-1"></i> KICK
                                    </button>
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
        <form method="POST" class="modal-content shadow-lg border-0" style="border-radius:15px;">
            <div class="modal-header bg-light border-0">
                <h6 class="fw-bold mb-0 text-navy"><i class="fas fa-user-shield me-2"></i>Edit Izin Akses</h6>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
                <input type="hidden" name="user_id" id="m_user_id">
                <input type="hidden" name="default_channel" id="m_default_channel">

                <div class="bg-primary-subtle p-3 rounded-3 mb-3 border border-primary-subtle">
                    <small class="text-muted d-block text-uppercase fw-bold" style="font-size:10px;">User</small>
                    <h5 id="m_user_name" class="fw-bold text-dark m-0"></h5>
                </div>

                <div id="channel_list" class="choice-list" style="max-height: 350px; overflow-y: auto; padding: 10px;">
                    <?php foreach($all_channels as $ch): ?>
                    <div class="channel-item access-channel-option p-3 d-flex align-items-center justify-content-between gap-3" id="item_<?= $ch['id'] ?>">
                        <div class="access-channel-main d-flex align-items-center" onclick="setAsDefault(<?= $ch['id'] ?>)" style="cursor:pointer">
                            <input class="form-check-input me-3 ch-checkbox shadow-sm" type="checkbox" name="channels[]"
                                   value="<?= $ch['id'] ?>" id="check_<?= $ch['id'] ?>" onclick="event.stopPropagation();">
                            <div class="access-channel-text">
                                <label class="fw-bold d-block mb-0" style="cursor:pointer; font-size: 14px;"><?= htmlspecialchars($ch['display_name']) ?></label>
                                <small class="text-warning fw-bold" style="font-size:9px; display:none;" id="def_label_<?= $ch['id'] ?>"><i class="fas fa-star"></i> DEFAULT UTAMA</small>
                            </div>
                        </div>
                        <div class="form-check form-switch access-rx-toggle">
                            <input class="form-check-input" type="checkbox" name="permissions[<?= $ch['id'] ?>]" value="RX" id="rx_<?= $ch['id'] ?>">
                            <label class="small fw-bold text-muted ms-1 d-none d-sm-inline" style="font-size: 10px;">RX ONLY</label>
                            <label class="small fw-bold text-muted ms-1 d-inline d-sm-none" style="font-size: 10px;">RX</label>
                        </div>
                    </div>
                    <?php endforeach; ?>
                </div>
            </div>
            <div class="modal-footer border-0 pt-0">
                <button type="submit" name="update_multi_access" class="btn btn-navy w-100 fw-bold py-3 rounded-3 shadow-sm">SIMPAN KONFIGURASI</button>
            </div>
        </form>
    </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script>
    function getAccessModalInstance() {
        const modalEl = document.getElementById('accessModal');
        return modalEl ? bootstrap.Modal.getOrCreateInstance(modalEl) : null;
    }

    function setAsDefault(id) {
        document.getElementById('check_' + id).checked = true;
        document.querySelectorAll('#accessModal .channel-item').forEach(el => el.classList.remove('is-default'));
        document.querySelectorAll('[id^="def_label_"]').forEach(el => el.style.display = 'none');

        document.getElementById('item_' + id).classList.add('is-default');
        document.getElementById('def_label_' + id).style.display = 'block';
        document.getElementById('m_default_channel').value = id;
    }

    function openModal(id, name, currentIds, defaultId, permMap) {
        document.getElementById('m_user_id').value = id;
        document.getElementById('m_user_name').innerText = name;
        document.getElementById('m_default_channel').value = defaultId || "";

        document.querySelectorAll('#accessModal .channel-item').forEach(el => el.classList.remove('is-default'));
        document.querySelectorAll('[id^="def_label_"]').forEach(el => el.style.display = 'none');
        document.querySelectorAll('#accessModal .ch-checkbox').forEach(cb => cb.checked = false);
        document.querySelectorAll('#accessModal .form-switch input').forEach(sw => sw.checked = false);

        if(currentIds && Array.isArray(currentIds)) {
            currentIds.forEach(val => {
                if(!val) return;
                const cb = document.getElementById('check_' + val);
                if(cb) cb.checked = true;
                if(permMap && permMap[val] === 'RX') {
                    const sw = document.getElementById('rx_' + val);
                    if(sw) sw.checked = true;
                }
            });
        }

        if(defaultId) {
            const item = document.getElementById('item_' + defaultId);
            if(item) {
                item.classList.add('is-default');
                const label = document.getElementById('def_label_' + defaultId);
                if(label) label.style.display = 'block';
            }
        }
        const modal = getAccessModalInstance();
        if (modal) modal.show();
    }

    document.addEventListener('DOMContentLoaded', function() {
        document.querySelectorAll('.access-row').forEach(row => {
            row.addEventListener('click', function(event) {
                if (event.target.closest('button') || event.target.closest('a') || event.target.closest('input')) return;

                let currentIds = [];
                let permMap = {};
                try {
                    currentIds = JSON.parse(this.dataset.currentIds || '[]');
                } catch (err) {
                    currentIds = [];
                }
                try {
                    permMap = JSON.parse(this.dataset.permMap || '{}');
                } catch (err) {
                    permMap = {};
                }

                openModal(
                    this.dataset.userId || '',
                    this.dataset.userName || '',
                    currentIds,
                    this.dataset.defaultId || '',
                    permMap
                );
            });
        });
    });

    async function forceLogout(userId, userName) {
        if (!confirm(`Putuskan koneksi perangkat ${userName}?`)) return;
        let fd = new FormData();
        fd.append('action', 'db_force_logout');
        fd.append('user_id', userId);

        try {
            const resp = await fetch(window.location.href, { method: 'POST', body: fd });
            const res = await resp.json();
            if(res.success) {
                alert("Berhasil: Instruksi Force Logout dikirim.");
                location.reload();
            }
        } catch (e) {
            alert("Gagal menghubungi database.");
        }
    }
</script>
</body>
</html>
