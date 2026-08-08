<?php
/**
 * Document head and the opening of the page shell.
 *
 * Pages set $pageTitle before including this. Everything else — locale, theme,
 * asset versions — is resolved here so no page repeats it.
 */
$pageTitle = $pageTitle ?? '';
?>
<!DOCTYPE html>
<html <?= am2_html_attrs() ?> class="<?= am2_sidebar_collapsed() ? 'am2-rail' : '' ?>">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title><?= $pageTitle !== '' ? htmlspecialchars($pageTitle) . ' — ' : '' ?>AM²</title>
    <link rel="icon" href="<?= am2_asset('asset/image/logo.jpeg') ?>">
    <!--
        Says script is available, before anything paints.

        Sections that animate in have to start hidden, and the only safe place
        to decide that is CSS: the bundle is deferred, so hiding them from
        script meant the page painted, dropped to invisible, and faded back --
        the blink. Hiding them unconditionally is worse, because a browser that
        never runs the bundle then shows a blank page forever. This class is the
        condition, and it is set inline and synchronously so it is already true
        for the first paint.
    -->
    <script>document.documentElement.classList.add('am2-js');</script>
    <link rel="preload" as="font" type="font/woff2" href="asset/font/IBMPlexSans-Regular.woff2" crossorigin>
    <link rel="preload" as="font" type="font/woff2" href="asset/font/IBMPlexMono-Regular.woff2" crossorigin>
    <!-- Still loaded while pages migrate one at a time: the un-migrated ones
         depend on it, and it owns the tokens Tailwind reads. -->
    <link rel="stylesheet" href="<?= am2_asset('asset/css/am2-ui.css') ?>">
    <link rel="stylesheet" href="<?= am2_asset('asset/css/am2-tailwind.css') ?>">
    <?php /* Leaflet, vendored: livetrack.php pulled it from unpkg before. Its
             rules are all scoped to .leaflet-*, so it costs other pages nothing. */ ?>
    <link rel="stylesheet" href="<?= am2_asset('asset/vendor/leaflet/leaflet.css') ?>">
</head>
<body class="min-h-dvh bg-app font-sans text-ink antialiased">
