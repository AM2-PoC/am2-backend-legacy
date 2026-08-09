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

/** Attributes for the <html> element. */
function am2_html_attrs(): string
{
    return sprintf(
        'lang="%s" data-theme="%s"',
        htmlspecialchars(am2_locale(), ENT_QUOTES, 'UTF-8'),
        htmlspecialchars(am2_theme(), ENT_QUOTES, 'UTF-8')
    );
}

/** The catalogue for the active locale, with the default as a fallback. */
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

/**
 * Translate. Returns the key itself when it is missing, which makes a gap
 * obvious on the page instead of rendering an empty element.
 */
function t(string $key, array $replace = []): string
{
    $catalogue = am2_catalogue();
    $text = $catalogue[$key] ?? $key;

    // Longest name first. ':to' is a prefix of ':total', so replacing in the
    // caller's order turned "dari :total" into "dari 20tal" on the roster
    // footer -- a bug that only appears when one placeholder starts another.
    $names = array_keys($replace);
    usort($names, static fn ($a, $b) => strlen((string) $b) <=> strlen((string) $a));
    foreach ($names as $k) {
        $text = str_replace(':' . $k, (string) $replace[$k], $text);
    }
    return $text;
}

/** Translate and escape, for use directly in markup. */
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
    $full = __DIR__ . '/' . ltrim($path, '/');
    $version = is_file($full) ? filemtime($full) : 0;
    return htmlspecialchars($path . '?v=' . $version, ENT_QUOTES, 'UTF-8');
}

/** Asset URL for JSON/JavaScript contexts; encoding belongs to the caller. */
function am2_asset_url(string $path): string
{
    // Leading ./ is meaningful to a browser module import, but not on disk.
    // Reject everything except this application's relative asset paths.
    if (!preg_match('#^\.?/??asset/[A-Za-z0-9._/-]+$#', $path)
            || str_contains($path, '..')) {
        throw new InvalidArgumentException('Invalid asset path');
    }
    $full = __DIR__ . '/' . ltrim(preg_replace('#^\./#', '', $path), '/');
    $version = is_file($full) ? filemtime($full) : 0;
    return $path . '?v=' . $version;
}

/** Whether the sidebar is collapsed to an icon rail. */
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
