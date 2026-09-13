<?php

declare(strict_types=1);

/*
 * An asset URL changes when the asset's bytes change.
 *
 * Asset responses are cached public and immutable for 30 days, which is only
 * safe while the version query changes with the file. It came from
 * filemtime(), and runtime artifacts are packed with every mtime at the epoch,
 * so every asset on staging and production was served as ?v=0 no matter what
 * it contained: a changed stylesheet or module kept the URL a browser and the
 * edge already held. The version is the file's content digest instead.
 */

require_once __DIR__ . '/../../WebAdmin/i18n.php';

$root = realpath(__DIR__ . '/../../WebAdmin');
$failed = [];

$digest = static fn (string $relative): string => substr(hash_file('sha256', $root . '/' . $relative), 0, 12);

$asset = 'asset/js/livetrack-model.js';
$expected = $asset . '?v=' . $digest($asset);
if (am2_asset($asset) !== htmlspecialchars($expected, ENT_QUOTES, 'UTF-8')) {
    $failed[] = 'am2_asset() version is not the content digest: ' . am2_asset($asset);
}
if (am2_asset_url('./' . $asset) !== './' . $expected) {
    $failed[] = 'am2_asset_url() version is not the content digest: ' . am2_asset_url('./' . $asset);
}

// Two assets with different bytes must not share a version.
$other = 'asset/css/am2-ui.css';
if (substr(am2_asset($other), -12) === substr(am2_asset($asset), -12)) {
    $failed[] = 'different assets share one version';
}

// A path that does not exist keeps a stable, harmless URL.
if (am2_asset('asset/js/does-not-exist.js') !== 'asset/js/does-not-exist.js?v=0') {
    $failed[] = 'a missing asset no longer yields ?v=0: ' . am2_asset('asset/js/does-not-exist.js');
}

if ($failed !== []) {
    fwrite(STDERR, "FAIL: " . implode("\nFAIL: ", $failed) . "\n");
    exit(1);
}
echo "ok: asset URLs carry their content digest\n";
