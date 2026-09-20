<?php

declare(strict_types=1);

// In-memory SQL only. Never load config.php or connect to an application DB.
$_GET['lang'] = $argv[1] ?? 'id';
require_once __DIR__ . '/../../WebAdmin/admin_rules.php';
require_once __DIR__ . '/../../WebAdmin/i18n.php';

function check(bool $ok, string $message): void
{
    if (!$ok) throw new RuntimeException($message);
}
set_error_handler(static function (int $severity, string $message): bool {
    if (!(error_reporting() & $severity)) return false;
    throw new RuntimeException($message);
});

class DeleteResponse extends RuntimeException
{
    public function __construct(public array $payload) { parent::__construct(); }
}
function am2_adm_json(array $payload): void { throw new DeleteResponse($payload); }
function am2_safe_error(Throwable $error, string $context): string { return 'safe database failure'; }

class DeleteRacePDO extends PDO
{
    public ?Closure $beforeDelete = null;
    public int $deletes = 0;

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        if (preg_match('/^\s*DELETE FROM public\.admin\b/', $query)) {
            $this->deletes++;
            $hook = $this->beforeDelete;
            $this->beforeDelete = null;
            if ($hook) $hook($this);
        }
        return parent::prepare($query, $options);
    }
}

function database(): DeleteRacePDO
{
    $pdo = new DeleteRacePDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->exec("ATTACH DATABASE ':memory:' AS public");
    $pdo->exec('CREATE TABLE public.admin (id INTEGER PRIMARY KEY, role TEXT)');
    $pdo->exec('CREATE TABLE public.users (admin_id INTEGER NOT NULL)');
    $pdo->exec("INSERT INTO public.admin VALUES (1, 'admin'), (2, 'admin'), (3, 'superadmin'), (4, 'admin')");
    return $pdo;
}

function requestDelete(string $path, DeleteRacePDO $pdo, int $id, bool $ajax = true): array
{
    $_SESSION = ['admin_id' => 2];
    $_POST = ['delete_admin_id' => $id, 'id' => $id, 'ajax' => $ajax ? '1' : ''];
    $success_msg = $error_msg = '';
    $source = file_get_contents(__DIR__ . '/../../WebAdmin/' . $path);
    if ($path === 'admin_panel.php') {
        $start = strpos($source, "if (isset(\$_POST['delete_admin_id']))");
        $end = strpos($source, "if (\$_SERVER['REQUEST_METHOD'] == 'POST'", $start);
        $block = substr($source, $start, $end - $start);
    } else {
        $action = 'delete';
        $start = strpos($source, "elseif (\$action == 'delete')");
        $end = strpos($source, "elseif (\$action == 'delegate')", $start);
        $block = substr($source, $start + 4, $end - $start - 4);
    }
    ob_start();
    try {
        try {
            eval($block);
        } catch (DeleteResponse $response) {
            return $response->payload;
        }
        if ($path === 'admin_panel.php') {
            return ['success' => $success_msg !== '', 'msg' => $error_msg];
        }
        return json_decode(ob_get_contents(), true, 512, JSON_THROW_ON_ERROR);
    } finally {
        ob_end_clean();
    }
}

foreach (['admin_panel.php', 'api_admin_panel.php'] as $path) {
    foreach ([true, false] as $ajax) {
        if ($path === 'api_admin_panel.php' && !$ajax) continue;
        $key = $path === 'admin_panel.php' ? 'msg' : 'message';
        foreach ([1 => 'adm.locked_master', 2 => 'adm.locked_self', 3 => 'adm.locked_super', 99 => 'msg.admin_not_found'] as $id => $reason) {
            $pdo = database();
            $result = requestDelete($path, $pdo, $id, $ajax);
            check($result['success'] === false && $result[$key] === t($reason), "$path protected target reason");
            check($pdo->deletes === 0, "$path attempted protected deletion");
        }
        $pdo = database();
        $pdo->exec('INSERT INTO public.users VALUES (4), (4)');
        $result = requestDelete($path, $pdo, 4, $ajax);
        check($result['success'] === false && $result[$key] === t('adm.locked_owns_units', ['count' => 2]), "$path ownership refusal");
        check($pdo->deletes === 0, "$path attempted owned deletion");

        foreach (['promote', 'gone', 'fk-owned', 'fk-other', 'database-error', 'success', 'null-role'] as $race) {
            $pdo = database();
            $pdo->beforeDelete = static function (PDO $db) use ($race): void {
                if ($race === 'promote') $db->exec("UPDATE public.admin SET role = 'superadmin' WHERE id = 4");
                if ($race === 'null-role') $db->exec('UPDATE public.admin SET role = NULL WHERE id = 4');
                if ($race === 'gone') $db->exec('DELETE FROM public.admin WHERE id = 4');
                if ($race === 'fk-owned') $db->exec('INSERT INTO public.users VALUES (4), (4)');
                if (str_starts_with($race, 'fk-')) throw new PDOException('private constraint details', 23503);
                if ($race === 'database-error') throw new PDOException('private SQL details', 42);
            };
            $result = requestDelete($path, $pdo, 4, $ajax);
            check($result['success'] === in_array($race, ['success', 'null-role'], true), "$path $race false success/refusal");
            $remaining = (int) $pdo->query('SELECT COUNT(*) FROM public.admin WHERE id = 4')->fetchColumn();
            check($remaining === (in_array($race, ['gone', 'success', 'null-role'], true) ? 0 : 1), "$path $race changed protected data");
            if (in_array($race, ['success', 'null-role'], true)) continue;
            check(!str_contains($result[$key], ':count') && !str_contains($result[$key], 'private'), "$path leaked failure detail");
            $reason = match ($race) {
                'promote', 'gone' => 'adm.delete_changed',
                'fk-owned' => 'adm.locked_owns_units',
                'fk-other' => 'adm.locked_references',
                default => null,
            };
            if ($reason) {
                check(t($reason, ['count' => 2]) !== $reason, "$path missing translation");
                check($result[$key] === t($reason, ['count' => 2]), "$path $race untranslated or unhelpful reason");
            }
            else check(str_contains($result[$key], 'safe database failure'), "$path swallowed unexpected DB error");
        }
    }
}

// Exercise the SQL backstop itself, independent of the earlier policy lookup.
foreach ([1, 2, 3] as $id) {
    $pdo = database();
    [$reason] = am2_admin_delete($pdo, ['id' => $id, 'role' => 'admin'], 2);
    check($reason !== '', 'guarded DELETE must refuse immutable targets');
    check((int) $pdo->query('SELECT COUNT(*) FROM public.admin')->fetchColumn() === 4, 'SQL guard lost protected row');
}
echo "ok: admin deletion policy, race guards, response shapes and safe translated failures\n";
