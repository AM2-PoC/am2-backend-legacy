<?php
/**
 * The session guard every panel page runs before anything else.
 *
 * Order matters and used to be wrong. Pages included this file first and
 * config.php second, but idle expiry lives in config.php -- so the first
 * request after a timeout passed the guard, then had its session destroyed,
 * and went on to run the handler with no identity at all. am2_csrf_require()
 * does not catch it either: it returns early when the session is not logged
 * in, so a POST arriving after the timeout was executed with a null admin id.
 *
 * Loading config.php from here means the session is started, expired and only
 * then authorized.
 */
require_once __DIR__ . '/config.php';

/** True when this looks like a fetch() rather than a document request. */
function am2_wants_json(): bool
{
    return str_contains($_SERVER['HTTP_ACCEPT'] ?? '', 'json')
        || str_contains($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '', 'XMLHttpRequest');
}

if (!isset($_SESSION['admin_logged_in']) || $_SESSION['admin_logged_in'] !== true) {
    // A redirect to login.php answers a fetch() with a 200 and a page of HTML,
    // which the caller then tries to parse as JSON. Say what happened instead.
    if (am2_wants_json()) {
        // 401 either way: 419 is a framework invention, not an IANA status,
        // and Apache answers 500 rather than pass it through. The caller
        // tells the two apart by `code`.
        http_response_code(401);
        header('Content-Type: application/json');
        echo json_encode([
            'success' => false,
            'code' => am2_session_timed_out() ? 'session_expired' : 'unauthenticated',
            'message' => t('common.session_expired'),
        ]);
        exit;
    }
    header('Location: login.php' . (am2_session_timed_out() ? '?timeout=1' : ''));
    exit;
}

function is_superadmin() {
    return isset($_SESSION['admin_role']) && $_SESSION['admin_role'] === 'superadmin';
}

/** Send a branch admin back to the dashboard rather than the login page. */
function require_superadmin() {
    if (!is_superadmin()) {
        header("Location: dashboard.php");
        exit;
    }
}
