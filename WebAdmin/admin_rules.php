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
}
