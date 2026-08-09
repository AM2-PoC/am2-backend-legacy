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
