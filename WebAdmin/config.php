<?php
/**
 * AM2 WebAdmin production config loader.
 * Real secrets live outside the web root in /etc/am2/webadmin.env.production.
 */

// The session cookie's flags, before anything can open a session. Loaded first
// on purpose: several guards below start a session when one is offered, and a
// session started before this file is read would carry the host php.ini's
// flags rather than the ones this application decides.
require_once __DIR__ . '/session_boot.php';

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
define('AM2_ADMIN_UPDATE_BASE', rtrim(
    getenv('AM2_ADMIN_UPDATE_BASE_URL') ?: 'https://webadmin.am2-poc.com/update',
    '/'
));

// Which application the published update is allowed to be. An update set that
// names a different package is not this app's update, whatever else it says.
define('AM2_ADMIN_UPDATE_PACKAGE', getenv('AM2_ADMIN_UPDATE_PACKAGE') ?: 'com.am2.admin');

// Signer fingerprints that may never be advertised, lowercase hex, no colons.
//
// The Android debug signer is denied by default and not by configuration: an
// APK built on a developer's machine is the single most likely thing to reach
// this directory by accident, and a deployment that forgets to set the
// variable should still refuse it. The environment adds to that floor rather
// than replacing it.
define('AM2_ADMIN_UPDATE_DENIED_SIGNERS', array_values(array_unique(array_filter(array_map(
    static fn (string $v): string => strtolower(str_replace(':', '', trim($v))),
    array_merge(
        ['478c0cb4aa0a3374f152fa4cf90608c42520423c70a561e868a432a5efdcb9a3'],
        explode(',', (string) (getenv('AM2_ADMIN_UPDATE_DENIED_SIGNERS') ?: ''))
    )
), static fn (string $v): bool => $v !== ''))));

require_once __DIR__ . '/admin_update_validation.php';
// Identity, the public entry list and the guard itself. Shared with the
// auto_prepend copy so there is exactly one definition of who may get in.
require_once __DIR__ . '/auth_guard.php';

/**
 * Refuse a caller who is authenticated but not allowed to do this.
 *
 * Returns true when the caller has been stopped, which it now always has: this
 * used to consult a mode that could turn the refusal into a log line, and the
 * request would then proceed. Authorization that can be switched off is not
 * authorization, so there is nothing left here to configure.
 *
 * 403, not 401 — the session is fine, the permission is not. Admin Native
 * depends on the distinction: its interceptor signs the operator out on 401
 * and deliberately leaves 403 alone, so that touching something outside your
 * rights does not end your session.
 */
function am2_api_authz_denied(string $reason): bool
{
    error_log(sprintf(
        'AM2 api-authz REJECT %s %s from %s reason=%s',
        $_SERVER['REQUEST_METHOD'] ?? '?',
        $_SERVER['REQUEST_URI'] ?? '?',
        am2_client_ip(),
        $reason
    ));

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
 * Authenticate the caller. One way in: a panel session.
 *
 * There were three ways before, and that was the whole problem. A mode could
 * downgrade the refusal to a log line; a shared key could stand in for a
 * session; and identity could simply be asserted in the query string. Nothing
 * ever sent the key to the panel — the only reader was here and the only writer
 * was a test written for it — while the mode was set to `log` in production,
 * which meant the panel recorded unauthenticated writes and then performed
 * them.
 *
 * So the key is gone from the inbound direction (the panel still *presents* one
 * to the relay; see am2_node_auth_header()), the mode is gone, and what remains
 * is the credential every real caller already carries. Admin Native has held a
 * cookie jar and a CSRF token since build 83 and acts on 401 by signing out, so
 * this closes the hole without a handset release.
 */
function am2_api_auth(): void
{
    // Most api_*.php files never call session_start(), so a browser request
    // carrying a valid panel session would look anonymous here. dashboard.php
    // calls api_dashboard_chart.php that way.
    if (isset($_COOKIE[session_name()])) {
        am2_session_boot();
    }
    if (session_status() === PHP_SESSION_ACTIVE && !empty($_SESSION['admin_logged_in'])) {
        return;
    }

    error_log(sprintf(
        'AM2 api-auth REJECT %s %s from %s ua=%s',
        $_SERVER['REQUEST_METHOD'] ?? '?',
        $_SERVER['REQUEST_URI'] ?? '?',
        am2_client_ip(),
        substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? '-'), 0, 120)
    ));

    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'Unauthorized']);
    exit;
}

