<?php
/**
 * AM2 WebAdmin production config loader.
 * Real secrets live outside the web root in /etc/am2/webadmin.env.production.
 */

// Which env file to load. Staging overrides this via Apache SetEnv so it can
// point at its own database and its own node instance.
$envFile = getenv('AM2_ENV_FILE')
    ?: ($_SERVER['AM2_ENV_FILE'] ?? '/etc/am2/webadmin.env.production');

if (is_readable($envFile)) {
    foreach (file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) {
            continue;
        }
        [$key, $value] = explode('=', $line, 2);
        $key = trim($key);
        // First remove whitespace, then remove optional wrapping single/double quotes.
        $value = trim($value);
        $value = trim($value, "\"'");
        putenv($key . '=' . $value);
        $_ENV[$key] = $value;
        $_SERVER[$key] = $value;
    }
}

$timezone = getenv('AM2_TIMEZONE') ?: 'Asia/Jakarta';
date_default_timezone_set($timezone);

$host = getenv('AM2_DB_HOST') ?: '127.0.0.1';
$port = getenv('AM2_DB_PORT') ?: '5432';
$dbname = getenv('AM2_DB_NAME') ?: 'am2';
$user = getenv('AM2_DB_USER') ?: 'admin';
$password = getenv('AM2_DB_PASSWORD') ?: '';

if ($password === '') {
    error_log('AM2 DB password is missing. Check /etc/am2/webadmin.env.production permissions and content.');
    http_response_code(500);
    die('Konfigurasi database belum lengkap.');
}

// Base URL of the node relay. A constant, so the notify helpers defined inside
// the panel pages can reach it without importing a global.
define('AM2_NODE_BASE', rtrim(getenv('AM2_NODE_URL') ?: 'http://localhost:5000', '/'));

/**
 * Refuse an unauthorized machine-to-machine call — or, while the credential is
 * still in log mode, record it and carry on.
 *
 * Returns true when the caller should be stopped.
 */
function am2_api_authz_denied(string $reason): bool
{
    error_log(sprintf(
        'AM2 api-authz REJECT-CANDIDATE %s %s from %s reason=%s',
        $_SERVER['REQUEST_METHOD'] ?? '?',
        $_SERVER['REQUEST_URI'] ?? '?',
        am2_client_ip(),
        $reason
    ));

    if (strtolower((string) (getenv('AM2_API_AUTH_MODE') ?: 'log')) !== 'enforce') {
        return false;
    }

    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'Akses ditolak']);
    return true;
}

/** The header line the panel adds when it calls the node relay. */
function am2_node_auth_header(): string
{
    $key = (string) (getenv('AM2_API_KEY') ?: '');
    return $key === '' ? '' : "X-AM2-Api-Key: {$key}\r\n";
}

/**
 * Authenticate a machine-to-machine caller.
 *
 * Accepts either a panel session (dashboard.php calls api_dashboard_chart.php
 * from the browser) or the shared key.
 *
 * AM2_API_AUTH_MODE:
 *   log     — record what would have been rejected, then continue. The default,
 *             so that turning this on cannot take the Admin Native app down.
 *   enforce — answer 401.
 */
function am2_api_auth(): void
{
    // Most api_*.php files never call session_start(), so a browser request
    // carrying a valid panel session would look anonymous here. dashboard.php
    // calls api_dashboard_chart.php that way.
    if (session_status() === PHP_SESSION_NONE
        && isset($_COOKIE[session_name()])
        && !headers_sent()) {
        session_start();
    }
    if (session_status() === PHP_SESSION_ACTIVE && !empty($_SESSION['admin_logged_in'])) {
        return;
    }

    $expected = (string) (getenv('AM2_API_KEY') ?: '');
    $sent = $_SERVER['HTTP_X_AM2_API_KEY'] ?? ($_GET['api_key'] ?? ($_POST['api_key'] ?? ''));
    $ok = $expected !== '' && is_string($sent) && $sent !== '' && hash_equals($expected, $sent);

    if ($ok) {
        return;
    }

    error_log(sprintf(
        'AM2 api-auth REJECT-CANDIDATE %s %s from %s ua=%s key=%s',
        $_SERVER['REQUEST_METHOD'] ?? '?',
        $_SERVER['REQUEST_URI'] ?? '?',
        am2_client_ip(),
        substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? '-'), 0, 120),
        $sent === '' ? 'absent' : 'wrong'
    ));

    if (strtolower((string) (getenv('AM2_API_AUTH_MODE') ?: 'log')) === 'enforce') {
        http_response_code(401);
        header('Content-Type: application/json');
        echo json_encode(['success' => false, 'message' => 'Unauthorized']);
        exit;
    }
}

