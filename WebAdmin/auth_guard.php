<?php
require_once __DIR__ . '/session_boot.php';
am2_refuse_direct_request(__FILE__);

if (!defined('AM2_PUBLIC_ENTRY')) {
    /* Public entry points are code-reviewed and fail closed; this is not host configuration. */
    define('AM2_PUBLIC_ENTRY', ['login.php', 'api_login.php']);
}

if (!function_exists('am2_entry_point')) {

    function am2_entry_point(): string
    {
        if (($_SERVER['PATH_INFO'] ?? '') !== '') {
            return '';
        }

        $script = realpath((string) ($_SERVER['SCRIPT_FILENAME'] ?? ''));
        $root = realpath((string) ($_SERVER['DOCUMENT_ROOT'] ?? ''));
        if ($script === false || $root === false || dirname($script) !== $root) {
            return '';
        }

        return basename($script);
    }
}

if (!function_exists('am2_signed_in')) {
    /** True when the caller holds a signed-in panel session. */
    function am2_signed_in(): bool
    {
        return session_status() === PHP_SESSION_ACTIVE
            && isset($_SESSION['admin_logged_in'])
            && $_SESSION['admin_logged_in'] === true;
    }
}

if (!function_exists('am2_answers_json_only')) {
    /* JSON-only endpoints must return machine-readable auth failures, never redirects. */
    function am2_answers_json_only(string $entry): bool
    {
        return str_starts_with($entry, 'api_')
            || str_starts_with($entry, 'fetch_')
            || str_contains($entry, '-ajax.');
    }
}

if (!function_exists('am2_require_identity')) {

    function am2_require_identity(): void
    {
        // Maintenance scripts and the test suite run these files outside a
        // request; there is no session to have and nothing to refuse.
        if (PHP_SAPI === 'cli') {
            return;
        }
        $entry = am2_entry_point();
        if (in_array($entry, AM2_PUBLIC_ENTRY, true)) {
            return;
        }
        // Opened only when the caller presents one, so a request that never had
        // a session is not handed one it did not ask for -- that would change
        // the headers Admin Native sees on a refusal.
        if (session_status() === PHP_SESSION_NONE && isset($_COOKIE[session_name()])) {
            am2_session_boot();
        }
        if (am2_signed_in()) {
            return;
        }

        error_log(sprintf(
            'AM2 auth REJECT %s %s from %s ua=%s',
            $_SERVER['REQUEST_METHOD'] ?? '?',
            $_SERVER['REQUEST_URI'] ?? '?',

            (static function (): string {
                $real = $_SERVER['HTTP_X_REAL_IP'] ?? '';
                return (is_string($real) && filter_var($real, FILTER_VALIDATE_IP))
                    ? $real : (string) ($_SERVER['REMOTE_ADDR'] ?? '?');
            })(),
            substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? '-'), 0, 120)
        ));

        $accept = (string) ($_SERVER['HTTP_ACCEPT'] ?? '');
        $dest = (string) ($_SERVER['HTTP_SEC_FETCH_DEST'] ?? '');
        $timedOut = function_exists('am2_session_timed_out') && am2_session_timed_out();
        $subresource = $dest !== '' && $dest !== 'document' && $dest !== 'iframe';
        if (am2_answers_json_only($entry)
            || $subresource
            || str_contains($accept, 'json')
            || str_contains((string) ($_SERVER['HTTP_X_REQUESTED_WITH'] ?? ''), 'XMLHttpRequest')
        ) {
            http_response_code(401);
            header('Content-Type: application/json');
            echo json_encode([
                'success' => false,
                'code' => $timedOut ? 'session_expired' : 'unauthenticated',
                'message' => function_exists('t') ? t('common.session_expired') : 'Unauthorized',
            ]);
            exit;
        }

        header('Location: login.php' . ($timedOut ? '?timeout=1' : ''));
        exit;
    }
}
