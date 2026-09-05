<?php
/**
 * Who may reach this panel at all, decided in one place for every request.
 *
 * There used to be no such place. Each of the thirteen endpoints remembered its
 * own guard and they disagreed: api_logs.php authenticated but never checked
 * CSRF; get-users-ajax.php and fetch_logs.php authenticated nothing and rolled
 * a private session test instead, one of which answered an unauthenticated
 * caller with HTTP 200 and an `error` field -- a refusal no status-reading
 * client could see. A new endpoint inherited whichever neighbour it was copied
 * from, and nobody could tell which without reading all thirteen.
 *
 * This file is loaded twice on purpose, and defines everything conditionally so
 * that loading it twice is free:
 *
 *   1. by config.php, which every endpoint already requires. This is the
 *      authoritative copy and it travels with the code, so it survives the
 *      planned replacement of Apache by nginx and PHP-FPM.
 *   2. by the auto_prepend_file in infra/php/webadmin-prepend.php, which runs
 *      before any script at all. That catches a file which forgets to require
 *      config.php -- but it hangs off host configuration, which is exactly the
 *      kind of thing that goes missing during a web server swap, so it is the
 *      net and not the floor.
 *
 * One definition, two callers. A second copy of the entry list would be a
 * second thing to keep in step, and the pair would disagree exactly once,
 * silently, in the direction of open.
 */

require_once __DIR__ . '/session_boot.php';
am2_refuse_direct_request(__FILE__);

if (!defined('AM2_PUBLIC_ENTRY')) {
    /**
     * The only entry points that answer without a session.
     *
     * A constant in the code, deliberately, and not a setting. The failure this
     * whole change exists to end was a control with an off position: an env
     * file on a host said `log`, the panel stopped refusing anyone, and there
     * was nothing in the repository to show for it. A list that lives in /etc
     * or in a vhost has the same shape -- it grows by one line, on one machine,
     * in a hurry, and nobody ever sees it again. Here it can only grow through
     * a commit somebody reads, and a test pins its exact contents so the growth
     * cannot be quiet.
     *
     * Two names, because there are two ways to obtain a session and nothing
     * else that legitimately has none. Signing out is not among them: with no
     * session there is nothing to sign out of, and the refusal says so.
     */
    define('AM2_PUBLIC_ENTRY', ['login.php', 'api_login.php']);
}

if (!function_exists('am2_entry_point')) {
    /** Resolve only a plain, real script directly below the document root. */
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
    /**
     * True for an endpoint that renders no HTML under any circumstance.
     *
     * Header sniffing alone is not enough, and the gap is not theoretical: a
     * browser fetch() sends `Accept: *\/*`, and the contract suite sends no
     * Accept and no Sec-Fetch-Dest at all. A caller in that position asking
     * fetch_logs.php for data would be handed a 302 to a login *page*, and
     * following it yields 200 and a page of markup -- the exact "refusal
     * nobody can see" that had Admin Native reporting an expired session as a
     * broken feature.
     *
     * So the answer's shape is decided by what the endpoint is first, and by
     * what the caller asked for second. These three families never render a
     * page, so a redirect to one is never a useful answer from them.
     *
     * A presentation rule, not a security one. Guessing wrong costs a caller
     * the wrong error format, never access: whether the caller is signed in
     * has already been decided by the time this is consulted.
     */
    function am2_answers_json_only(string $entry): bool
    {
        return str_starts_with($entry, 'api_')
            || str_starts_with($entry, 'fetch_')
            || str_contains($entry, '-ajax.');
    }
}

if (!function_exists('am2_require_identity')) {
    /**
     * Refuse anyone who is not signed in.
     *
     * This is the half of the design that survives a forgetful maintainer: a
     * new endpoint is protected the moment its file exists, because nothing has
     * to be added to it. Forgetting makes something safe rather than open,
     * which is the only polarity worth shipping.
     */
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
            // config.php is not loaded yet on the prepend path, so resolve the
            // trusted X-Real-IP value here and otherwise fall back safely.
            (static function (): string {
                $real = $_SERVER['HTTP_X_REAL_IP'] ?? '';
                return (is_string($real) && filter_var($real, FILTER_VALIDATE_IP))
                    ? $real : (string) ($_SERVER['REMOTE_ADDR'] ?? '?');
            })(),
            substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? '-'), 0, 120)
        ));

        /*
         * Three kinds of caller, three right answers.
         *
         * A redirect answers a fetch() with 200 and a page of HTML, which the
         * caller then tries to parse as JSON -- that is precisely the shape of
         * the original complaint, where a handset on an expired session was
         * handed a login page and every screen reported its own feature as
         * broken because nothing could see a status. So a fetch() gets 401,
         * which Admin Native's interceptor acts on (and 403, which it
         * deliberately does not).
         *
         * A browser navigating still gets the redirect. The two are told apart
         * by Sec-Fetch-Dest, which every current browser sends and which says
         * what the response is *for*: `document` for a navigation, `empty` for
         * a fetch(). Accept cannot make that distinction -- fetch() defaults to
         * `*\/*`, which looks like nothing in particular.
         *
         * A caller that sends neither header -- curl, the contract suite -- is
         * treated as a document. Not because that is safer in the abstract, but
         * because it is the behaviour that was here before and the behaviour
         * those tests encode; changing it would be an unrelated change riding
         * along with a security fix.
         */
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
