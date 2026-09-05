<?php
/**
 * Who may be deleted, decided once for every path that asks.
 *
 * There were two answers before. admin_panel.php enforced three rules through
 * am2_adm_undeletable() -- not a superadmin, not the master row, not yourself --
 * and api_admin_panel.php enforced one, written inline into the statement as
 * `WHERE id = ? AND role != 'superadmin'`. So the master admin and your own
 * account were deletable through the API and refused on the page, and the API
 * is the path that was exploited on 2026-09-04.
 *
 * The fourth rule is new and is the reason this file exists. Deleting one admin
 * row took 186 units with it that day, through ON DELETE CASCADE, with no
 * confirmation and no count. Migration 006 changed that foreign key to RESTRICT,
 * so the database now refuses outright -- but a foreign key violation reaches
 * the operator as "Terjadi kesalahan sistem", which tells them nothing about
 * what to do next. This says it in words, before the query runs.
 */

// Not an endpoint. See am2_refuse_direct_request().
require_once __DIR__ . '/session_boot.php';
am2_refuse_direct_request(__FILE__);

if (!function_exists('am2_admin_undeletable')) {
    /**
     * Why this admin may not be deleted, as a catalogue key, or '' if it may.
     *
     * @param array $row     the admin row: at least id and role
     * @param mixed $my_id   the signed-in admin, who may not delete themselves
     * @return array{0: string, 1: array}  [catalogue key, parameters]
     */
    function am2_admin_undeletable(PDO $pdo, array $row, $my_id): array
    {
        if ((string) ($row['role'] ?? '') === 'superadmin') return ['adm.locked_super', []];
        if ((int) $row['id'] === 1)                         return ['adm.locked_master', []];
        if ((int) $row['id'] === (int) $my_id)              return ['adm.locked_self', []];

        /*
         * The count, rather than a yes or no.
         *
         * "This cannot be deleted" sends the operator looking for the obstacle.
         * "This still owns 186 units" tells them what to do next, and puts the
         * size of what they were about to destroy in front of them -- which is
         * the number nobody saw on 2026-09-04 because nothing ever showed it.
         */
        $owned = $pdo->prepare('SELECT COUNT(*) FROM public.users WHERE admin_id = ?');
        $owned->execute([(int) $row['id']]);
        $count = (int) $owned->fetchColumn();
        if ($count > 0) {
            return ['adm.locked_owns_units', ['count' => $count]];
        }

        return ['', []];
    }
}
