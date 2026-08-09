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

$dsn = "pgsql:host={$host};port={$port};dbname={$dbname}";

try {
    $pdo = new PDO($dsn, $user, $password, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec("SET TIME ZONE 'Asia/Jakarta'");
} catch (PDOException $e) {
    error_log('AM2 DB connection failed: ' . $e->getMessage());
    http_response_code(500);
    die('Koneksi database gagal.');
}
?>