/**
 * Who the caller is, decided by the server.
 *
 * Every api_*.php file used to read `admin_id` and `role` straight off the
 * query string. That is the Admin Native contract and it cannot change, but
 * it also meant any authenticated browser session could append
 * `&role=superadmin` and act as one -- api_settings.php `action=export`
 * hands back the whole database on that basis.
 *
 * So: when the caller proved itself with a panel session, identity comes from
 * the session and the request fields are ignored. Only a caller holding the
 * shared key -- the mobile app, which has no session -- may still state its
 * own identity, which is the contract those endpoints were written against.
 *
 * @return array{0: ?string, 1: string, 2: string}  [admin_id, role, via]
 */
function am2_api_identity(): array
{
    // Independent of whether am2_api_auth() ran first, so call order in the
    // endpoints cannot quietly turn a session caller into an anonymous one.
    if (session_status() === PHP_SESSION_NONE
        && isset($_COOKIE[session_name()])
        && !headers_sent()) {
        session_start();
    }
    if (session_status() === PHP_SESSION_ACTIVE && !empty($_SESSION['admin_logged_in'])) {
        return [
            isset($_SESSION['admin_id']) ? (string) $_SESSION['admin_id'] : null,
            (string) ($_SESSION['admin_role'] ?? 'admin'),
            'session',
        ];
    }

    $claimed = $_GET['admin_id'] ?? $_POST['admin_id'] ?? null;
    return [
        ($claimed === null || $claimed === '') ? null : (string) $claimed,
        (string) ($_GET['role'] ?? $_POST['role'] ?? 'admin'),
        'key',
    ];
}

/** True when the caller is a superadmin, as established by am2_api_identity(). */
function am2_api_is_super(): bool
{
    [, $role] = am2_api_identity();
    return strtolower($role) === 'superadmin';
}

/**
 * Stop a caller that is not a superadmin. Returns true when the response has
 * been written and the endpoint must exit.
 *
 * A browser session is refused straight away: the panel never asks these
 * endpoints to do anything a branch admin is allowed to do, so a session
 * arriving here with role=admin is either a bug or an escalation attempt.
 * A key-bearing caller still goes through the AM2_API_AUTH_MODE switch,
 * because that is the Admin Native contract and it has not been updated yet.
 */
function am2_api_require_super(string $what): bool
{
    [, $role, $via] = am2_api_identity();
    if (strtolower($role) === 'superadmin') {
        return false;
    }

    if ($via === 'session') {
        error_log(sprintf(
            'AM2 api-authz REJECT %s %s from %s reason=%s role=%s',
            $_SERVER['REQUEST_METHOD'] ?? '?',
            $_SERVER['REQUEST_URI'] ?? '?',
            am2_client_ip(),
            $what,
            $role
        ));
        http_response_code(403);
        header('Content-Type: application/json');
        echo json_encode(['success' => false, 'message' => 'Akses ditolak']);
        return true;
    }

    return am2_api_authz_denied($what);
}

/**
 * The per-session CSRF token, created on first use.
 */
function am2_csrf_token(): string
{
    if (session_status() !== PHP_SESSION_ACTIVE) {
        return '';
    }
    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf_token'];
}

