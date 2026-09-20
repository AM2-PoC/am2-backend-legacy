<?php

require_once __DIR__ . '/session_boot.php';
am2_refuse_direct_request(__FILE__);

if (!function_exists('am2_admin_undeletable')) {

    function am2_admin_undeletable(PDO $pdo, array $row, $my_id): array
    {
        if ((string) ($row['role'] ?? '') === 'superadmin') return ['adm.locked_super', []];
        if ((int) $row['id'] === 1)                         return ['adm.locked_master', []];
        if ((int) $row['id'] === (int) $my_id)              return ['adm.locked_self', []];

        $owned = $pdo->prepare('SELECT COUNT(*) FROM public.users WHERE admin_id = ?');
        $owned->execute([(int) $row['id']]);
        $count = (int) $owned->fetchColumn();
        if ($count > 0) {
            return ['adm.locked_owns_units', ['count' => $count]];
        }

        return ['', []];
    }

    // Called only after the policy check; SQL rechecks mutable role and identity.
    function am2_admin_delete(PDO $pdo, array $target, int $my_id): array
    {
        try {
            $stmt = $pdo->prepare(
                "DELETE FROM public.admin
                 WHERE id = ? AND id <> ? AND id <> 1 AND COALESCE(role, '') <> 'superadmin'"
            );
            $stmt->execute([(int) $target['id'], $my_id]);
            return $stmt->rowCount() === 1 ? ['', []] : ['adm.delete_changed', []];
        } catch (PDOException $e) {
            if ((string) $e->getCode() !== '23503') throw $e;
            [$why, $params] = am2_admin_undeletable($pdo, $target, $my_id);
            return $why !== '' ? [$why, $params] : ['adm.locked_references', []];
        }
    }
}
