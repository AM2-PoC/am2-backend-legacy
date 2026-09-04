<?php
/**
 * The session cookie's flags, decided here rather than left to the host.
 *
 * Nothing in this repository set them. PHPSESSID went out with whatever the
 * machine's php.ini happened to say -- a file that is not tracked, not deployed
 * with the code, and different on the Docker image, the staging host and
 * production. The i18n cookie has always been explicit about its own flags
 * (i18n.php); the one that carries the session was not.
 *
 * What each flag is for:
 *
 * - httponly: script cannot read the cookie, so an XSS anywhere on the panel
 *   cannot lift the session outright. The log view renders admin-typed free
 *   text, which is the page that makes this concrete.
 * - secure: the cookie is never sent over plain HTTP. nginx redirects port 80
 *   to 443, but the browser sends the cookie *on the request that receives the
 *   redirect* -- so without this the session id crosses the network in clear
 *   before anything can stop it.
 * - samesite=Lax: a cross-site POST cannot ride the session. This is defence
 *   in depth behind am2_csrf_require(), not a replacement for it; Lax rather
 *   than Strict because a link followed from elsewhere should still land on a
 *   signed-in panel.
 *
 * `secure` is conditional because the Apache vhosts listen on plain HTTP behind
 * nginx: setting it unconditionally would make the cookie undeliverable on the
 * local-only listener the contract tests use, and a test suite that cannot hold
 * a session tests nothing.
 *
 * Included instead of a bare session_start() so every entry point gets the same
 * answer. Several pages start their session before config.php is required, so
 * this cannot live there.
 */

if (!function_exists('am2_session_boot')) {
    function am2_session_boot(): void
    {
        if (session_status() !== PHP_SESSION_NONE || headers_sent()) {
            return;
        }

        // X-Forwarded-Proto is what nginx sets; $_SERVER['HTTPS'] covers a
        // direct TLS listener. Either one means the browser is on HTTPS.
        $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
            || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');

        // Refuse a session id the caller invented.
        //
        // Without this PHP creates a session under whatever id arrives, so an
        // attacker can choose the id, get an operator to sign in on it, and
        // hold a signed-in session. It mattered less while identity could be
        // claimed outright in a query string -- there were easier ways in --
        // and it is decisive now that the session is the only authority.
        //
        // Set here rather than in php.ini for the same reason the cookie flags
        // are: that file is not tracked, not deployed with the code, and
        // different on every host this runs on.
        ini_set('session.use_strict_mode', '1');

        session_set_cookie_params([
            'lifetime' => 0,
            'path'     => '/',
            'secure'   => $https,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);

        session_start();
    }
}

if (!function_exists('am2_session_login')) {
    /**
     * Rotate the session id at login, and issue exactly one cookie for it.
     *
     * session_regenerate_id() does not replace the Set-Cookie header already
     * queued by session_start(); it appends a second one. Two PHPSESSID cookies
     * then leave the server -- the dead id first, the live id second.
     *
     * A browser is fine with that. RFC 6265 has the store replace by
     * (name, domain, path) as it processes them in order, so the second
     * overwrites the first and only the live id survives. Admin Native does not
     * use a browser's store: its jar kept both, sent both, and PHP takes the
     * *first* PHPSESSID in a Cookie header -- the dead one, half the time,
     * because the jar was backed by an unordered set. Those handsets ran the
     * whole login anonymously, which read as "Gagal memperbarui fitur" on any
     * switch that needs an admin right.
     *
     * The jar is being fixed too. This is the other half: a response that
     * cannot be misread does not depend on every client reading it correctly.
     *
     * Only session cookies are dropped. header_remove() takes a whole name at
     * once, so anything else already queued -- am2_lang from ?lang= on the
     * login form -- is read back and re-sent rather than lost.
     */
    function am2_session_login(): void
    {
        session_regenerate_id(true);

        if (headers_sent()) {
            return;
        }

        $prefix = session_name() . '=';
        $others = [];
        foreach (headers_list() as $header) {
            if (stripos($header, 'Set-Cookie:') !== 0) {
                continue;
            }
            $value = ltrim(substr($header, strlen('Set-Cookie:')));
            if (stripos($value, $prefix) !== 0) {
                $others[] = $value;
            }
        }

        header_remove('Set-Cookie');
        foreach ($others as $value) {
            header('Set-Cookie: ' . $value, false);
        }

        // Rebuilt from the live parameters rather than by keeping one of the
        // removed headers: the id is the one regeneration just created, and the
        // flags are whatever am2_session_boot() decided for this request.
        $params = session_get_cookie_params();
        setcookie(session_name(), session_id(), [
            'expires'  => $params['lifetime'] ? time() + $params['lifetime'] : 0,
            'path'     => $params['path'],
            'domain'   => $params['domain'],
            'secure'   => $params['secure'],
            'httponly' => $params['httponly'],
            'samesite' => $params['samesite'],
        ]);
    }
}

if (!function_exists('am2_refuse_direct_request')) {
    /**
     * A library is not an endpoint. Refuse to be one.
     *
     * Eight files in the panel define functions and render nothing, and they
     * sit in the document root like everything else, so they can be requested
     * by URL. None of them included config.php, which meant the only thing
     * between them and an anonymous caller was the auto_prepend net -- exactly
     * the inversion of the stated design, where config.php is the floor and the
     * prepend is the net.
     *
     * Production demonstrated it rather than theorised it: six of them answered
     * 200 between the release symlink moving at 16:24 on 2026-09-04 and the
     * guard being installed four minutes later.
     *
     * Authenticating them would be the wrong fix. They have nothing to show a
     * signed-in caller either. 404 is the honest answer: as far as the web is
     * concerned this file does not exist.
     */
    function am2_refuse_direct_request(string $file): void
    {
        if (PHP_SAPI === 'cli') {
            return;
        }
        $script = realpath((string) ($_SERVER['SCRIPT_FILENAME'] ?? ''));
        if ($script !== false && $script === realpath($file)) {
            http_response_code(404);
            exit;
        }
    }
}
