<?php
/**
 * Creating, renaming and removing a unit.
 *
 * The switches on a unit live in user_features.php; this file is the unit
 * itself. Both existed twice — once on the page and once on the endpoint the
 * admin app calls — and the two disagreed about the parts nobody looks at:
 *
 *   - The page set created_by on the way in and again just before a delete,
 *     because the trigger on public.users reads that column to decide who to
 *     attribute the row to. The endpoint set it never, so a unit created from
 *     the app was attributed to nobody, and a unit deleted from the app was
 *     attributed to whoever had created it rather than whoever removed it.
 *
 *   - The page wrapped each operation in a transaction so the row, its
 *     permissions and the log entry either all happened or none did. The
 *     endpoint deleted without one.
 *
 * None of these caused a visible failure, which is why they survived. They
 * only ever produced an audit trail that quietly named the wrong person.
 *
 * Each function requires an open transaction and opens none of its own, so a
 * caller can put its own log write in the same one.
 */

/**
 * Register a unit under an admin.
 *
 * The permission row is created with the columns left at their defaults except
 * the three switches, which start off. duplex_mode is not named: the column
 * defaults to HALF DUPLEX, and naming it in one of two places is how the two
 * copies came to disagree about what a new unit starts as.
 */
function am2_create_user(PDO $pdo, string $id, string $name, string $password, $adminId): void
{
    am2_require_transaction($pdo, __FUNCTION__);
    am2_audit_expect(__FUNCTION__);

    $pdo->prepare(
        "INSERT INTO public.users
            (id, name, password, role, status, admin_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'user', 'offline', ?, ?, NOW(), NOW())"
    )->execute([$id, $name, password_hash($password, PASSWORD_BCRYPT), $adminId, $adminId]);

    $pdo->prepare(
        "INSERT INTO public.user_app_permissions
            (user_id, enable_maps, enable_p2p, enable_ptt_video, updated_at)
         VALUES (?, false, false, false, NOW())"
    )->execute([$id]);
}

/**
 * Rename a unit, and set its password if one was given.
 *
 * An empty password means "leave it alone" — the two callers spelled that the
 * same way already, and it is the one part of this they agreed on.
 */
function am2_update_user(PDO $pdo, string $id, string $name, string $password, $adminId): void
{
    am2_require_transaction($pdo, __FUNCTION__);
    am2_audit_expect(__FUNCTION__);

    if ($password !== '') {
        $pdo->prepare(
            "UPDATE public.users
                SET name = ?, password = ?, created_by = ?, updated_at = NOW()
              WHERE id = ?"
        )->execute([$name, password_hash($password, PASSWORD_BCRYPT), $adminId, $id]);
        return;
    }

    $pdo->prepare(
        "UPDATE public.users SET name = ?, created_by = ?, updated_at = NOW() WHERE id = ?"
    )->execute([$name, $adminId, $id]);
}

/**
 * Remove a unit, and return the name it had.
 *
 * created_by is set to the admin doing the removing before the row goes,
 * because the trigger on public.users reads it to decide whose activity this
 * was. Without that line the log says the unit was deleted by whoever created
 * it, which is a sentence about the wrong person.
 */
function am2_delete_user(PDO $pdo, string $id, $adminId): string
{
    am2_require_transaction($pdo, __FUNCTION__);
    am2_audit_expect(__FUNCTION__);

    $stmt = $pdo->prepare('SELECT name FROM public.users WHERE id = ?');
    $stmt->execute([$id]);
    $name = (string) ($stmt->fetchColumn() ?: $id);

    $pdo->prepare('UPDATE public.users SET created_by = ? WHERE id = ?')->execute([$adminId, $id]);
    $pdo->prepare("DELETE FROM public.users WHERE id = ? AND role = 'user'")->execute([$id]);

    return $name;
}
