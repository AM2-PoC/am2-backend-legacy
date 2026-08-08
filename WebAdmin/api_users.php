<?php
header('Content-Type: application/json');
require_once 'config.php';
am2_api_auth();



// Identity is resolved by the server; see am2_api_identity().
[$admin_id, $admin_role] = am2_api_identity();

$method = $_SERVER['REQUEST_METHOD'];

if ($method == 'GET') {
    $action = $_GET['action'] ?? '';

    if ($action == 'get_user_channels') {
        $u_id = $_GET['u_id'] ?? '';
        try {
            $stmt = $pdo->prepare("SELECT DISTINCT channel_id FROM public.user_channels WHERE user_id = ?");
            $stmt->execute([$u_id]);
            echo json_encode($stmt->fetchAll(PDO::FETCH_COLUMN));
        } catch (PDOException $e) {
            echo json_encode(['error' => am2_safe_error($e, 'api_users')]);
        }
        exit;
    }

    $search = isset($_GET['search']) ? trim($_GET['search']) : '';
    $sql = "SELECT u.id, u.name, u.status, u.admin_id, u.current_channel,
                   COALESCE(p.enable_maps, false) as enable_maps,
                   COALESCE(p.enable_p2p, false) as enable_p2p,
                   COALESCE(p.enable_ptt_video, false) as enable_ptt_video,
                   COALESCE(p.duplex_mode, 'HALF DUPLEX') as duplex_mode
            FROM public.users u
            LEFT JOIN public.user_app_permissions p ON u.id = p.user_id
            WHERE u.role = 'user'";

    $params = [];

    if (strtolower($admin_role) !== 'superadmin') {
        $sql .= " AND u.admin_id = ?";
        $params[] = $admin_id;
    }

    if ($search !== '') {
        $sql .= " AND (u.name ILIKE ? OR u.id::text ILIKE ?)";
        $params[] = "%$search%";
        $params[] = "%$search%";
    }

    try {
        $stmt = $pdo->prepare($sql . " ORDER BY u.name ASC");
        $stmt->execute($params);
        $users = $stmt->fetchAll(PDO::FETCH_ASSOC);

        foreach ($users as &$u) {
            $u['enable_maps'] = (bool)$u['enable_maps'];
            $u['enable_p2p'] = (bool)$u['enable_p2p'];
            $u['enable_ptt_video'] = (bool)$u['enable_ptt_video'];
            $u['admin_id'] = $u['admin_id'] ? (int)$u['admin_id'] : null;
        }

        echo json_encode($users);
    } catch (PDOException $e) {
        http_response_code(500);
        echo json_encode(['error' => am2_safe_error($e, 'api_users')]);
    }
}
elseif ($method == 'POST') {
    $action = $_POST['action'] ?? '';

    if ($action == 'add' || $action == 'edit') {
        $id = trim($_POST['id'] ?? '');
        $name = strtoupper(trim($_POST['name'] ?? ''));
        $password = $_POST['password'] ?? '';

        if (empty($id) || empty($name)) {
            echo json_encode(['success' => false, 'message' => 'Data tidak lengkap']);
            exit;
        }

        /*
         * Editing had no ownership check at all.
         *
         * update_feature and delete each grew one; this branch never did, and
         * it is the branch that sets a unit's password. A branch admin could
         * rename and reset the password of any unit in the deployment,
         * including another tenant's, by naming its id. Adding is exempt: a
         * unit that does not exist yet cannot belong to anybody, and it is
         * created under the caller's own admin_id below.
         */
        if ($action === 'edit'
                && !am2_admin_owns_user($pdo, $admin_id, $admin_role, $id)
                && am2_api_authz_denied('edit-foreign-user')) {
            exit;
        }

        try {
            $pdo->beginTransaction();
            if ($action == 'add') {
                // The same call the panel makes. This copy never wrote
                // created_by, so a unit registered from the app was attributed
                // to nobody at all.
                am2_create_user($pdo, $id, $name, $password, $admin_id);
            } else {
                am2_update_user($pdo, $id, $name, (string) $password, $admin_id);
            }

            // The panel has always recorded these. This path did not, so a unit
            // created or renamed from the app left no trace at all.
            if ($action === 'add') {
                am2_log($pdo, $admin_id, 'CREATE_USER', 'user.create',
                        ['name' => $name, 'id' => $id, 'via' => 'mobile'], 'users', $id);
            } else {
                am2_log($pdo, $admin_id, 'UPDATE_USER',
                        empty($password) ? 'user.rename' : 'user.password',
                        ['id' => $id, 'name' => $name, 'via' => 'mobile'], 'users', $id);
            }

            am2_audit_complete();
            $pdo->commit();
            echo json_encode(['success' => true, 'message' => 'User berhasil ' . ($action == 'add' ? 'ditambahkan' : 'diperbarui')]);
        } catch (Throwable $e) {
            /*
             * Throwable, not PDOException. The audit guard raises a
             * LogicException, which these clauses did not name -- so an
             * unbalanced mutation left this endpoint as an uncaught fatal,
             * emitting an HTML error page to a caller parsing JSON. The
             * rollback and the abandon are exactly what that case needs.
             */
            if ($pdo->inTransaction()) $pdo->rollBack(); am2_audit_abandon();
            echo json_encode(['success' => false, 'message' => 'Gagal: ' . am2_safe_error($e, 'api_users')]);
        }
    }
    elseif ($action == 'save_user_channels') {
        $u_id = $_POST['u_id'] ?? '';
        $channels = json_decode($_POST['channels'] ?? '[]', true) ?: [];
        $channels = array_unique(array_filter($channels));

        // Both halves of the question. The channels were checked when this
        // moved onto the shared writer; the unit itself still was not, so a
        // branch admin could rewrite another tenant's membership using
        // channels it legitimately owns.
        if (!am2_admin_owns_user($pdo, $admin_id, $admin_role, $u_id)
                && am2_api_authz_denied('channels-foreign-user')) {
            exit;
        }

        try {
            // A form is not an authorization: the ids arrive over POST, and this
            // path never checked them against who is asking. The panel has.
            if (am2_first_foreign_channel($pdo, $admin_id, $admin_role, $channels) !== null) {
                echo json_encode(['success' => false, 'message' => 'Akses ditolak']);
                exit;
            }

            $pdo->beginTransaction();

            $stmtName = $pdo->prepare('SELECT name FROM public.users WHERE id = ?');
            $stmtName->execute([$u_id]);
            $targetName = (string) ($stmtName->fetchColumn() ?: $u_id);

            // The same call the panel makes. What it replaces deleted every
            // membership and rebuilt it as FULL DUPLEX with the first entry as
            // default -- so re-saving a list from the app reset every
            // permission and moved where the unit comes up.
            $result = am2_set_user_channels($pdo, (string) $u_id, $channels);

            /*
             * The same event the panel writes. This path recorded nothing at
             * all, so a membership rewritten from the app left the log saying
             * the unit's access had not changed since whenever it was last
             * edited on the web.
             */
            if ($channels) {
                $stmtCh = $pdo->prepare('SELECT display_name FROM public.channels WHERE id = ?');
                $logChannels = [];
                foreach ($channels as $chId) {
                    $stmtCh->execute([$chId]);
                    $logChannels[] = [
                        'name'    => (string) $stmtCh->fetchColumn(),
                        'default' => ((string) $chId === (string) $result['default']),
                        'perm'    => $result['permissions'][(string) $chId] ?? 'FULL DUPLEX',
                    ];
                }
                $logCode   = 'access.update';
                $logParams = ['name' => $targetName, 'channels' => $logChannels];
            } else {
                $logCode   = 'access.revoke';
                $logParams = ['name' => $targetName];
            }
            am2_log($pdo, $admin_id, 'UPDATE_ACCESS', $logCode, $logParams,
                    'users', (string) $u_id);

            am2_audit_complete();
            $pdo->commit();
            syncUserChannels($u_id);
            echo json_encode(['success' => true]);
        } catch (Exception $e) {
            if ($pdo->inTransaction()) $pdo->rollBack(); am2_audit_abandon();
            echo json_encode(['success' => false, 'message' => am2_safe_error($e, 'api_users')]);
        }
    }
    elseif ($action == 'update_feature') {
        $target_uid = $_POST['u_id'] ?? '';
        if (!am2_admin_owns_user($pdo, $admin_id, $admin_role, $target_uid)
            && am2_api_authz_denied('feature-foreign-user')) {
            exit;
        }

        $u_id = $_POST['u_id'] ?? '';
        $feature = $_POST['feature'] ?? '';

        try {
            // The asking admin's own rights, which this path never read. An
            // admin told they may not manage video could enable it from the
            // app, because only the panel was checking.
            $stmtAuth = $pdo->prepare(
                "SELECT can_manage_maps, can_manage_p2p, can_manage_video
                 FROM public.admin WHERE id = ?");
            $stmtAuth->execute([$admin_id]);
            $auth = $stmtAuth->fetch(PDO::FETCH_ASSOC) ?: [];
            if ($admin_role === 'superadmin') {
                $auth = ['can_manage_maps' => true, 'can_manage_p2p' => true,
                         'can_manage_video' => true];
            }

            $pdo->beginTransaction();
            $val = am2_feature_value($feature, $_POST['val'] ?? '');
            $row = am2_set_user_feature($pdo, (string) $u_id, $feature, $_POST['val'] ?? '', $auth);

            $stmtName = $pdo->prepare("SELECT name FROM public.users WHERE id = ?");
            $stmtName->execute([$u_id]);
            $targetName = $stmtName->fetchColumn() ?: $u_id;

            [$logCode, $logParams] = am2_feature_log(
                $feature, (string) $val, (string) $u_id, (string) $targetName);
            $logParams['via'] = 'mobile';
            am2_log($pdo, $admin_id, 'UPDATE_FEATURE', $logCode, $logParams, 'users', (string) $u_id);

            am2_audit_complete();
            $pdo->commit();
            notifyPermissionUpdate($u_id, $row['enable_maps'], $row['enable_p2p'], $row['enable_ptt_video'], $row['duplex_mode']);
            echo json_encode(['success' => true]);
        } catch (InvalidArgumentException | RuntimeException $e) {
            if ($pdo->inTransaction()) $pdo->rollBack(); am2_audit_abandon();
            echo json_encode(['success' => false, 'message' => am2_feature_reason($e)]);
        } catch (Throwable $e) {
            // Throwable so the audit guard's LogicException lands here too,
            // rather than escaping as HTML to a caller parsing JSON.
            if ($pdo->inTransaction()) $pdo->rollBack(); am2_audit_abandon();
            echo json_encode(['success' => false, 'message' => am2_safe_error($e, 'api_users')]);
        }
    }
    elseif ($action == 'delete') {
        $id = $_POST['id'] ?? '';
        if (!am2_admin_owns_user($pdo, $admin_id, $admin_role, $id)
            && am2_api_authz_denied('delete-foreign-user')) {
            exit;
        }

        try {
            // Was a bare DELETE with no transaction and no log. The trigger on
            // public.users reads created_by to decide whose activity a removal
            // was, so without the line am2_delete_user() writes first, the
            // record named whoever created the unit rather than whoever
            // removed it.
            $pdo->beginTransaction();
            $oldName = am2_delete_user($pdo, (string) $id, $admin_id);
            am2_log($pdo, $admin_id, 'DELETE_USER', 'user.delete',
                    ['name' => $oldName, 'id' => $id, 'via' => 'mobile'], 'users', (string) $id);
            am2_audit_complete();
            $pdo->commit();
            echo json_encode(['success' => true]);
        } catch (Throwable $e) {
            // Throwable so the audit guard's LogicException lands here too,
            // rather than escaping as HTML to a caller parsing JSON.
            if ($pdo->inTransaction()) $pdo->rollBack(); am2_audit_abandon();
            echo json_encode(['success' => false, 'message' => am2_safe_error($e, 'api_users')]);
        }
    }
}
?>