/** A hidden input carrying the token, for pasting into a form. */
function am2_csrf_field(): string
{
    return '<input type="hidden" name="_csrf" value="'
        . htmlspecialchars(am2_csrf_token(), ENT_QUOTES, 'UTF-8') . '">';
}

/**
 * Reject a state-changing request that did not carry the token.
 *
 * Applied only to requests that already carry a panel session. The api_*.php
 * files are called by the Admin Native app, which has no session and no token;
 * enforcing here would break it. Those get their own credential separately.
 */
function am2_csrf_require(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
        return;
    }
    if (session_status() !== PHP_SESSION_ACTIVE || empty($_SESSION['admin_logged_in'])) {
        return;
    }
    $expected = (string) ($_SESSION['csrf_token'] ?? '');
    $sent = $_POST['_csrf'] ?? ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');
    // A session that has not rendered a form yet has no stored token. Comparing
    // two empty strings succeeds, so without this an authenticated POST would
    // sail through on a session that never saw a form.
    if ($expected === '' || !is_string($sent) || !hash_equals($expected, $sent)) {
        error_log('AM2 CSRF rejected for ' . ($_SERVER['REQUEST_URI'] ?? '?'));
        http_response_code(403);
        if (str_contains($_SERVER['HTTP_ACCEPT'] ?? '', 'json')
            || str_contains($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '', 'XMLHttpRequest')) {
            header('Content-Type: application/json');
            echo json_encode(['success' => false, 'msg' => 'Sesi tidak valid. Muat ulang halaman.']);
        } else {
            echo 'Sesi tidak valid. Muat ulang halaman.';
        }
        exit;
    }
}

/**
 * Expire an idle session.
 *
 * Runs on every request because config.php is included by every page, and by
 * then session_start() has already been called. It deliberately does not
 * redirect: each caller has its own idea of what to do with no session — pages
 * redirect, AJAX endpoints answer JSON — so destroying the session and letting
 * the existing guard fire keeps that behaviour intact.
 */
/** True when this request arrived on a session that had gone idle. */
function am2_session_timed_out(): bool
{
    return !empty($GLOBALS['am2_session_timed_out']);
}

function am2_expire_idle_session(int $maxIdleSeconds = 28800): void
{
    if (session_status() !== PHP_SESSION_ACTIVE) {
        return;
    }
    if (!isset($_SESSION['admin_logged_in'])) {
        return;
    }
    if (isset($_SESSION['last_seen']) && (time() - $_SESSION['last_seen']) > $maxIdleSeconds) {
        $_SESSION = [];
        session_destroy();
        $GLOBALS['am2_session_timed_out'] = true;
        return;
    }
    $_SESSION['last_seen'] = time();
}

/**
 * Count failed sign-ins per client so a password can not be guessed at speed.
 *
 * File-backed: this PHP has neither redis nor apcu, and a database table would
 * need a migration. Fails open if the directory is unusable — locking every
 * admin out because a directory is missing is worse than the thing being
 * prevented.
 */
function am2_throttle_dir(): ?string
{
    $dir = getenv('AM2_THROTTLE_DIR') ?: '/var/lib/am2/login-throttle';
    if (!is_dir($dir) || !is_writable($dir)) {
        error_log('AM2 login throttle disabled: ' . $dir . ' is not writable');
        return null;
    }
    return $dir;
}

function am2_login_blocked(string $client, int $max = 10, int $window = 900): bool
{
    $dir = am2_throttle_dir();
    if ($dir === null) {
        return false;
    }
    $file = $dir . '/' . hash('sha256', $client);
    if (!is_file($file)) {
        return false;
    }
    [$count, $first] = array_pad(explode('|', (string) @file_get_contents($file), 2), 2, 0);
    if ((time() - (int) $first) > $window) {
        @unlink($file);
        return false;
    }
    return (int) $count >= $max;
}

