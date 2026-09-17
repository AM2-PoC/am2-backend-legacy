<?php

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

        if ($contentType !== '' && stripos($contentType, 'text/html') !== 0) {
            return $body;
        }
        $filtered = preg_replace('/<!--(?!\[if\b)[\s\S]*?-->/i', '', $body);
        return $filtered ?? $body;
    });
}
