<?php
/**
 * Remove server-side implementation commentary from rendered WebAdmin HTML.
 * Source comments remain available to maintainers but never reach the browser.
 */
if (PHP_SAPI !== 'cli' && !defined('AM2_OUTPUT_FILTER_ACTIVE')) {
    define('AM2_OUTPUT_FILTER_ACTIVE', true);
    ob_start(static function (string $body): string {
        // Only rewrite rendered HTML. JSON, APK/download, and other response
        // bodies must remain byte-for-byte unchanged.
        if (!preg_match('/(?:<!doctype\s+html|<html\b)/i', $body)) {
            return $body;
        }
        $filtered = preg_replace('/<!--(?!\[if\b)[\s\S]*?-->/i', '', $body);
        return $filtered ?? $body;
    });
}
