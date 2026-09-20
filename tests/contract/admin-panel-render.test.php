<?php

declare(strict_types=1);

// Execute the real table template and shared policy without booting live config.
require_once __DIR__ . '/../../WebAdmin/admin_rules.php';
require_once __DIR__ . '/../../WebAdmin/i18n.php';

function am2_icon(string $name, string $extra = ''): string { return ''; }
function am2_csrf_field(): string { return ''; }
function check(bool $ok, string $message): void
{
    if (!$ok) throw new RuntimeException($message);
}
set_error_handler(static function (int $severity, string $message): bool {
    if (!(error_reporting() & $severity)) return false;
    throw new RuntimeException($message);
});

$pdo = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$pdo->exec("ATTACH DATABASE ':memory:' AS public");
$pdo->exec('CREATE TABLE public.users (admin_id INTEGER NOT NULL)');
$pdo->exec('INSERT INTO public.users VALUES (4), (4), (4)');
$_SESSION['admin_id'] = 2;
$permFields = [['can_manage_maps', 'adm.f_maps']];
$admins = [];
foreach ([1 => 'admin', 2 => 'admin', 3 => 'superadmin', 4 => 'admin', 5 => 'admin'] as $id => $role) {
    $admins[] = [
        'id' => $id, 'role' => $role, 'username' => 'fixture-' . $id,
        'current_status' => 'active', 'expired_at' => null,
        'user_quota' => 10, 'channel_quota' => 10,
        'can_manage_maps' => true, 'channel_ids' => [],
    ];
}

$source = file_get_contents(__DIR__ . '/../../WebAdmin/admin_panel.php');
$start = strpos($source, '<tbody');
$end = strpos($source, '</tbody>', $start === false ? 0 : $start);
check($start !== false && $end !== false, 'admin table template not found');
ob_start();
try {
    eval('?>' . substr($source, $start, $end + strlen('</tbody>') - $start));
    $html = ob_get_contents();
} finally {
    ob_end_clean();
}

$dom = new DOMDocument();
@$dom->loadHTML('<html><body><table>' . $html . '</table></body></html>');
$xpath = new DOMXPath($dom);
check($xpath->query('//tr[@data-row-id]')->length === 5, 'table rendering stopped early');
$reasons = [1 => 'adm.locked_master', 2 => 'adm.locked_self', 3 => 'adm.locked_super', 4 => 'adm.locked_owns_units'];
foreach ($admins as $admin) {
    $id = $admin['id'];
    $row = $xpath->query('//tr[@data-row-id="' . $id . '"]')->item(0);
    $checkbox = $xpath->query('.//input[@data-select]', $row)->item(0);
    check($checkbox !== null, "row $id has no selection control");
    check($checkbox->hasAttribute('disabled') === isset($reasons[$id]), "row $id selection policy differs");
    check($xpath->query('.//input[@name="delete_admin_id"]', $row)->length === (isset($reasons[$id]) ? 0 : 1), "row $id delete policy differs");
    check($xpath->query('.//button[@data-row-edit]', $row)->length === 1, "row $id edit control missing");
    check($xpath->query('.//button[@data-row-delegate]', $row)->length === ($admin['role'] === 'superadmin' ? 0 : 1), "row $id delegation control differs");
    if (isset($reasons[$id])) {
        $expected = t($reasons[$id], ['count' => 3]);
        check($checkbox->getAttribute('title') === $expected, "row $id selection reason missing parameters");
        $lock = $xpath->query('.//td[@data-cell="actions"]//span[@title]', $row)->item(0);
        check($lock !== null && $lock->getAttribute('title') === $expected, "row $id lock reason missing parameters");
        check(!str_contains($expected, ':count'), 'ownership count was not translated');
    }
}
echo "ok: admin table renders all rows, protected selection/delete reasons and edit/delegation controls\n";