/**
 * Who the caller is, decided by the server.
 *
 * Every api_*.php file used to read `admin_id` and `role` straight off the
 * query string, so any caller could append `&role=superadmin` and act as one --
 * api_settings.php `action=export` hands back the whole database on that basis.
 * A first pass preferred the session when one was present but still honoured
 * the request fields when one was not, which left the hole open for exactly the
 * caller that had not authenticated.
 *
 * There is now no second source. Identity is what login.php wrote into the
 * session after reading the row from public.admin, and nothing a request can
 * say changes it. Admin Native still sends admin_id on fourteen endpoints; it
 * is ignored rather than rejected, so the URL and JSON contracts are unchanged
 * and the shipped handset keeps working.
 *
 * @return array{0: ?string, 1: string, 2: string}  [admin_id, role, via]
 */
function am2_api_identity(): array
{
    // Independent of whether am2_api_auth() ran first, so call order in the
    // endpoints cannot quietly turn a session caller into an anonymous one.
    if (isset($_COOKIE[session_name()])) {
        am2_session_boot();
    }
    if (session_status() === PHP_SESSION_ACTIVE && !empty($_SESSION['admin_logged_in'])) {
        return [
            isset($_SESSION['admin_id']) ? (string) $_SESSION['admin_id'] : null,
            (string) ($_SESSION['admin_role'] ?? 'admin'),
            'session',
        ];
    }

    // No session, no identity. Reaching here means a guard was skipped, so name
    // nobody rather than guessing: every caller of this treats a null admin_id
    // as "resolve nothing", which fails closed.
    return [null, '', 'none'];
}

/**
 * Stop a caller that is not a superadmin. Returns true when the response has
 * been written and the endpoint must exit.
 *
 * The panel never asks these endpoints to do anything a branch admin is
 * allowed to do, so a caller arriving here without the superadmin role is
 * either a bug or an escalation attempt. There used to be two answers to that
 * -- refuse a session outright, but put a key-bearing caller through the mode
 * switch -- which meant the same attempt was refused or served depending on how
 * it arrived. One answer now, because there is one kind of caller.
 */
function am2_api_require_super(string $what): bool
{
    [, $role] = am2_api_identity();
    if (strtolower($role) === 'superadmin') {
        return false;
    }

    return am2_api_authz_denied($what . ' role=' . ($role === '' ? 'none' : $role));
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
 * The exemption used to be "no session, no check", written when Admin Native
 * had neither a session nor a token. That is the condition an unauthenticated
 * caller is in, so it exempted precisely the caller it should have stopped —
 * and the app has carried both since build 83, so it protected nobody.
 *
 * It cannot simply be deleted either: a sign-in POST arrives with no session
 * and therefore no stored token, so an unconditional check makes the first
 * sign-in impossible. The exemption is now the same two-name constant the
 * guard uses. Signing in is protected by the credential it carries; every
 * other write is protected by the token.
 */
function am2_csrf_require(): void
{
    // Keep this method-based so future JSON PUT/PATCH/DELETE endpoints cannot
    // silently bypass CSRF just because they do not use PHP form fields.
    if (!in_array($_SERVER['REQUEST_METHOD'] ?? 'GET', ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
        return;
    }
    if (PHP_SAPI === 'cli' || in_array(am2_entry_point(), AM2_PUBLIC_ENTRY, true)) {
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
    if (isset($_COOKIE[session_name()])) {
        am2_session_boot();
    }
    am2_expire_idle_session();
} catch (PDOException $e) {
    error_log('AM2 DB connection failed: ' . $e->getMessage());
    http_response_code(500);
    die('Koneksi database gagal.');
}

// i18n first, so a refusal can be phrased in the operator's language.
require_once __DIR__ . '/i18n.php';

/*
 * The guard, for every request that reaches any file including this one.
 *
 * Order is the whole point and it is the order the incidents taught:
 * session started, idle expiry applied, *then* authentication, *then* CSRF.
 * Authenticating before CSRF is what makes an anonymous POST answer 401 rather
 * than 403 -- and Admin Native signs the operator out on one and not the other,
 * so getting it the wrong way round leaves a handset holding a dead session
 * while every screen reports its own feature as broken.
 */
am2_require_identity();
am2_csrf_require();

// The relay client. Loaded last: it needs AM2_NODE_BASE and the auth header
// helper defined above.
require_once __DIR__ . '/node_client.php';
require_once __DIR__ . '/channel_access.php';
require_once __DIR__ . '/activity_log.php';
require_once __DIR__ . '/user_features.php';
require_once __DIR__ . '/user_rules.php';
require_once __DIR__ . '/admin_rules.php';
?>
