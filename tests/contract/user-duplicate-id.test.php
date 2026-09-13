<?php

declare(strict_types=1);

/*
 * Registering a unit under an ID that is already taken tells the admin so.
 *
 * The panel page has always said "ID :id sudah terdaftar". The endpoint the
 * Admin app calls caught the same unique violation as a generic failure and
 * answered "Gagal: Terjadi kesalahan sistem.", so the operator could not tell a
 * typo'd duplicate from a broken server. Both callers now ask one predicate.
 */

require_once __DIR__ . '/../../WebAdmin/user_rules.php';

final class FixturePdoException extends PDOException
{
    public function __construct(string $sqlState)
    {
        parent::__construct('fixture');
        $this->code = $sqlState;
    }
}

$failed = [];

$cases = [
    'unique violation is a taken ID' => [new FixturePdoException('23505'), true],
    'foreign key violation is not' => [new FixturePdoException('23503'), false],
    'non-database failure is not' => [new RuntimeException('fixture'), false],
];
foreach ($cases as $name => [$error, $expected]) {
    if (!function_exists('am2_is_duplicate_unit_id')) {
        $failed[] = 'am2_is_duplicate_unit_id() is not defined';
        break;
    }
    if (am2_is_duplicate_unit_id($error) !== $expected) {
        $failed[] = $name;
    }
}

foreach (['api_users.php', 'users.php'] as $caller) {
    $source = file_get_contents(__DIR__ . '/../../WebAdmin/' . $caller);
    if (!preg_match('/am2_is_duplicate_unit_id\(\$e\)[\s\S]{0,200}msg\.user_id_taken/', $source)) {
        $failed[] = "$caller does not report a taken ID as msg.user_id_taken";
    }
}

if ($failed !== []) {
    fwrite(STDERR, "FAIL: " . implode("\nFAIL: ", $failed) . "\n");
    exit(1);
}
echo "ok: a taken unit ID is reported as such by both callers\n";
