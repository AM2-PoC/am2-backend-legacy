<?php
/**
 * The activity log: written as an event, rendered as a sentence.
 *
 * Every entry used to be one Indonesian string built where it was written.
 * That made the sentence the record, so the Logs page could only ever be as
 * bilingual as the database -- and it made two writers of the same event drift
 * apart, which they had: "Update akses X ke: …" in one file and the same event
 * with " (via Mobile)" glued on the end in another. Nothing could group them
 * and no translator could reach either.
 *
 * A row now carries what happened (`event_code`) and the values it happened to
 * (`event_params`). The sentence is produced by am2_log_text() at display time,
 * from the same catalog as every other string in the panel.
 *
 * Rows written before migration 002 have no code and still render from
 * `keterangan`. They clear themselves within 30 days: runCleanup() in
 * server.js deletes anything older than that.
 */

/**
 * Record an event.
 *
 * $aksi stays what it always was -- CREATE_USER, UPDATE_ACCESS, FORCE_LOGOUT --
 * because api_logs.php hands it to the Admin Native log screen, which groups
 * and colours by it. The code is the new, finer thing beside it.
 *
 * A parameter whose value begins with '@' is itself a catalog key, so a
 * feature name or a table name is translated along with the sentence holding
 * it rather than being frozen in whichever language wrote the row.
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
