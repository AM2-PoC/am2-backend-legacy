<?php
/**
 * The sidebar, the top bar, and the opening of <main>.
 *
 * Replaces the old sidebar.php for migrated pages; the two live side by side
 * until every page has moved.
 *
 * Pages set $pageTitle and optionally $pageLede before including this.
 *
 * The collapsed state comes from a cookie so PHP can render the right width on
 * the first paint. Reading it from localStorage would draw the wide rail and
 * then snap it narrow on every navigation.
 */
$currentPage = basename($_SERVER['PHP_SELF']);
$displayName = $_SESSION['admin_username'] ?? 'Admin';
$roleName    = $_SESSION['admin_role'] ?? 'admin';
$isSuper     = $roleName === 'superadmin';
$rail        = am2_sidebar_collapsed();

$navGroups = [
    'nav.home' => [
        ['dashboard.php', 'nav.dashboard', 'gauge', 0],
    ],
    // Channel access is the same subject as users seen from another angle, so
    // it sits under it. A fourth item is a child when it is indented.
    'nav.management' => [
        ['users.php', 'nav.users', 'users', 0],
        ['user_access.php', 'nav.channel_access', 'key', 1],
        ['channels.php', 'nav.channels', 'radio', 0],
    ],
    'nav.monitoring' => [
        ['livetrack.php', 'nav.live_track', 'map', 0],
        ['logs.php', 'nav.activity_log', 'list', 0],
    ],
    'nav.system' => [
        ['settings.php', 'nav.settings', 'sliders', 0],
    ],
];
if ($isSuper) {
    $navGroups['nav.administrator'] = [['admin_panel.php', 'nav.admin_panel', 'shield', 0]];
}

/** Inline SVG rather than an icon font: one fewer network dependency. */
function am2_icon(string $name, string $extra = 'h-[18px] w-[18px]'): string
{
    $paths = [
        'gauge'    => '<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/><path d="M13.4 12.6 19 7"/><path d="M20.7 17A9 9 0 1 0 3.3 17"/>',
        'users'    => '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
        'radio'    => '<circle cx="12" cy="12" r="2"/><path d="M4.9 19.1a10 10 0 0 1 0-14.2"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M19.1 4.9a10 10 0 0 1 0 14.2"/>',
        'key'      => '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 8.8-8.8"/><path d="m17 6 2.5 2.5"/><path d="m14 9 2.5 2.5"/>',
        'map'      => '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z"/><path d="M9 3v15"/><path d="M15 6v15"/>',
        'list'     => '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
        'sliders'  => '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/>',
        'shield'   => '<path d="M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1 1 0 0 1 1.5 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1Z"/>',
        'power'    => '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
        'menu'     => '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
        'close'    => '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
        'sun'      => '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>',
        'moon'     => '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
        'search'   => '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
        'collapse' => '<path d="m14 8-4 4 4 4"/><path d="M4 4v16"/>',
        'chevron'  => '<path d="m6 9 6 6 6-6"/>',
        'expand'   => '<path d="m10 8 4 4-4 4"/><path d="M4 4v16"/>',
    ];
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"'
        . ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="shrink-0 ' . $extra . '">'
        . ($paths[$name] ?? '') . '</svg>';
}
?>

<div x-cloak x-show="nav" @click="nav = false"
     class="fixed inset-0 z-40 bg-slate-950/50 backdrop-blur-sm lg:hidden"></div>

<!--
    256px expanded, 64px as an icon rail — the widths every comparable console
    settled on. Collapsed items keep a title and an aria-label, because an icon
    alone tells a sighted power user what it is and tells a screen reader
    nothing.
