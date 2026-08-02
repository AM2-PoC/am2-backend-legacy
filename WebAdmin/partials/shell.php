<?php
/**
 * The sidebar, the top bar, and the opening of <main>.
 *
 * Replaces the old sidebar.php for migrated pages. The two live side by side
 * until every page has moved.
 *
 * Pages set $pageTitle and optionally $pageLede before including this.
 */
$currentPage = basename($_SERVER['PHP_SELF']);
$displayName = $_SESSION['admin_username'] ?? 'Admin';
$roleName    = $_SESSION['admin_role'] ?? 'admin';
$isSuper     = $roleName === 'superadmin';

/** Nav, grouped the way the old sidebar grouped it. */
$navGroups = [
    'nav.home' => [
        ['dashboard.php', 'nav.dashboard', 'gauge'],
    ],
    'nav.management' => [
        ['users.php', 'nav.users', 'users'],
        ['channels.php', 'nav.channels', 'radio'],
        ['user_access.php', 'nav.channel_access', 'key'],
    ],
    'nav.monitoring' => [
        ['livetrack.php', 'nav.live_track', 'map'],
        ['logs.php', 'nav.activity_log', 'list'],
    ],
    'nav.system' => [
        ['settings.php', 'nav.settings', 'sliders'],
    ],
];
if ($isSuper) {
    $navGroups['nav.administrator'] = [['admin_panel.php', 'nav.admin_panel', 'shield']];
}

