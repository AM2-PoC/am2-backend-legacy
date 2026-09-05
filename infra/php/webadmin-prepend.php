<?php
/**
 * What runs before every PHP request to the panel, whatever it forgot to do.
 *
 * Installed as PHP's auto_prepend_file. It does two jobs that have nothing to
 * do with each other except that both must happen before the script does:
 *
 *   1. Authenticate. config.php authenticates too, and that copy is the
 *      authoritative one because it travels with the code. This copy exists for
 *      the file that forgets to require config.php at all -- a new endpoint
 *      dropped into the docroot, a debug script left behind after an incident.
 *      Such a file is protected the moment it exists, without anyone
 *      remembering anything.
 *   2. Strip server-side commentary out of rendered HTML, which is what this
 *      file did before the guard joined it.
 *
 * This is the net, not the floor. It hangs off host configuration, and the host
 * is scheduled to swap Apache for nginx and PHP-FPM; a directive in a vhost
 * does not survive that on its own. Which is exactly why it must be installed
 * into PHP's own configuration -- see infra/scripts/install-webadmin-guard.sh
 * -- rather than into a vhost, and why config.php does not depend on it.
 *
 * Static files are untouched: auto_prepend_file applies to PHP execution only,
 * so the field update channel (update/admin.apk and update/admin_version.json,
 * both plain files) never reaches this code and keeps answering handsets that
 * have no session and never will.
 */

/*
 * The panel is found through the running request, never through a path written
 * into /etc.
 *
 * Releases are immutable directories and `current` is a symlink that moves. A
 * prepend naming one release keeps loading the old code after a deploy, and
 * loads nothing once that release is pruned -- and a guard that fails to load
 * is a guard that is not there, silently, in the direction of open. Resolving
 * from DOCUMENT_ROOT means this file is correct for production, for staging and
 * for whatever a future host calls its directories.
 */
$am2GuardPath = rtrim((string) ($_SERVER['DOCUMENT_ROOT'] ?? ''), '/') . '/auth_guard.php';
if ($am2GuardPath !== '/auth_guard.php' && is_readable($am2GuardPath)) {
    require_once $am2GuardPath;
    am2_require_identity();
} elseif (PHP_SAPI !== 'cli') {
    /*
     * Say so. An empty DOCUMENT_ROOT, a permissions change, a rename of
     * auth_guard.php -- any of these and this net is simply not there, and the
     * header above says exactly why that matters: "a guard that fails to load
     * is a guard that is not there, silently, in the direction of open."
     * Silently was the part worth fixing. config.php still guards every file
     * that includes it, so this is a warning rather than a refusal.
     */
    error_log('AM2 guard: auto_prepend could not load ' . $am2GuardPath
        . ' -- layer two is not running for ' . ($_SERVER['REQUEST_URI'] ?? '?'));
}
unset($am2GuardPath);

/**
 * Remove server-side implementation commentary from rendered WebAdmin HTML.
 * Source comments remain available to maintainers but never reach the browser.
 */
if (!defined('AM2_OUTPUT_FILTER_ACTIVE')) {
    define('AM2_OUTPUT_FILTER_ACTIVE', true);
    ob_start(static function (string $body): string {
        $contentType = PHP_SAPI === 'cli'
            ? (getenv('AM2_OUTPUT_FILTER_CONTENT_TYPE') ?: '')
            : '';
        foreach (headers_list() as $header) {
            if (stripos($header, 'Content-Type:') === 0) {
                $contentType = trim(substr($header, strlen('Content-Type:')));
                break;
            }
        }
        // PHP defaults ordinary rendered pages to text/html. Explicit JSON,
        // CSV, APK/download, and other response types remain byte-for-byte.
        if ($contentType !== '' && stripos($contentType, 'text/html') !== 0) {
            return $body;
        }
        $filtered = preg_replace('/<!--(?!\[if\b)[\s\S]*?-->/i', '', $body);
        return $filtered ?? $body;
    });
}
