<?php
require_once __DIR__ . '/session_boot.php';
am2_refuse_direct_request(__FILE__);

/**
 * Register a unit under an admin.
 *
 * The permission row is created with the columns left at their defaults except
 * the three switches, which start off. duplex_mode is not named: the column
 * defaults to HALF DUPLEX, and naming it in one of two places is how the two
 * copies came to disagree about what a new unit starts as.
 */
function am2_entity_type($value): string
{
    $type = strtolower(trim((string) $value));
    if (!in_array($type, ['user', 'tracker'], true)) {
        throw new InvalidArgumentException('Invalid entity type');
    }
    return $type;
}

function am2_is_duplicate_unit_id(Throwable $e): bool
{
    return $e instanceof PDOException
        && (string) $e->getCode() === '23505'
        && str_contains($e->getMessage(), '"users_pkey"');
}

function am2_create_user(PDO $pdo, string $id, string $name, string $password, $adminId, string $entityType): void
{
    am2_require_transaction($pdo, __FUNCTION__);
    am2_audit_expect(__FUNCTION__);

    $entityType = am2_entity_type($entityType);
    $pdo->prepare(
        "INSERT INTO public.users
            (id, name, password, role, status, admin_id, created_by, entity_type, created_at, updated_at)
         VALUES (?, ?, ?, 'user', 'offline', ?, ?, ?, NOW(), NOW())"
    )->execute([$id, $name, password_hash($password, PASSWORD_BCRYPT), $adminId, $adminId, $entityType]);

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
function am2_update_user(PDO $pdo, string $id, string $name, string $password, $adminId, string $entityType): void
{
    am2_require_transaction($pdo, __FUNCTION__);
    am2_audit_expect(__FUNCTION__);

    $entityType = am2_entity_type($entityType);
    if ($password !== '') {
        $pdo->prepare(
            "UPDATE public.users
                SET name = ?, password = ?, created_by = ?, entity_type = ?, updated_at = NOW()
              WHERE id = ?"
        )->execute([$name, password_hash($password, PASSWORD_BCRYPT), $adminId, $entityType, $id]);

        /*
         * A new password ends the old sessions.
         *
         * The handset keeps a device token rather than the operator's password,
         * and the whole reason that is an improvement is revocation. Leaving
         * the tokens in place would mean a changed password stopped nothing:
         * every handset that already had one would keep signing in with it,
         * which is the property being fixed rather than reproduced.
         */
        $pdo->prepare('DELETE FROM public.device_tokens WHERE user_id = ?')->execute([$id]);
        return;
    }

    $pdo->prepare(
        "UPDATE public.users SET name = ?, created_by = ?, entity_type = ?, updated_at = NOW() WHERE id = ?"
    )->execute([$name, $adminId, $entityType, $id]);
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
    // Before the row it names, so a failure here cannot leave tokens behind
    // that point at a unit which no longer exists.
    $pdo->prepare('DELETE FROM public.device_tokens WHERE user_id = ?')->execute([$id]);
    $pdo->prepare("DELETE FROM public.users WHERE id = ? AND role = 'user'")->execute([$id]);

    return $name;
}
