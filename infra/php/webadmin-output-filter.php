<?php
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
