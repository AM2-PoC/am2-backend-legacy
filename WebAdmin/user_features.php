<?php

require_once __DIR__ . '/session_boot.php';
am2_refuse_direct_request(__FILE__);

const AM2_FEATURES = [
    'enable_maps'      => 'can_manage_maps',
    'enable_p2p'       => 'can_manage_p2p',
    'enable_ptt_video' => 'can_manage_video',

    'duplex_mode'      => null,
];

const AM2_FEATURE_LABELS = [
    'enable_maps'      => '@log.f_maps',
    'enable_p2p'       => '@log.f_p2p',
    'enable_ptt_video' => '@log.f_video',
    'duplex_mode'      => '@log.f_duplex',
];

function am2_feature_value(string $feature, $raw)
{
    if ($feature === 'duplex_mode') {
        $v = strtoupper(trim((string) $raw));
        return in_array($v, ['FULL DUPLEX', 'HALF DUPLEX'], true) ? $v : null;
    }
    return ($raw === 'true' || $raw === true || $raw === '1' || $raw === 1) ? 'true' : 'false';
}

function am2_may_set_feature(array $auth, string $feature): bool
{

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

        $refuse($auth === [] ? 'admin-identity-unresolved' : 'admin-lacks-right');
        throw new RuntimeException('Akses ditolak');
    }

    $value = am2_feature_value($feature, $raw);
    if ($value === null) {
        $refuse('unrecognised-value');
        throw new InvalidArgumentException('Nilai tidak valid');
    }

    am2_audit_expect(__FUNCTION__);

    $sql = "INSERT INTO public.user_app_permissions (user_id, {$feature}, updated_at)
            VALUES (?, " . $pdo->quote($value) . ", NOW())
            ON CONFLICT (user_id)
            DO UPDATE SET {$feature} = EXCLUDED.{$feature}, updated_at = NOW()";
    $pdo->prepare($sql)->execute([$userId]);

    $stmt = $pdo->prepare('SELECT * FROM public.user_app_permissions WHERE user_id = ?');
    $stmt->execute([$userId]);
    return $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
}

function am2_feature_reason(Throwable $e): string
{
    if ($e instanceof InvalidArgumentException || $e instanceof RuntimeException) {
        return $e->getMessage();
    }
    return 'Gagal memperbarui fitur';
}

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