-->
<aside x-data="{ get rail() { return $store.nav.collapsed; } }"
       :class="{ 'lg:w-16': rail, 'lg:w-64': !rail,
                 'translate-x-0': nav, '-translate-x-full': !nav, 'lg:translate-x-0': true }"
       class="w-64 <?= $rail ? 'lg:w-16' : 'lg:w-64' ?> -translate-x-full lg:translate-x-0
              fixed inset-y-0 left-0 z-50 flex flex-col border-r border-edge bg-card
              transition-[width,transform] duration-200 ease-out">

    <div class="flex h-16 items-center gap-3 border-b border-edge px-3">
        <img src="<?= am2_asset('asset/image/logo.jpeg') ?>" alt=""
             width="36" height="36" class="h-9 w-9 shrink-0 rounded-full bg-white object-contain p-0.5">
        <div class="min-w-0 flex-1 overflow-hidden" x-show="!rail" x-cloak>
            <p class="whitespace-nowrap text-base font-semibold leading-none">AM<sup class="text-[10px]">2</sup></p>
            <p class="mt-1 truncate font-mono text-[9px] uppercase tracking-[0.18em] text-ink-subtle">
                <?= e('login.subtitle') ?>
            </p>
        </div>
        <button type="button" @click="nav = false"
                class="rounded-control p-2 text-ink-subtle hover:text-ink lg:hidden"
                aria-label="<?= e('nav.close_menu') ?>"><?= am2_icon('close') ?></button>
    </div>

    <!-- The one live fact a push-to-talk network runs on. Collapsed, it keeps
         the number: it is the reason the rail is worth glancing at. -->
    <div class="border-b border-edge px-3 py-3" x-data="txRail()" x-init="start()"
         :title="rail ? <?= js('rail.transmitting') ?> : null">
        <p x-show="!rail" x-cloak
           class="flex items-center justify-between whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.2em] text-ink-subtle">
            <span><?= e('rail.transmitting') ?></span>
            <span x-show="stale" class="text-warn" title="<?= e('rail.stale') ?>">—</span>
        </p>
        <div class="mt-1 flex items-center gap-2.5" :class="rail && 'justify-center'">
            <span class="relative grid h-2.5 w-2.5 shrink-0 place-items-center" aria-hidden="true">
                <span x-show="count > 0" x-cloak
                      class="absolute h-2.5 w-2.5 animate-ping rounded-full bg-bad opacity-70"></span>
                <span class="relative h-2.5 w-2.5 rounded-full"
                      :class="count > 0 ? 'bg-bad' : 'bg-edge-strong'"></span>
            </span>
            <span class="font-mono text-xl font-semibold leading-none tabular-nums transition-colors"
                  :class="count > 0 ? 'text-bad' : 'text-ink-subtle/70'" x-text="count">0</span>
            <span x-show="!rail" x-cloak
                  class="ml-auto whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.15em] text-ink-subtle">
                <span class="tabular-nums text-ink-muted" x-text="online">0</span> <?= e('rail.online') ?>
            </span>
        </div>
    </div>

    <nav class="flex-1 overflow-y-auto overflow-x-hidden px-2 py-3">
        <?php foreach ($navGroups as $groupKey => $items): ?>
            <button type="button" x-show="!rail" x-cloak
                    @click="$store.nav.fold(<?= js($groupKey) ?>)"
                    :aria-expanded="$store.nav.isFolded(<?= js($groupKey) ?>) ? 'false' : 'true'"
                    class="flex w-full items-center gap-1.5 whitespace-nowrap rounded-control px-3 pb-1.5 pt-4
                           font-mono text-[9px] uppercase tracking-[0.2em] text-ink-subtle
                           hover:text-ink-muted">
                <span class="transition-transform"
                      :class="$store.nav.isFolded(<?= js($groupKey) ?>) && '-rotate-90'"><?= am2_icon('chevron', 'h-3 w-3') ?></span>
                <?= e($groupKey) ?>
            </button>
            <div x-show="rail" x-cloak class="mx-2 my-2 h-px bg-edge first:hidden" aria-hidden="true"></div>
            <?php foreach ($items as [$href, $labelKey, $icon, $depth]): $active = $currentPage === $href; ?>
                <a href="<?= $href ?>"
                   <?= $active ? 'aria-current="page"' : '' ?>
                   :title="rail ? <?= js($labelKey) ?> : null"
                   aria-label="<?= e($labelKey) ?>"
                   x-show="rail || !$store.nav.isFolded(<?= js($groupKey) ?>)"
                   :class="rail && 'justify-center'"
                   class="group relative mb-0.5 flex items-center gap-3 rounded-control py-2 text-sm no-underline! transition-colors
                          <?= $depth ? 'pl-9 pr-3' : 'px-3' ?>
                          <?= $active
                              ? 'bg-brand/10 font-medium text-ink!'
                              : 'text-ink-muted! hover:bg-card-muted hover:text-ink!' ?>">
                    <?php if ($active): ?>
                        <span class="absolute inset-y-1.5 left-0 w-0.5 rounded-r-full bg-brand" aria-hidden="true"></span>
                    <?php endif; ?>
                    <span class="<?= $active ? 'text-brand' : 'text-ink-subtle group-hover:text-ink-muted' ?>"><?= am2_icon($icon) ?></span>
                    <span x-show="!rail" x-cloak class="whitespace-nowrap"><?= e($labelKey) ?></span>
                </a>
            <?php endforeach; ?>
        <?php endforeach; ?>
    </nav>

    <div class="border-t border-edge p-3">
        <div class="flex items-center gap-3" :class="rail && 'justify-center'">
            <span class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand/15
                         font-mono text-sm font-semibold text-brand"
                  :title="rail ? <?= js('nav.logout') ?> : null">
                <?= strtoupper(htmlspecialchars(substr($displayName, 0, 1))) ?>
            </span>
            <div class="min-w-0 flex-1 overflow-hidden" x-show="!rail" x-cloak>
                <p class="truncate text-sm font-medium"><?= htmlspecialchars($displayName) ?></p>
                <p class="whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.15em] <?= $isSuper ? 'text-bad' : 'text-ink-subtle' ?>">
                    <?= htmlspecialchars($roleName) ?>
                </p>
            </div>
            <a href="logout.php" x-show="!rail" x-cloak
               onclick="return confirm(<?= htmlspecialchars(json_encode(t('nav.logout_confirm')), ENT_QUOTES) ?>)"
               class="rounded-control p-2 text-ink-subtle! no-underline! hover:bg-bad/10 hover:text-bad!"
               title="<?= e('nav.logout') ?>" aria-label="<?= e('nav.logout') ?>"><?= am2_icon('power') ?></a>
        </div>

        <button type="button" @click="$store.nav.toggle()" x-cloak
                :title="rail ? <?= js('nav.expand') ?> : <?= js('nav.collapse') ?>"
                :aria-label="rail ? <?= js('nav.expand') ?> : <?= js('nav.collapse') ?>"
                :aria-expanded="rail ? 'false' : 'true'"
                :class="rail && 'justify-center'"
                class="mt-3 hidden w-full items-center gap-3 rounded-control px-3 py-2
                       text-ink-subtle transition-colors hover:bg-card-muted hover:text-ink lg:flex">
            <span x-show="!rail"><?= am2_icon('collapse') ?></span>
            <span x-show="rail"><?= am2_icon('expand') ?></span>
            <span x-show="!rail" class="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.15em]">
                <?= e('nav.collapse') ?>
            </span>
        </button>
    </div>
