<?php
/**
 * What a unit is allowed to do, and who is allowed to decide it.
 *
 * Two copies of this rule existed and disagreed on three points. The panel
 * validated the feature name against an allow-list; the endpoint behind the
 * admin app validated it against a shorter one that left out duplex_mode, so
 * the branch above it handling duplex could never run. The panel checked the
 * asking admin's own can_manage_* rights; the endpoint checked nothing, so an
 * admin told they may not manage video could enable it from the app anyway.
 * And neither validated the duplex value, so any string at all reached a
 * column the relay compares exactly against.
 *
 * The column name is interpolated into SQL — it has to be, a column is not a
 * parameter — which is why the allow-list is the first thing here and why
 * there is now only one of it.
 */

// Not an endpoint. See am2_refuse_direct_request().
require_once __DIR__ . '/session_boot.php';
am2_refuse_direct_request(__FILE__);

/** The switches, and the admin right that governs each. */
const AM2_FEATURES = [
    'enable_maps'      => 'can_manage_maps',
    'enable_p2p'       => 'can_manage_p2p',
    'enable_ptt_video' => 'can_manage_video',
    // Duplex is not delegated: every admin who may see a unit may set how it
    // transmits. That was already true of the panel; it is stated here rather
    // than as a trailing if with no else.
    'duplex_mode'      => null,
];

/** The catalog key naming each switch, for the activity log. */
const AM2_FEATURE_LABELS = [
    'enable_maps'      => '@log.f_maps',
    'enable_p2p'       => '@log.f_p2p',
    'enable_ptt_video' => '@log.f_video',
    'duplex_mode'      => '@log.f_duplex',
];

/**
 * The value that will be written, or null if it is not one this column takes.
 *
 * FULL DUPLEX and HALF DUPLEX are compared exactly by the relay, so anything
 * else is refused rather than stored and puzzled over later.
 */
function am2_feature_value(string $feature, $raw)
{
    if ($feature === 'duplex_mode') {
        $v = strtoupper(trim((string) $raw));
        return in_array($v, ['FULL DUPLEX', 'HALF DUPLEX'], true) ? $v : null;
    }
    return ($raw === 'true' || $raw === true || $raw === '1' || $raw === 1) ? 'true' : 'false';
}

/** Whether this admin's own rights let them move this switch. */
function am2_may_set_feature(array $auth, string $feature): bool
{
    // ?? cannot be used here: the value for duplex_mode is deliberately null,
    // and null is exactly what ?? treats as absent -- so every duplex change
    // was refused as though the admin lacked a right that does not exist.
    if (!array_key_exists($feature, AM2_FEATURES)) {
        return false;
    }
    $right = AM2_FEATURES[$feature];
    if ($right === null) {
        return true;                    // not a delegated right
    }
    return !empty($auth[$right]);
}

/**
 * Set one switch on one unit.
 *
 * Returns the whole permission row, which both callers hand to the relay.
 * Throws with a reason the caller can show; it opens no transaction of its own
 * so the caller can put the log write in the same one.
 */
function am2_set_user_feature(PDO $pdo, string $userId, string $feature, $raw, array $auth): array
{
    /*
     * A refusal is written to the error log before it is thrown.
     *
     * This rule was just tightened on the path the admin app uses, and the app
     * is not readable from here -- so if a handset speaks a vocabulary this
     * does not recognise, the only way anyone finds out is a feature that
     * silently stops working. One line per refusal turns that into something
     * visible on the first day rather than a support call three weeks later.
     */
    $refuse = static function (string $why) use ($feature, $raw, $userId): void {
        error_log(sprintf(
            'AM2 feature REFUSED user=%s feature=%s value=%s reason=%s',
            $userId, $feature, substr((string) $raw, 0, 40), $why));
    };

    if (!array_key_exists($feature, AM2_FEATURES)) {
        $refuse('unknown-feature');
        throw new InvalidArgumentException('Fitur tidak valid');
    }
    if (!am2_may_set_feature($auth, $feature)) {
        /*
         * Two different failures wore one name.
         *
         * An empty $auth is not an administrator who lacks a right: it is a
         * lookup that found no row for the id the request was made under, which
         * is a fault on this side. Both refuse the change and both told the
         * operator the same thing, so the log was the only place they could be
         * told apart -- and it called them both admin-lacks-right.
         *
         * Every refusal recorded on production so far carries that reason, and
         * with the administrators all holding every right it could not be
         * decided from the log which of the two had happened. Naming them
         * separately costs one branch and settles it the next time it occurs.
         */
        $refuse($auth === [] ? 'admin-identity-unresolved' : 'admin-lacks-right');
        throw new RuntimeException('Akses ditolak');
    }

    $value = am2_feature_value($feature, $raw);
    if ($value === null) {
        $refuse('unrecognised-value');
        throw new InvalidArgumentException('Nilai tidak valid');
    }

    /*
     * Declared after the refusals and before the write: a refused change never
     * happened, so it owes nothing, and every path that reaches the database
     * from here is one the caller must record.
     */
    am2_audit_expect(__FUNCTION__);

    // $feature is a key of AM2_FEATURES by the check above, so it is one of
    // four literals; $value is one of four literals from am2_feature_value().
    // Neither is caller text by the time it reaches here.
    $sql = "INSERT INTO public.user_app_permissions (user_id, {$feature}, updated_at)
            VALUES (?, " . $pdo->quote($value) . ", NOW())
            ON CONFLICT (user_id)
            DO UPDATE SET {$feature} = EXCLUDED.{$feature}, updated_at = NOW()";
    $pdo->prepare($sql)->execute([$userId]);

    $stmt = $pdo->prepare('SELECT * FROM public.user_app_permissions WHERE user_id = ?');
    $stmt->execute([$userId]);
    return $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
}

/**
 * The reason a refusal can be shown to the caller.
 *
 * Only this file's own two exception types carry a message meant for a human;
 * anything else is a database error whose text names the failing SQL. Pages
 * call this instead of reaching for getMessage(), which is what keeps the
 * guard against echoing exception text strict enough to be worth having.
 */
function am2_feature_reason(Throwable $e): string
{
    if ($e instanceof InvalidArgumentException || $e instanceof RuntimeException) {
        return $e->getMessage();
    }
    return 'Gagal memperbarui fitur';
}

/**
 * How the activity log should describe it: the code and its parameters.
 *
 * Three events wear one name. Turning a switch on, turning it off and moving a
 * unit between half and full duplex read as three different sentences, and
 * only the first two are even the same shape — the third has no on or off, it
 * has a mode.
 */
function am2_feature_log(string $feature, string $value, string $userId, string $name): array
{
    $params = ['name' => $name, 'id' => $userId];

    if ($feature === 'duplex_mode') {
        $params['mode'] = $value;
        return ['feature.duplex', $params];
    }

    $params['feature'] = AM2_FEATURE_LABELS[$feature];
    return [$value === 'true' ? 'feature.enable' : 'feature.disable', $params];
}
