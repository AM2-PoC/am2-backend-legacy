<?php

declare(strict_types=1);

/**
 * Resolve a published administrator APK to the exact regular file it names.
 * Returns null unless both URLs are simple HTTPS origins and the candidate is
 * directly below the configured update path.
 */
function am2_admin_update_file(string $baseUrl, string $downloadUrl, string $updateDir): ?string
{
    $base = parse_url($baseUrl);
    $candidate = parse_url($downloadUrl);
    $forbidden = ['user', 'pass', 'query', 'fragment'];

    if (!is_array($base) || !is_array($candidate)) {
        return null;
    }
    foreach ([$base, $candidate] as $url) {
        if (strtolower((string) ($url['scheme'] ?? '')) !== 'https'
            || (string) ($url['host'] ?? '') === '') {
            return null;
        }
        foreach ($forbidden as $part) {
            if (array_key_exists($part, $url)) {
                return null;
            }
        }
    }

    if (strcasecmp((string) $base['host'], (string) $candidate['host']) !== 0
        || ($base['port'] ?? null) !== ($candidate['port'] ?? null)) {
        return null;
    }

    $basePath = rtrim('/' . ltrim((string) ($base['path'] ?? ''), '/'), '/');
    $candidatePath = '/' . ltrim((string) ($candidate['path'] ?? ''), '/');
    if ($basePath === '' || !str_starts_with($candidatePath, $basePath . '/')) {
        return null;
    }

    $relative = substr($candidatePath, strlen($basePath) + 1);
    if ($relative === '' || str_contains($relative, '/') || str_contains($relative, '\\')
        || str_contains($relative, '%')
        || preg_match('/^[A-Za-z0-9][A-Za-z0-9._-]*\.apk$/D', $relative) !== 1) {
        return null;
    }

    $file = rtrim($updateDir, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $relative;
    return is_file($file) && !is_link($file) ? $file : null;
}