</aside>

<div x-data="{ get rail() { return $store.nav.collapsed; } }"
     :class="{ 'lg:pl-16': rail, 'lg:pl-64': !rail }"
     class="<?= $rail ? 'lg:pl-16' : 'lg:pl-64' ?> transition-[padding] duration-200 ease-out">
    <header class="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-edge bg-card/85 px-4 backdrop-blur-md lg:px-6">
        <button type="button" @click="nav = true"
                class="rounded-control p-2 text-ink-muted hover:bg-card-muted lg:hidden"
                aria-label="<?= e('nav.open_menu') ?>"><?= am2_icon('menu') ?></button>

        <div class="min-w-0 flex-1">
            <h1 class="truncate text-base font-semibold tracking-tight"><?= htmlspecialchars($pageTitle ?? '') ?></h1>
            <?php if (!empty($pageLede)): ?>
                <p class="hidden truncate text-xs text-ink-muted sm:block"><?= htmlspecialchars($pageLede) ?></p>
            <?php endif; ?>
        </div>

        <button type="button" @click="$dispatch('open-palette')"
                class="hidden items-center gap-2 rounded-control border border-edge bg-card-muted
                       px-3 py-2 text-sm text-ink-subtle transition-colors
                       hover:border-edge-strong hover:text-ink md:flex md:w-56 lg:w-64">
            <?= am2_icon('search', 'h-4 w-4') ?>
            <span class="flex-1 text-left"><?= e('search.placeholder') ?></span>
            <kbd class="rounded border border-edge px-1.5 py-0.5 font-mono text-[10px] text-ink-subtle">⌘K</kbd>
        </button>
        <button type="button" @click="$dispatch('open-palette')"
                class="rounded-control border border-edge p-2 text-ink-subtle md:hidden"
                aria-label="<?= e('search.placeholder') ?>"><?= am2_icon('search', 'h-4 w-4') ?></button>

        <div class="flex items-center gap-1.5">
            <?php foreach (AM2_LOCALES as $loc): $on = am2_locale() === $loc; ?>
                <a href="?lang=<?= $loc ?>"
                   <?= $on ? 'aria-current="true"' : '' ?> title="<?= e('pref.language') ?>"
                   class="grid h-9 w-9 place-items-center rounded-control border no-underline!
                          font-mono text-[11px] uppercase transition-colors
                          <?= $on
                              ? 'border-brand bg-brand/10 text-brand!'
                              : 'border-edge text-ink-subtle! hover:border-edge-strong hover:text-ink!' ?>"><?= strtoupper($loc) ?></a>
            <?php endforeach; ?>
            <button type="button" id="themeToggle"
                    class="grid h-9 w-9 place-items-center rounded-control border border-edge
                           text-ink-subtle transition-colors hover:border-edge-strong hover:text-ink"
                    aria-pressed="<?= am2_theme() === 'dark' ? 'true' : 'false' ?>"
                    aria-label="<?= e('pref.theme') ?>" title="<?= e('pref.theme') ?>">
                <span data-theme-icon="light" class="<?= am2_theme() === 'dark' ? 'hidden' : '' ?>"><?= am2_icon('moon', 'h-4 w-4') ?></span>
                <span data-theme-icon="dark" class="<?= am2_theme() === 'dark' ? '' : 'hidden' ?>"><?= am2_icon('sun', 'h-4 w-4') ?></span>
            </button>
        </div>
    </header>

    <main class="px-4 py-6 lg:px-6 lg:py-8">