/** Inline SVG rather than an icon font: one fewer network dependency. */
function am2_icon(string $name): string
{
    $paths = [
        'gauge'   => '<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/><path d="M13.4 12.6 19 7"/><path d="M20.7 17A9 9 0 1 0 3.3 17"/>',
        'users'   => '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
        'radio'   => '<circle cx="12" cy="12" r="2"/><path d="M4.9 19.1a10 10 0 0 1 0-14.2"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M19.1 4.9a10 10 0 0 1 0 14.2"/>',
        'key'     => '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 8.8-8.8"/><path d="m17 6 2.5 2.5"/><path d="m14 9 2.5 2.5"/>',
        'map'     => '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z"/><path d="M9 3v15"/><path d="M15 6v15"/>',
        'list'    => '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
        'sliders' => '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/>',
        'shield'  => '<path d="M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1 1 0 0 1 1.5 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1Z"/>',
        'power'   => '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
        'menu'    => '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
        'close'   => '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    ];
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"'
        . ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="h-[18px] w-[18px] shrink-0">'
        . ($paths[$name] ?? '') . '</svg>';
}
?>

<!-- Off-canvas on a phone, fixed on desktop. -->
<div x-cloak x-show="nav" @click="nav = false"
     class="fixed inset-0 z-40 bg-slate-950/60 lg:hidden"></div>

<aside class="fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-edge bg-card
              transition-transform duration-200 lg:translate-x-0"
       :class="nav ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'"
       aria-label="<?= e('nav.main_navigation') ?>">

    <div class="flex items-center gap-3 border-b border-edge px-5 py-4">
        <img src="<?= am2_asset('asset/image/logo.jpeg') ?>" alt=""
             width="36" height="36" class="h-9 w-9 rounded-full bg-white object-contain p-0.5">
        <div class="min-w-0">
            <p class="text-base font-semibold leading-none">AM<sup class="text-[10px]">2</sup></p>
            <p class="mt-1 truncate font-mono text-[9px] uppercase tracking-[0.18em] text-ink-subtle">
                <?= e('login.subtitle') ?>
            </p>
        </div>
        <button type="button" @click="nav = false"
                class="ml-auto rounded-control p-2 text-ink-subtle hover:text-ink lg:hidden"
                aria-label="<?= e('nav.close_menu') ?>"><?= am2_icon('close') ?></button>
    </div>

    <!-- The one live fact this network runs on: who is transmitting right now.
         It was only ever visible on the tracking page; on a push-to-talk system
         it belongs everywhere. -->
    <div class="border-b border-edge px-5 py-4" x-data="txRail()" x-init="start()">
        <p class="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-ink-subtle">
            <span><?= e('rail.transmitting') ?></span>
            <span x-show="stale" x-cloak class="text-warn" title="<?= e('rail.stale') ?>">—</span>
        </p>
        <div class="mt-2.5 flex items-center gap-3">
            <span class="relative grid h-3 w-3 shrink-0 place-items-center" aria-hidden="true">
                <span x-show="count > 0" x-cloak
                      class="absolute h-3 w-3 animate-ping rounded-full bg-bad opacity-60"></span>
                <span class="relative h-3 w-3 rounded-full"
                      :class="count > 0 ? 'bg-bad' : 'bg-edge-strong'"></span>
            </span>
            <!-- Loud when it matters, quiet when it does not. A large dark zero
                 draws the eye to the least interesting state on the page. -->
            <span class="font-mono text-3xl font-semibold leading-none tabular-nums transition-colors"
                  :class="count > 0 ? 'text-bad' : 'text-ink-subtle/60'" x-text="count">0</span>
        </div>
        <p class="mt-2 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
            <span class="tabular-nums text-ink-muted" x-text="online">0</span>
            <?= e('rail.online') ?>
        </p>
    </div>

    <nav class="flex-1 overflow-y-auto px-3 py-4">
        <?php foreach ($navGroups as $groupKey => $items): ?>
            <p class="px-2 pb-2 pt-4 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-subtle first:pt-0">
                <?= e($groupKey) ?>
            </p>
            <?php foreach ($items as [$href, $labelKey, $icon]): $active = $currentPage === $href; ?>
                <a href="<?= $href ?>"
                   <?= $active ? 'aria-current="page"' : '' ?>
                   class="mb-0.5 flex items-center gap-3 rounded-control px-3 py-2 text-sm no-underline! transition-colors
                          <?= $active
                              ? 'bg-brand/10 font-medium text-ink! ring-1 ring-brand/30'
                              : 'text-ink-muted! hover:bg-card-muted hover:text-ink!' ?>">
                    <span class="<?= $active ? 'text-brand' : 'text-ink-subtle' ?>"><?= am2_icon($icon) ?></span>
                    <?= e($labelKey) ?>
                </a>
            <?php endforeach; ?>
        <?php endforeach; ?>
    </nav>

    <div class="border-t border-edge px-5 py-4">
        <div class="flex items-center gap-3">
            <span class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand/15
                         font-mono text-sm font-semibold text-brand">
                <?= strtoupper(htmlspecialchars(substr($displayName, 0, 1))) ?>
            </span>
            <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium"><?= htmlspecialchars($displayName) ?></p>
                <p class="font-mono text-[9px] uppercase tracking-[0.15em] <?= $isSuper ? 'text-bad' : 'text-ink-subtle' ?>">
                    <?= htmlspecialchars($roleName) ?>
                </p>
            </div>
            <a href="logout.php" onclick="return confirm(<?= htmlspecialchars(json_encode(t('nav.logout_confirm')), ENT_QUOTES) ?>)"
               class="rounded-control p-2 text-ink-subtle! no-underline! hover:bg-bad/10 hover:text-bad!"
               title="<?= e('nav.logout') ?>" aria-label="<?= e('nav.logout') ?>"><?= am2_icon('power') ?></a>
        </div>
    </div>
</aside>

<div class="lg:pl-72">
    <header class="sticky top-0 z-30 flex items-center gap-4 border-b border-edge bg-card/95 px-4 py-3 backdrop-blur lg:px-8">
        <button type="button" @click="nav = true"
                class="rounded-control p-2 text-ink-muted hover:bg-card-muted lg:hidden"
                aria-label="<?= e('nav.open_menu') ?>"><?= am2_icon('menu') ?></button>

        <div class="min-w-0 flex-1">
            <h1 class="truncate text-lg font-semibold tracking-tight"><?= htmlspecialchars($pageTitle ?? '') ?></h1>
            <?php if (!empty($pageLede)): ?>
                <p class="truncate text-xs text-ink-muted"><?= htmlspecialchars($pageLede) ?></p>
            <?php endif; ?>
        </div>

        <div class="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.15em]">
            <?php foreach (AM2_LOCALES as $loc): ?>
                <a href="?lang=<?= $loc ?>"
                   class="no-underline! <?= am2_locale() === $loc ? 'text-brand!' : 'text-ink-subtle! hover:text-ink!' ?>"
                   <?= am2_locale() === $loc ? 'aria-current="true"' : '' ?>><?= strtoupper($loc) ?></a>
            <?php endforeach; ?>
            <button type="button" id="themeToggle"
                    class="rounded-control border border-edge px-2 py-1 text-ink-subtle hover:text-ink"
                    aria-pressed="<?= am2_theme() === 'dark' ? 'true' : 'false' ?>"><?= e('pref.theme') ?></button>
        </div>
    </header>

    <main class="px-4 py-6 lg:px-8 lg:py-8">
