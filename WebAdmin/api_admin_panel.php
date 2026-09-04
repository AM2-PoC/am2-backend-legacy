<?php
header('Content-Type: application/json');
require_once 'config.php';
am2_api_auth();
am2_csrf_require();

// SECURITY: this endpoint carries no caller identity, so it cannot distinguish
// one admin from another. Its only control is the shared key checked by
// am2_api_auth(). Anyone holding that key can create or delete an admin,
// including a superadmin. Giving it a real actor requires a contract change to
// the Admin Native app.
$method = $_SERVER['REQUEST_METHOD'];

// This file manages the admin table itself: who exists, what quota they
// hold, and who is a superadmin. Nothing below is ever a branch admin's
// job, so the whole file is gated rather than each action.
if (am2_api_require_super('admin-panel')) {
    exit;
}

if ($method == 'GET') {
    try {
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
            FROM public.admin a ORDER BY a.id DESC
        ");
        $stmt_list->execute();
        $admins = $stmt_list->fetchAll(PDO::FETCH_ASSOC);

        foreach ($admins as &$adm) {
            $adm['channel_ids'] = json_decode($adm['channel_ids'] ?? '[]', true) ?: [];
            $adm['can_manage_maps'] = (bool)$adm['can_manage_maps'];
            $adm['can_manage_p2p'] = (bool)$adm['can_manage_p2p'];
            $adm['can_manage_video'] = (bool)$adm['can_manage_video'];
            $adm['user_quota'] = (int)$adm['user_quota'];
            $adm['channel_quota'] = (int)$adm['channel_quota'];
            unset($adm['password_hash']);
        }

        echo json_encode($admins);
    } catch (PDOException $e) {
        http_response_code(500);
        echo json_encode(['error' => am2_safe_error($e, 'api_admin_panel')]);
    }
}
elseif ($method == 'POST') {
    $action = $_POST['action'] ?? '';

    if ($action == 'save') {
        $admin_id = !empty($_POST['admin_id']) ? (int)$_POST['admin_id'] : null;
        $username = trim($_POST['username'] ?? '');
        $password = $_POST['password'] ?? '';
        $role = $_POST['role'] ?? 'admin';
        $u_quota = ($role === 'superadmin') ? 999999 : (int)($_POST['user_quota'] ?? 0);
        $c_quota = ($role === 'superadmin') ? 999999 : (int)($_POST['channel_quota'] ?? 0);
        $expired_at = !empty($_POST['expired_at']) ? $_POST['expired_at'] : null;
        $can_maps = ($_POST['can_manage_maps'] ?? 'false') === 'true' ? 'true' : 'false';
        $can_p2p = ($_POST['can_manage_p2p'] ?? 'false') === 'true' ? 'true' : 'false';
        $can_video = ($_POST['can_manage_video'] ?? 'false') === 'true' ? 'true' : 'false';

        try {
            if ($admin_id) {
                $sql = "UPDATE public.admin SET username = ?, role = ?, user_quota = ?, channel_quota = ?, expired_at = ?, can_manage_maps = $can_maps, can_manage_p2p = $can_p2p, can_manage_video = $can_video WHERE id = ?";
                $params = [$username, $role, $u_quota, $c_quota, $expired_at, $admin_id];
                $pdo->prepare($sql)->execute($params);

                if (!empty($password)) {
                    $hash = password_hash($password, PASSWORD_BCRYPT);
                    $pdo->prepare("UPDATE public.admin SET password_hash = ? WHERE id = ?")->execute([$hash, $admin_id]);
                }
                echo json_encode(['success' => true, 'message' => 'Admin updated']);
            } else {
                $hash = password_hash($password, PASSWORD_BCRYPT);
                $stmt = $pdo->prepare("INSERT INTO public.admin (username, password_hash, role, user_quota, channel_quota, expired_at, can_manage_maps, can_manage_p2p, can_manage_video, status) VALUES (?, ?, ?, ?, ?, ?, $can_maps, $can_p2p, $can_video, 'active')");
                $stmt->execute([$username, $hash, $role, $u_quota, $c_quota, $expired_at]);
                echo json_encode(['success' => true, 'message' => 'Admin created']);
            }
        } catch (PDOException $e) {
            echo json_encode(['success' => false, 'message' => am2_safe_error($e, 'api_admin_panel')]);
        }
    }
    elseif ($action == 'delete') {
        $id = (int)$_POST['id'];
        try {
            /*
             * The same four rules the page applies. This used to be
             * `WHERE id = ? AND role != 'superadmin'` written into the
             * statement, which protected the superadmin row and nothing else --
             * so the master admin and the caller's own account were deletable
             * here and refused on the page.
             *
             * Checked before the query rather than after, so a rule doing its
             * job is not reported to the operator as a system error. Migration
             * 006 makes the database refuse as well; this is what makes the
             * refusal readable.
             */
            $found = $pdo->prepare('SELECT id, role FROM public.admin WHERE id = ?');
            $found->execute([$id]);
            $target = $found->fetch();
            if (!$target) {
                echo json_encode(['success' => false, 'message' => t('msg.admin_not_found')]);
            } elseif ([$why, $why_params] = am2_admin_undeletable($pdo, $target, $_SESSION['admin_id'] ?? 0)) {
                if ($why !== '') {
                    echo json_encode(['success' => false, 'message' => t($why, $why_params)]);
                } else {
                    $pdo->prepare('DELETE FROM public.admin WHERE id = ?')->execute([$id]);
                    echo json_encode(['success' => true, 'message' => 'Admin deleted']);
                }
            }
        } catch (PDOException $e) {
            echo json_encode(['success' => false, 'message' => am2_safe_error($e, 'api_admin_panel')]);
        }
    }
    elseif ($action == 'delegate') {
        $target_admin_id = (int)$_POST['target_admin_id'];
        $channel_ids = $_POST['channels'] ?? [];

        try {
            $pdo->beginTransaction();
            $pdo->prepare("DELETE FROM public.admin_managed_channels WHERE admin_id = ?")->execute([$target_admin_id]);
            if (!empty($channel_ids)) {
                $stmt = $pdo->prepare("INSERT INTO public.admin_managed_channels (admin_id, channel_id) VALUES (?, ?)");
                foreach ($channel_ids as $ch_id) {
                    $stmt->execute([$target_admin_id, (int)$ch_id]);
                }
            }
            $pdo->commit();
            echo json_encode(['success' => true, 'message' => 'Delegation updated']);
        } catch (PDOException $e) {
            $pdo->rollBack();
            echo json_encode(['success' => false, 'message' => am2_safe_error($e, 'api_admin_panel')]);
        }
    }
}
?>
