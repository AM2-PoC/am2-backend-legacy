<?php
/**
 * Stores structured audit events and renders localized text at read time.
 * Legacy rows without `event_code` continue to use `keterangan`.
 */

// Not an endpoint. See am2_refuse_direct_request().
require_once __DIR__ . '/session_boot.php';
am2_refuse_direct_request(__FILE__);

/**
 * The mutations in this transaction that still owe an audit event.
 *
 * Every helper that changes a unit declares itself here, and every am2_log()
 * clears one. am2_audit_complete() is called before the commit and refuses if
 * the two do not balance.
 *
 * Why this exists rather than am2_log() living inside the helpers: the log row
 * and the change it records must land in one transaction, and the caller is
 * what owns the transaction. Moving the write into the helper would also give
 * every current caller a second event, because all six already log. So the
 * invariant is not "the helper logs" but "exactly one event per mutation" --
 * not zero, which is a change nobody can attribute afterwards, and not two,
 * which is a trail claiming something happened twice.
 *
 * @var list<string>
 */
$GLOBALS['am2_audit_owed'] = [];

/**
 * Declare that this mutation owes an audit event.
 *
 * Called by the helper doing the changing, so a caller added later inherits the
 * obligation instead of having to know about it.
 */
function am2_audit_expect(string $mutation): void
{
    $GLOBALS['am2_audit_owed'][] = $mutation;
}

/** Reject a transaction with unaudited mutations before commit. */
function am2_audit_complete(): void
{
    $owed = $GLOBALS['am2_audit_owed'];
    // Cleared before throwing, so one failed request cannot make the next one
    // fail for a debt it never incurred.
    $GLOBALS['am2_audit_owed'] = [];

    if ($owed !== []) {
        throw new LogicException(
            'mutation without an audit event: ' . implode(', ', $owed)
        );
    }
}

/** Clear pending audit state after transaction rollback. */
function am2_audit_abandon(): void
{
    $GLOBALS['am2_audit_owed'] = [];
}

/**
 * Record an event while preserving the legacy action category used by the
 * Admin app. Catalog-key parameters begin with `@`.
 */
function am2_log(
    PDO $pdo,
    $admin_id,
    string $aksi,
    string $code,
    array $params = [],
    ?string $table = null,
    ?string $dataId = null
): void {
    /*
     * Settle one debt, and refuse an event nothing asked for.
     *
     * Popped before the write rather than after it: am2_log() swallows its own
     * database failures on purpose, and a caller that did its part must not be
     * rolled back because the log table was unreachable. The debt is about
     * whether the call was made, not whether the row landed.
     *
     * The empty case is the duplicate: a second event for a mutation that was
     * already recorded says the action happened twice.
     */
    if ($GLOBALS['am2_audit_owed'] === []) {
        throw new LogicException("unexpected audit event '{$code}': no mutation is waiting for one");
    }
    // Oldest first, so what a failure names is the mutation still owing a
    // record rather than whichever happened to be declared last.
    array_shift($GLOBALS['am2_audit_owed']);

    // A log write must never be the reason an action fails. The action has
    // already happened by the time we are called; losing the record of it is
    // bad, and rolling back a completed change because the record could not be
    // written is worse.
    try {
        $pdo->prepare(
            'INSERT INTO public.admin_activity_logs
                (admin_id, aksi, tabel_target, data_id, event_code, event_params, waktu)
             VALUES (?, ?, ?, ?, ?, ?, NOW())'
        )->execute([
            $admin_id !== '' ? $admin_id : null,
            $aksi,
            $table,
            $dataId,
            $code,
            json_encode($params, JSON_UNESCAPED_UNICODE),
        ]);
    } catch (Throwable $e) {
        error_log(sprintf('AM2 activity-log write failed code=%s: %s', $code, $e->getMessage()));
    }
}

/** A parameter that names a catalog key, resolved; anything else, as it is. */
function am2_log_value($value): string
{
    if (is_string($value) && $value !== '' && $value[0] === '@') {
        return t(substr($value, 1));
    }
    return is_scalar($value) ? (string) $value : '';
}

/**
 * The channel list on an access event.
 *
 * Stored structured -- name, whether it is the default, what the unit may do
 * there -- so the sentence can say it in either language. FULL DUPLEX and RX
 * are protocol values the relay compares against, not prose, and are printed
 * as they are.
 */
function am2_log_channels(array $channels): string
{
    $out = [];
    foreach ($channels as $c) {
        if (!is_array($c)) {
            $out[] = (string) $c;
            continue;
        }
        $line = (string) ($c['name'] ?? '');
        if (!empty($c['default'])) {
            $line .= ' (' . t('log.default') . ')';
        }
        if (!empty($c['perm'])) {
            $line .= ' [' . $c['perm'] . ']';
        }
        $out[] = $line;
    }
    return implode(', ', $out);
}

/**
 * The sentence for one row.
 *
 * $params arrives as it came out of the database: a JSON string, or already
 * decoded. Returns the free-text fallback when there is no code, which is
 * every row written before migration 002.
 */
function am2_log_text(?string $code, $params, ?string $fallback = null): string
{
    if ($code === null || $code === '') {
        return (string) ($fallback ?? '');
    }

    if (is_string($params)) {
        $params = json_decode($params, true);
    }
    if (!is_array($params)) {
        $params = [];
    }

    $replace = [];
    foreach ($params as $k => $v) {
        if ($k === 'channels' && is_array($v)) {
            $replace[$k] = am2_log_channels($v);
            continue;
        }
        if ($k === 'via') {
            continue;   // handled below, as a suffix
        }
        $replace[$k] = am2_log_value($v);
    }

    $key  = 'log.' . $code;
    $text = t($key, $replace);

    // t() answers with the key itself when it is missing, which would put
    // "log.user.create" on the screen. The free text is a better answer, and
    // an unrecognised code is worth a line in the error log rather than a
    // silent gap on the page.
    if ($text === $key) {
        error_log('AM2 activity-log unknown event code: ' . $code);
        return (string) ($fallback ?? $key);
    }

    if (!empty($params['via'])) {
        $viaKey = 'log.via_' . $params['via'];
        $via = t($viaKey);
        if ($via !== $viaKey) {
            $text .= ' (' . $via . ')';
        }
    }

    return $text;
}
