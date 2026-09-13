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
    public function __construct(string $sqlState, string $message = 'fixture')
    {
        parent::__construct($message);
        $this->code = $sqlState;
    }
}

$failed = [];

/*
 * Only the unit's own primary key means the ID is taken. The users trigger also
 * inserts into admin_activity_logs; if that sequence ever falls behind, the
 * same SQLSTATE would otherwise tell the operator every new ID is a duplicate.
 */
$unique = static fn (string $constraint): FixturePdoException => new FixturePdoException(
    '23505',
    'SQLSTATE[23505]: Unique violation: 7 ERROR:  duplicate key value violates unique constraint "'
        . $constraint . '"'
);

$cases = [
    'users primary key violation is a taken ID' => [$unique('users_pkey'), true],
    'another unique violation is not' => [$unique('admin_activity_logs_pkey'), false],
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
    // The generic path must stay behind am2_safe_error(), so SQL text never
    // reaches the operator.
    if (!preg_match('/am2_is_duplicate_unit_id\(\$e\)[\s\S]{0,200}msg\.user_id_taken[\s\S]{0,200}am2_safe_error\(\$e/', $source)) {
        $failed[] = "$caller does not report a taken ID as msg.user_id_taken with am2_safe_error() as the fallback";
    }
}

if ($failed !== []) {
    fwrite(STDERR, "FAIL: " . implode("\nFAIL: ", $failed) . "\n");
    exit(1);
}
echo "ok: a taken unit ID is reported as such by both callers\n";
