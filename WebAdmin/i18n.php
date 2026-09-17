<?php
/**
 * Language and theme, both resolved from cookies.
 *
 * Cookies rather than the session so they also apply to the login page, and so
 * a signed-out visitor keeps their choice.
 *
 * The theme is resolved server-side and written onto <html>. Doing it in
 * JavaScript would paint the light theme first and then repaint, which is
 * visible on every navigation.
 */

require_once __DIR__ . '/session_boot.php';
am2_refuse_direct_request(__FILE__);

const AM2_LOCALES = ['id', 'en'];
const AM2_DEFAULT_LOCALE = 'id';
const AM2_THEMES = ['light', 'dark'];

/** The active locale. ?lang= sets it, then the cookie carries it. */
function am2_locale(): string
{
    static $locale = null;
    if ($locale !== null) {
        return $locale;
    }

    $wanted = $_GET['lang'] ?? ($_COOKIE['am2_lang'] ?? AM2_DEFAULT_LOCALE);
    $locale = in_array($wanted, AM2_LOCALES, true) ? $wanted : AM2_DEFAULT_LOCALE;

    if (isset($_GET['lang']) && !headers_sent()) {
        setcookie('am2_lang', $locale, [
            'expires'  => time() + 31536000,
            'path'     => '/',
            'secure'   => true,
            'httponly' => false,   // the theme toggle reads it too
            'samesite' => 'Lax',
        ]);
    }
    return $locale;
}

function am2_theme(): string
{
    $wanted = $_COOKIE['am2_theme'] ?? 'light';
    return in_array($wanted, AM2_THEMES, true) ? $wanted : 'light';
}

function am2_html_attrs(): string
{
    return sprintf(
        'lang="%s" data-theme="%s"',
        htmlspecialchars(am2_locale(), ENT_QUOTES, 'UTF-8'),
        htmlspecialchars(am2_theme(), ENT_QUOTES, 'UTF-8')
    );
}

function am2_catalogue(): array
{
    static $catalogue = null;
    if ($catalogue !== null) {
        return $catalogue;
    }
    $base = require __DIR__ . '/lang/' . AM2_DEFAULT_LOCALE . '.php';
    $locale = am2_locale();
    if ($locale !== AM2_DEFAULT_LOCALE && is_file(__DIR__ . '/lang/' . $locale . '.php')) {
        $catalogue = array_merge($base, require __DIR__ . '/lang/' . $locale . '.php');
    } else {
        $catalogue = $base;
    }
    return $catalogue;
}

function t(string $key, array $replace = []): string
{
    $catalogue = am2_catalogue();
    $text = $catalogue[$key] ?? $key;

    $names = array_keys($replace);
    usort($names, static fn ($a, $b) => strlen((string) $b) <=> strlen((string) $a));
    foreach ($names as $k) {
        $text = str_replace(':' . $k, (string) $replace[$k], $text);
    }
    return $text;
}

function e(string $key, array $replace = []): string
{
    return htmlspecialchars(t($key, $replace), ENT_QUOTES, 'UTF-8');
}

/**
 * A versioned URL for a static asset.
 *
 * Without this, a deploy leaves every browser and every CDN edge holding the
 * previous stylesheet. Cloudflare sits in front of this panel, so a changed
 * class simply does not arrive until the cache expires — which looks exactly
 * like the CSS build being broken.
 */
function am2_asset(string $path): string
{

    if (!preg_match('#^/?asset/[A-Za-z0-9._/-]+$#', $path) || str_contains($path, '..')) {
        throw new InvalidArgumentException('Invalid asset path');
    }
    $full = __DIR__ . '/' . ltrim($path, '/');
    return htmlspecialchars($path . '?v=' . am2_asset_version($full), ENT_QUOTES, 'UTF-8');
}

/**
 * The version query for one asset file: its content digest.
 *
 * It was filemtime(). Runtime artifacts are packed with every mtime at the
 * epoch, so every asset on staging and production came out as ?v=0 and a
 * changed file kept the URL that browsers and Cloudflare held as immutable for
 * 30 days. A digest changes exactly when the bytes do. Memoised per request:
 * a page names the same few files, and hashing them once is enough.
 */
function am2_asset_version(string $full): string
{
    static $versions = [];
    if (!array_key_exists($full, $versions)) {
        $versions[$full] = is_file($full) ? substr(hash_file('sha256', $full), 0, 12) : '0';
    }
    return $versions[$full];
}

function am2_asset_url(string $path): string
{

    if (!preg_match('#^\.?/??asset/[A-Za-z0-9._/-]+$#', $path)
            || str_contains($path, '..')) {
        throw new InvalidArgumentException('Invalid asset path');
    }
    $full = __DIR__ . '/' . ltrim(preg_replace('#^\./#', '', $path), '/');
    return $path . '?v=' . am2_asset_version($full);
}

function am2_sidebar_collapsed(): bool
{
    return ($_COOKIE['am2_nav'] ?? 'wide') === 'rail';
}

/** Nav groups the operator has folded away, from a cookie. */
function am2_folded_groups(): array
{
    $raw = $_COOKIE['am2_folded'] ?? '';
    return $raw === '' ? [] : array_values(array_filter(explode(',', $raw)));
}

function am2_release_notes($notes, ?string $locale = null): string
{
    if (is_string($notes)) {

        $trimmed = trim($notes);
        if ($trimmed === '' || $trimmed[0] !== '{') {
            return $notes;
        }
        $decoded = json_decode($trimmed, true);
        if (!is_array($decoded)) {
            return $notes;
        }
        $notes = $decoded;
    }

    if (!is_array($notes)) {
        return '';
    }

    $wanted = $locale ?? am2_locale();
    foreach ([$wanted, AM2_DEFAULT_LOCALE] as $candidate) {
        if (isset($notes[$candidate]) && is_string($notes[$candidate]) && trim($notes[$candidate]) !== '') {
            return $notes[$candidate];
        }
    }

    foreach ($notes as $value) {
        if (is_string($value) && trim($value) !== '') {
            return $value;
        }
    }
    return '';
}