function am2_login_failed(string $client, int $window = 900): void
{
    $dir = am2_throttle_dir();
    if ($dir === null) {
        return;
    }
    $file = $dir . '/' . hash('sha256', $client);
    $count = 0;
    $first = time();
    if (is_file($file)) {
        [$c, $f] = array_pad(explode('|', (string) @file_get_contents($file), 2), 2, 0);
        if ((time() - (int) $f) <= $window) {
            $count = (int) $c;
            $first = (int) $f;
        }
    }
    @file_put_contents($file, ($count + 1) . '|' . $first, LOCK_EX);
    // A dedicated line so fail2ban can pick this up later without parsing HTML.
    error_log('AM2 login failure from ' . $client);
}

function am2_login_succeeded(string $client): void
{
    $dir = am2_throttle_dir();
    if ($dir !== null) {
        @unlink($dir . '/' . hash('sha256', $client));
    }
}

/**
 * The source of the request, for throttling.
 *
 * Deliberately NOT X-Forwarded-For. nginx builds that header with
 * $proxy_add_x_forwarded_for, which appends the real address to whatever the
 * client sent, so its first entry is attacker-controlled — reading it would let
 * anyone reset their own counter by rotating a header.
 *
 * X-Real-IP is set unconditionally by nginx from $remote_addr and cannot be
 * forged. Behind Cloudflare that is an edge address rather than the end user,
 * which is why the throttle key also carries the username: one account being
 * guessed gets blocked without taking down every other admin behind that edge.
 */
function am2_client_ip(): string
{
    $real = $_SERVER['HTTP_X_REAL_IP'] ?? '';
    if ($real !== '' && filter_var($real, FILTER_VALIDATE_IP)) {
        return $real;
    }
    return $_SERVER['REMOTE_ADDR'] ?? 'unknown';
}

/**
 * Log the real error, return something safe to show.
 *
 * Exception text from PDO carries the failing SQL, which used to be echoed
 * into the page and into JSON responses — including to callers that never
 * authenticated.
 */
function am2_safe_error(Throwable $e, string $context = 'query'): string
{
    error_log('AM2 ' . $context . ' failed: ' . $e->getMessage());
    return 'Terjadi kesalahan sistem.';
}

/**
 * Whether the signed-in admin may act on this user.
 *
 * Superadmins may act on anyone. A branch admin may act only on users it owns.
 * Every mutation path used to check that someone was logged in and nothing
 * more, so any branch admin could edit, re-channel, or disconnect another
 * branch's users by supplying their id.
 */
function am2_admin_owns_user(PDO $pdo, $adminId, $adminRole, $userId): bool
{
    if ($adminRole === 'superadmin') {
        return true;
    }
    $stmt = $pdo->prepare("SELECT 1 FROM public.users WHERE id = ? AND admin_id = ?");
    $stmt->execute([$userId, $adminId]);
    return (bool) $stmt->fetchColumn();
}

$dsn = "pgsql:host={$host};port={$port};dbname={$dbname}";

try {
    $pdo = new PDO($dsn, $user, $password, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec("SET TIME ZONE 'Asia/Jakarta'");
    // Start the session here, before expiry and before any guard runs.
    // Cookie-guarded so a keyless API caller is not handed a session it
    // never asked for, which would change the headers Admin Native sees.
    if (session_status() === PHP_SESSION_NONE
        && isset($_COOKIE[session_name()])
        && !headers_sent()) {
        session_start();
    }
    am2_expire_idle_session();
    am2_csrf_require();
} catch (PDOException $e) {
    error_log('AM2 DB connection failed: ' . $e->getMessage());
    http_response_code(500);
    die('Koneksi database gagal.');
}

// The relay client. Loaded last: it needs AM2_NODE_BASE and the auth header
// helper defined above.
require_once __DIR__ . '/i18n.php';
require_once __DIR__ . '/node_client.php';
require_once __DIR__ . '/channel_access.php';
require_once __DIR__ . '/activity_log.php';
?>
