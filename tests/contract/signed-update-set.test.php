<?php

declare(strict_types=1);

require_once __DIR__ . '/../../WebAdmin/admin_update_validation.php';

$root = sys_get_temp_dir() . '/am2-signed-update-' . bin2hex(random_bytes(6));
mkdir($root, 0700, true);
$apk = $root . '/admin.apk';
file_put_contents($apk, "signed-apk-fixture\n");
$sha = hash_file('sha256', $apk);
$signer = str_repeat('a', 64);
$valid = [
    'package' => 'com.am2.admin',
    'version_code' => 2,
    'version_name' => '1.1.0',
    'update_url' => 'https://webadmin.am2-poc.com/update/admin.apk',
    'sha256' => $sha,
    'signer_sha256' => $signer,
    'source_commit' => str_repeat('b', 40),
    'rollout' => 0,
];

$cases = [
    'valid exact set' => [$valid, true],
    'string version code' => [$valid + [], false],
    'wrong checksum' => [array_replace($valid, ['sha256' => str_repeat('0', 64)]), false],
    'debug signer rejected' => [array_replace($valid, ['signer_sha256' => '478c0cb4aa0a3374f152fa4cf90608c42520423c70a561e868a432a5efdcb9a3']), false],
    'wrong package' => [array_replace($valid, ['package' => 'com.example.bad']), false],
    'unapproved URL' => [array_replace($valid, ['update_url' => 'https://evil.example/admin.apk']), false],
    'downgrade' => [array_replace($valid, ['version_code' => 1]), false],
];
$cases['string version code'][0]['version_code'] = '2';

$failed = [];
foreach ($cases as $name => [$manifest, $expected]) {
    $result = am2_validate_signed_update_set(
        $manifest,
        $apk,
        'com.am2.admin',
        'https://webadmin.am2-poc.com/update/admin.apk',
        1,
        ['478c0cb4aa0a3374f152fa4cf90608c42520423c70a561e868a432a5efdcb9a3']
    );
    if ($result['valid'] !== $expected) {
        $failed[] = "$name: expected " . ($expected ? 'accept' : 'reject') . ', got ' . json_encode($result);
    }
}

$link = $root . '/linked.apk';
symlink($apk, $link);
$linkResult = am2_validate_signed_update_set($valid, $link, 'com.am2.admin', $valid['update_url'], 1, []);
if ($linkResult['valid']) $failed[] = 'symlink APK accepted';

@unlink($link);
@unlink($apk);
@rmdir($root);
if ($failed) {
    fwrite(STDERR, implode("\n", $failed) . "\n");
    exit(1);
}
echo 'signed-update-set: ' . (count($cases) + 1) . '/' . (count($cases) + 1) . " passed\n";
