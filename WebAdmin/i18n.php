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
    foreach ($replace as $k => $v) {
        $text = str_replace(':' . $k, (string) $v, $text);
    }
    return $text;
}

/** Translate and escape, for use directly in markup. */
function e(string $key, array $replace = []): string
{
    return htmlspecialchars(t($key, $replace), ENT_QUOTES, 'UTF-8');
}

/** The strings the browser needs, for the inline scripts. */
function am2_js_catalogue(array $keys): string
{
    $out = [];
    foreach ($keys as $k) {
        $out[$k] = t($k);
    }
    return json_encode($out, JSON_UNESCAPED_UNICODE);
}
