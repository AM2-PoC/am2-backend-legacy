<?php

declare(strict_types=1);

require_once __DIR__ . '/../../WebAdmin/config.php';

$validate = static function (string $base, string $url, string $root): bool {
    return am2_admin_update_file($base, $url, $root) !== null;
};

$root = sys_get_temp_dir() . '/am2-update-manifest-' . bin2hex(random_bytes(6));
if (!mkdir($root, 0700) || file_put_contents($root . '/admin.apk', 'apk') === false) {
    fwrite(STDERR, "fixture setup failed\n");
    exit(2);
}
file_put_contents($root . '/admin_version.json', '{}');
symlink($root . '/admin.apk', $root . '/linked.apk');

$base = 'https://webadmin.am2-poc.com/update';
$cases = [
    'valid direct APK' => [$base, $base . '/admin.apk', true],
    'nested path with basename collision' => [$base, $base . '/missing/admin.apk', false],
    'same host outside update path' => [$base, 'https://webadmin.am2-poc.com/admin.apk', false],
    'metadata instead of APK' => [$base, $base . '/admin_version.json', false],
    'query string' => [$base, $base . '/admin.apk?build=1', false],
    'fragment' => [$base, $base . '/admin.apk#download', false],
    'userinfo' => [$base, 'https://user@webadmin.am2-poc.com/update/admin.apk', false],
    'symlink APK' => [$base, $base . '/linked.apk', false],
    'HTTP configured base' => ['http://webadmin.am2-poc.com/update', $base . '/admin.apk', false],
    'configured base query' => [$base . '?env=prod', $base . '/admin.apk', false],
    'configured base userinfo' => ['https://user@webadmin.am2-poc.com/update', $base . '/admin.apk', false],
    'different host' => [$base, 'https://staging-webadmin.am2-poc.com/update/admin.apk', false],
];

$failed = [];
foreach ($cases as $name => [$configuredBase, $candidate, $expected]) {
    $actual = $validate($configuredBase, $candidate, $root);
    if ($actual !== $expected) {
        $failed[] = sprintf('%s: expected %s, got %s', $name, $expected ? 'accept' : 'reject', $actual ? 'accept' : 'reject');
    }
}

@unlink($root . '/linked.apk');
@unlink($root . '/admin.apk');
@unlink($root . '/admin_version.json');
@rmdir($root);

if ($failed) {
    fwrite(STDERR, implode("\n", $failed) . "\n");
    exit(1);
}

echo 'update-manifest-runtime: ' . count($cases) . "/" . count($cases) . " passed\n";
