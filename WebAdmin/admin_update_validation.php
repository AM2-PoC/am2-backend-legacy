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

/**
 * Decide whether one published update manifest may be served for one APK.
 *
 * The contract lives in tests/contract/signed-update-set.test.php, which was
 * written first and then never ran -- the offline selector only globbed .mjs,
 * so this function was called by a test for six days without existing.
 *
 * The handset verifies the signer itself before installing, and that check is
 * the one that actually protects a device; nothing decided here can be trusted
 * by a client. This is the publishing side of the same rule: refuse to
 * advertise a set that the handset would reject anyway, and refuse the two
 * cases the handset cannot see -- a manifest whose digest does not match the
 * bytes on disk, and a download path that is a symlink to somewhere else.
 *
 * Every field is required and the set must be exact. An unexpected key means
 * the publisher and this validator disagree about the format, which is not a
 * condition to resolve by ignoring the extra.
 *
 * @param array<string,mixed> $manifest
 * @param list<string>        $deniedSigners lowercase hex, no colons
 * @return array{valid:bool,reason:string}
 */
function am2_validate_signed_update_set(
    array $manifest,
    string $apkPath,
    string $expectedPackage,
    string $approvedUrl,
    int $installedVersionCode,
    array $deniedSigners
): array {
    $reject = static fn (string $why): array => ['valid' => false, 'reason' => $why];

    $required = [
        'package', 'version_code', 'version_name', 'update_url',
        'sha256', 'signer_sha256', 'source_commit', 'rollout',
    ];
    $actual = array_keys($manifest);
    sort($actual);
    $expected = $required;
    sort($expected);
    if ($actual !== $expected) {
        return $reject('manifest key set is not exact');
    }

    // Strict types throughout: a version code that arrives as the string "2"
    // compares equal to 2 under PHP's loose rules and would let a downgrade
    // through on a manifest that was never machine-generated.
    if (!is_int($manifest['version_code']) || !is_int($manifest['rollout'])) {
        return $reject('version_code and rollout must be integers');
    }
    foreach (['package', 'version_name', 'update_url', 'sha256', 'signer_sha256', 'source_commit'] as $field) {
        if (!is_string($manifest[$field]) || $manifest[$field] === '') {
            return $reject("$field must be a non-empty string");
        }
    }

    if ($manifest['package'] !== $expectedPackage) {
        return $reject('package is not the expected application');
    }
    if ($manifest['update_url'] !== $approvedUrl) {
        return $reject('update_url is not the approved download URL');
    }
    if ($manifest['version_code'] <= $installedVersionCode) {
        return $reject('version_code does not advance past the installed build');
    }
    if ($manifest['rollout'] < 0 || $manifest['rollout'] > 100) {
        return $reject('rollout is outside 0..100');
    }
    if (preg_match('/^[0-9a-f]{40}$/', $manifest['source_commit']) !== 1) {
        return $reject('source_commit is not a full lowercase hex SHA-1');
    }

    $signer = strtolower(str_replace(':', '', $manifest['signer_sha256']));
    if (preg_match('/^[0-9a-f]{64}$/', $signer) !== 1) {
        return $reject('signer_sha256 is not a SHA-256 digest');
    }
    foreach ($deniedSigners as $denied) {
        if ($signer === strtolower(str_replace(':', '', $denied))) {
            return $reject('signer is on the denied list');
        }
    }

    $digest = strtolower($manifest['sha256']);
    if (preg_match('/^[0-9a-f]{64}$/', $digest) !== 1) {
        return $reject('sha256 is not a SHA-256 digest');
    }
    // is_link before is_file: is_file follows the link and would report the
    // target's type, so a symlink pointing at a real APK would pass.
    if (is_link($apkPath) || !is_file($apkPath)) {
        return $reject('APK path is not a regular file');
    }
    $onDisk = hash_file('sha256', $apkPath);
    if ($onDisk === false || !hash_equals($digest, $onDisk)) {
        return $reject('sha256 does not match the bytes on disk');
    }

    return ['valid' => true, 'reason' => ''];
}
