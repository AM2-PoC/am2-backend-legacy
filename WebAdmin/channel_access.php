<?php
/**
 * The one place user-to-channel membership is written.
 *
 * Three pages used to write `user_channels`, and all three disagreed:
 *
 *   user_access.php  kept the permission the form sent, kept the default, and
 *                    updated users.last_channel_id.
 *   users.php        deleted every row and recreated them all as FULL DUPLEX,
 *                    made whichever channel happened to be first in the JSON
 *                    array the default, and never touched last_channel_id.
 *   channels.php     deleted every membership of the channel it was editing
 *                    and recreated them all with is_default = 'false'.
 *
 * So editing a unit from the Units page silently granted transmit rights to a
 * receive-only unit, and editing a channel's roster stripped the default
 * channel from everyone on it while users.last_channel_id went on pointing at
 * it. A unit whose last_channel_id names a channel it no longer holds, or
 * holds without a default, cannot sign in at all -- which is what the eight
 * units found stranded in production have in common.
 *
 * Both functions below must be called inside a transaction, and neither talks
 * to the relay: they return the user ids they touched so the caller can sync
 * after the commit, and see it fail.
 */

/**
 * What user_channels.permission accepts. The check constraint on the column
 * still allows 'TX' and the old column default 'rxtx', so those are passed
 * through untouched rather than quietly rewritten -- a membership edit is not
 * the place to migrate historical values. Only RX means receive-only; the
 * relay lets everything else transmit.
 */
const AM2_PERMISSIONS = ['RX', 'TX', 'FULL DUPLEX', 'rxtx'];

function am2_normalise_permission($value): string
{
    $v = trim((string) $value);
    if (in_array($v, AM2_PERMISSIONS, true)) {
        return $v;
    }
    $upper = strtoupper($v);
    return in_array($upper, AM2_PERMISSIONS, true) ? $upper : 'FULL DUPLEX';
}

function am2_require_transaction(PDO $pdo, string $fn): void
{
    if (!$pdo->inTransaction()) {
        throw new LogicException($fn . '() must run inside a transaction');
    }
}

/**
 * Every channel this user currently holds, keyed by channel id.
 *
 * @return array<string, array{permission: string, is_default: bool}>
 */
function am2_user_channels(PDO $pdo, string $userId): array
{
    $stmt = $pdo->prepare(
        'SELECT channel_id, permission, is_default FROM public.user_channels WHERE user_id = ?'
    );
    $stmt->execute([$userId]);

    $out = [];
    foreach ($stmt->fetchAll() as $row) {
        $out[(string) $row['channel_id']] = [
            'permission' => am2_normalise_permission($row['permission']),
            'is_default' => in_array($row['is_default'], [true, 't', 'true', 1, '1'], true),
        ];
    }
    return $out;
}

/**
 * Set the complete list of channels a user holds.
 *
 * Anything the caller does not state is preserved rather than reset: omit
 * $perms and each surviving channel keeps the permission it already had, omit
 * $defaultId and the existing default survives if it is still in the set.
 * That is what lets the Units page edit a membership list without destroying
 * what the Channel Access page configured.
 *
 * Exactly one default is guaranteed whenever the set is non-empty, and
 * users.last_channel_id is written to match it -- or to NULL when the user is
 * left with no channels, which is a legitimate state.
 *
 * @param string[]              $channelIds  the complete set the user should hold
 * @param string|null           $defaultId   null to keep whatever is already default
 * @param array<string, string> $perms       channel id => RX|FULL DUPLEX, partial is fine
 *
 * @return array{granted: string[], revoked: string[], default: ?string, permissions: array<string, string>}
 */
function am2_set_user_channels(
    PDO $pdo,
    string $userId,
    array $channelIds,
    ?string $defaultId = null,
    array $perms = []
): array {
    am2_require_transaction($pdo, __FUNCTION__);

    $existing = am2_user_channels($pdo, $userId);
    $wanted = [];
    foreach ($channelIds as $cid) {
        $cid = (string) $cid;
        if ($cid !== '' && !in_array($cid, $wanted, true)) {
            $wanted[] = $cid;
        }
    }

    // Permission: what the caller stated, else what the row already held,
    // else the default for a newly granted channel.
    $resolved = [];
    foreach ($wanted as $cid) {
        if (array_key_exists($cid, $perms)) {
            $resolved[$cid] = am2_normalise_permission($perms[$cid]);
        } elseif (isset($existing[$cid])) {
            $resolved[$cid] = $existing[$cid]['permission'];
        } else {
            $resolved[$cid] = 'FULL DUPLEX';
        }
    }

    // Default: the stated one if it is actually granted, else the surviving
    // one, else the first channel. A user with channels always has exactly one.
    $default = null;
    if ($defaultId !== null && $defaultId !== '' && in_array((string) $defaultId, $wanted, true)) {
        $default = (string) $defaultId;
    } else {
        foreach ($wanted as $cid) {
            if (!empty($existing[$cid]['is_default'])) {
                $default = $cid;
                break;
            }
        }
        if ($default === null && $wanted) {
            $default = $wanted[0];
        }
    }

    $revoked = array_values(array_diff(array_keys($existing), $wanted));
    $granted = array_values(array_diff($wanted, array_keys($existing)));

    if ($revoked) {
        $in = implode(',', array_fill(0, count($revoked), '?'));
        $pdo->prepare("DELETE FROM public.user_channels WHERE user_id = ? AND channel_id IN ($in)")
            ->execute(array_merge([$userId], $revoked));
    }

    // Upsert rather than delete-then-insert: the rows that survive keep their
    // identity, and nothing observes a moment where the user holds nothing.
    $ins = $pdo->prepare(
        'INSERT INTO public.user_channels (user_id, channel_id, is_default, permission)
         VALUES (?, ?, ?, ?)'
    );
    $upd = $pdo->prepare(
        'UPDATE public.user_channels SET is_default = ?, permission = ?
          WHERE user_id = ? AND channel_id = ?'
    );
    foreach ($wanted as $cid) {
        $isDefault = ($cid === $default) ? 'true' : 'false';
        if (isset($existing[$cid])) {
            $upd->execute([$isDefault, $resolved[$cid], $userId, $cid]);
        } else {
            $ins->execute([$userId, $cid, $isDefault, $resolved[$cid]]);
        }
    }

    $pdo->prepare('UPDATE public.users SET last_channel_id = ? WHERE id = ?')
        ->execute([$default, $userId]);

    return [
        'granted' => $granted,
        'revoked' => $revoked,
        'default' => $default,
        'permissions' => $resolved,
    ];
}

