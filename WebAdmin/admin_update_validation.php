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

/**
 * The one decision about what may be advertised, for everything that asks.
 *
 * There were two. api_settings.php validated the published set before serving
 * it; the settings card read the same file itself and printed whatever
 * version_name it found. They disagreed in the direction that hides a failure:
 * the card announced a version while every handset asking the endpoint got a
 * 404 and a null, and the number on screen was the reason to believe the
 * channel worked.
 *
 * Returns the verdict, the validated set, and the manifest's changelog. The
 * changelog is carried out separately and never validated -- it is free text
 * that no decision depends on, and it is the only field here allowed to be
 * absent, empty, or written in a language nobody asked for.
 *
 * `reason` is for an operator reading the panel, not for the public endpoint:
 * a handset is told nothing beyond "no update", because a stranger learning
 * exactly which check refused is a stranger learning how to pass it.
 */
function am2_admin_update_advertisement(
    string $updateDir,
    string $baseUrl,
    string $package,
    array $deniedSigners,
    int $installedVersionCode = 0
): array {
    $refused = static fn (string $why, $changelog = ''): array => [
        'valid' => false, 'reason' => $why, 'advertised' => [], 'changelog' => $changelog,
    ];

    $path = rtrim($updateDir, '/') . '/admin_version.json';
    if (!is_file($path) || !is_readable($path)) {
        return $refused('no manifest has been published');
    }

    $parsed = json_decode((string) file_get_contents($path), true);
    if (!is_array($parsed)) {
        return $refused('the manifest is not readable JSON');
    }

    $changelog = $parsed['changelog'] ?? '';
    $advertised = $parsed;
    unset($advertised['changelog']);

    $file = am2_admin_update_file(
        $baseUrl,
        (string) ($parsed['update_url'] ?? ''),
        $updateDir
    );
    if ($file === null) {
        return $refused('download path does not resolve', $changelog);
    }

    // Zero, not the caller's word for it: the server does not know what any
    // handset has installed, and a version code that arrives in the request is
    // a version code the requester chose. The client enforces monotonicity
    // against its own installed build, where the answer is actually known.
    $verdict = am2_validate_signed_update_set(
        $advertised,
        $file,
        $package,
        rtrim($baseUrl, '/') . '/admin.apk',
        $installedVersionCode,
        $deniedSigners
    );

    if ($verdict['valid'] !== true) {
        return $refused((string) $verdict['reason'], $changelog);
    }

    return [
        'valid' => true,
        'reason' => '',
        'advertised' => $advertised,
        'changelog' => $changelog,
    ];
}
