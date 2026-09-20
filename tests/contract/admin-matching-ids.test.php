<?php

declare(strict_types=1);

// Run only in an isolated test environment; never load application config.
require_once __DIR__ . '/../../WebAdmin/admin_rules.php';
require_once __DIR__ . '/../../WebAdmin/i18n.php';
function am2_icon(string $name, string $extra = ''): string { return ''; }
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
$pdo->exec('CREATE TABLE public.admin (id INTEGER PRIMARY KEY, role TEXT)');
$pdo->exec('CREATE TABLE public.users (admin_id INTEGER NOT NULL)');
$insert = $pdo->prepare('INSERT INTO public.admin VALUES (?, ?)');
for ($id = 1; $id <= 26; $id++) $insert->execute([$id, $id === 3 ? 'superadmin' : 'admin']);
$pdo->exec('INSERT INTO public.users VALUES (4), (4)');
$pdo->exec('UPDATE public.admin SET role = NULL WHERE id = 6');
$_SESSION['admin_id'] = 2;
const AM2_ADMIN_PAGE = 20;

$source = file_get_contents(__DIR__ . '/../../WebAdmin/admin_panel.php');
function block(string $source, string $startMarker, string $endMarker): string
{
    $start = strpos($source, $startMarker);
    $end = strpos($source, $endMarker, $start === false ? 0 : $start);
    check($start !== false && $end !== false, 'admin query block missing');
    return substr($source, $start, $end - $start);
}
$filterBlock = block($source, '$search =', '$stmt_count =');
$countBlock = block($source, '$stmt_count =', '$stmt_list =');
$matchingBlock = block($source, '$stmt_all =', '$all_channels =');

// Descending page one cannot expose the low-ID protected rows to DOM filtering.
// Page two and a filtered listing must publish the same policy, not page IDs.
foreach (['', 'branch'] as $filter) {
    foreach ([1, 2] as $requestedPage) {
        $_GET = ['p' => $requestedPage, 'chip' => $filter];
        eval($filterBlock);
        eval($countBlock);
        eval($matchingBlock);
        $pageQuery = $pdo->prepare("SELECT a.* {$fromWhere} ORDER BY a.id DESC LIMIT " . AM2_ADMIN_PAGE . " OFFSET {$offset}");
        $pageQuery->execute($params);
        $visibleIds = array_map('intval', $pageQuery->fetchAll(PDO::FETCH_COLUMN));
        if ($requestedPage === 1) {
            check(count($visibleIds) === AM2_ADMIN_PAGE, 'fixture must fill the first page');
            check(!array_intersect([1, 2, 3, 4, 5], $visibleIds), 'protected and eligible fixtures must be off-page');
        }
        $candidates = $pdo->prepare("SELECT a.* {$fromWhere} ORDER BY a.id");
        $candidates->execute($params);
        $expected = [];
        $rows = $candidates->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as $row) {
            [$reason] = am2_admin_undeletable($pdo, $row, $_SESSION['admin_id']);
            if ($reason === '') $expected[] = (int) $row['id'];
        }
        check(array_map('intval', $allIds) === $expected, 'matching IDs must match deletion policy across pages');
        check(in_array(5, $expected, true), 'eligible off-page admin must remain selectable');
        check($total === count($rows) && $pages === 2, 'selection filtering must not change listing count or pagination');

        // Exercise the real attribute producer, consumed by matchingIds() and
        // the admin am2:bulk handler (scope/counts derive from these IDs).
        ob_start();
        try {
            include __DIR__ . '/../../WebAdmin/partials/table_open.php';
            $html = ob_get_contents();
        } finally {
            ob_end_clean();
        }
        $dom = new DOMDocument();
        @$dom->loadHTML($html . '</table></div></section>');
        $table = (new DOMXPath($dom))->query('//section[@data-am2-table]')->item(0);
        check($table !== null, 'matching table not rendered');
        check($table->getAttribute('data-all-ids') === implode(' ', $expected), 'published matching scope contains protected admins');
        check((int) $table->getAttribute('data-total') === count($rows), 'published total must include protected listing rows');
    }
}
echo "ok: paginated admin matching scope excludes protected off-page accounts without changing listing totals\n";