/**
 * Set the complete roster of one channel, touching no other channel.
 *
 * A user who loses their default channel here is given another one they still
 * hold, so the roster edit cannot strand them. $scopeUserIds limits the rows
 * this may remove -- a branch admin edits a shared channel without evicting
 * another tenant's units from it.
 *
 * @param string[]      $userIds       the complete roster
 * @param string[]|null $scopeUserIds  ids this caller may remove, null for all
 *
 * @return array{added: string[], removed: string[], resettled: string[]}
 */
function am2_set_channel_members(
    PDO $pdo,
    string $channelId,
    array $userIds,
    ?array $scopeUserIds = null
): array {
    am2_require_transaction($pdo, __FUNCTION__);

    $stmt = $pdo->prepare('SELECT user_id FROM public.user_channels WHERE channel_id = ?');
    $stmt->execute([$channelId]);
    $current = array_map('strval', array_column($stmt->fetchAll(), 'user_id'));

    $wanted = [];
    foreach ($userIds as $uid) {
        $uid = (string) $uid;
        if ($uid !== '' && !in_array($uid, $wanted, true)) {
            $wanted[] = $uid;
        }
    }

    $removable = $scopeUserIds === null
        ? $current
        : array_values(array_intersect($current, array_map('strval', $scopeUserIds)));

    $added = array_values(array_diff($wanted, $current));
    $removed = array_values(array_diff($removable, $wanted));
    $resettled = [];

    foreach ($added as $uid) {
        // A first channel is that unit's default, otherwise the existing one
        // stands: joining a channel must not move where a unit comes up.
        $held = am2_user_channels($pdo, $uid);
        $hasDefault = false;
        foreach ($held as $row) {
            if ($row['is_default']) {
                $hasDefault = true;
                break;
            }
        }
        $pdo->prepare(
            'INSERT INTO public.user_channels (user_id, channel_id, is_default, permission)
             VALUES (?, ?, ?, ?)'
        )->execute([$uid, $channelId, $hasDefault ? 'false' : 'true', 'FULL DUPLEX']);

        if (!$hasDefault) {
            $pdo->prepare('UPDATE public.users SET last_channel_id = ? WHERE id = ?')
                ->execute([$channelId, $uid]);
            $resettled[] = $uid;
        }
    }

    foreach ($removed as $uid) {
        $held = am2_user_channels($pdo, $uid);
        $wasDefault = !empty($held[$channelId]['is_default']);

        $pdo->prepare('DELETE FROM public.user_channels WHERE user_id = ? AND channel_id = ?')
            ->execute([$uid, $channelId]);

        if (!$wasDefault) {
            continue;
        }
        // Promote something they still hold, rather than leave last_channel_id
        // pointing at a channel they have just been removed from.
        unset($held[$channelId]);
        $next = array_key_first($held);
        if ($next !== null) {
            $pdo->prepare(
                'UPDATE public.user_channels SET is_default = true WHERE user_id = ? AND channel_id = ?'
            )->execute([$uid, $next]);
        }
        $pdo->prepare('UPDATE public.users SET last_channel_id = ? WHERE id = ?')
            ->execute([$next, $uid]);
        $resettled[] = $uid;
    }

    return ['added' => $added, 'removed' => $removed, 'resettled' => $resettled];
}

/**
 * The same, for channels. `channels` has no admin_id: an admin may act on a
 * channel it created, or one delegated to it through admin_managed_channels,
 * which is exactly the pair of conditions channels.php lists the page with.
 */
function am2_first_foreign_channel(PDO $pdo, $adminId, $adminRole, array $channelIds): ?string
{
    if ($adminRole === 'superadmin') {
        return null;
    }
    $stmt = $pdo->prepare(
        'SELECT 1 FROM public.channels c
          LEFT JOIN public.admin_managed_channels amc
                 ON amc.channel_id = c.id AND amc.admin_id = :admin
          WHERE c.id = :channel AND (c.created_by = :admin2 OR amc.admin_id IS NOT NULL)'
    );
    foreach ($channelIds as $cid) {
        $stmt->execute([':admin' => $adminId, ':channel' => (string) $cid, ':admin2' => $adminId]);
        if (!$stmt->fetchColumn()) {
            return (string) $cid;
        }
    }
    return null;
}
