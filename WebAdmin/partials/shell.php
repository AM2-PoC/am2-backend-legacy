<?php
/**
 * The application shell: sidebar, header, status strip, and the opening of
 * <main>.
 *
 * Composed from Preline's free sidebar, navbar and dropdown components, then
 * rethemed onto AM2's semantic tokens. Preline owns component state — which
 * overlay is open, where focus sits, whether the body scrolls. Nothing here
 * sets any of that.
 *
 * Pages set $pageTitle, optionally $pageLede, and optionally $pageActions
 * (raw markup for the contextual action slot in the header).
 *
 * Rail state still comes from a cookie so PHP renders the right width on the
 * first paint; reading it from storage would draw the wide sidebar and snap it
 * narrow on every navigation.
 */
require_once __DIR__ . '/state.php';

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

/** Which group holds the page being viewed, so it opens and the rest do not. */
$activeGroup = null;
foreach ($navGroups as $groupKey => $items) {
    foreach ($items as [$href]) {
        if ($href === $currentPage) {
            $activeGroup = $groupKey;
        }
    }
}

/**
 * Inline SVG rather than an icon font: one fewer network dependency, and one
 * family throughout — these are Lucide outlines at 1.75 stroke.
 */
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
        'inbox'    => '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1Z"/>',
        'alert'    => '<path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="10"/>',
        'clock'    => '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
        'lock'     => '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
        'sun'      => '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>',
        'moon'     => '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
        'search'   => '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
        'collapse' => '<path d="m14 8-4 4 4 4"/><path d="M4 4v16"/>',
        'chevron'  => '<path d="m6 9 6 6 6-6"/>',
        'expand'   => '<path d="m10 8 4 4-4 4"/><path d="M4 4v16"/>',
        'signal'   => '<path d="M2 20h.01"/><path d="M7 20v-4"/><path d="M12 20v-8"/><path d="M17 20V8"/><path d="M22 4v16"/>',
        'user'     => '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
        'globe'    => '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20Z"/>',
    ];
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"'
        . ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="shrink-0 ' . $extra . '">'
        . ($paths[$name] ?? '') . '</svg>';
}
?>

<!--
    Sidebar. Preline's free sidebar component:
    https://preline.co/docs/sidebar.html

    hs-overlay makes it an offcanvas below lg -- Preline supplies the backdrop,
    Escape, focus trap and body scroll lock. From lg up the same element is a
    fixed column, which is why the toggle button only exists on small screens.

    Preline's own example carries `transition-all duration-300`; that is
    replaced here with the properties actually being animated, on AM2's
    duration scale.
-->
<aside id="am2-sidebar" role="dialog" tabindex="-1" aria-label="<?= e('nav.menu') ?>"
       data-am2-drawer
       class="hs-overlay [--auto-close:lg] hs-overlay-open:translate-x-0
              -translate-x-full lg:translate-x-0 lg:block hidden
              fixed inset-y-0 start-0 z-60 flex w-[272px] flex-col
              border-e border-edge bg-card
              <?= $rail ? 'lg:w-[72px]' : 'lg:w-[272px]' ?>">

    <!-- Brand. In the rail only the mark survives; the wordmark is the first
         thing to go because the mark alone already identifies the product. -->
    <div class="flex h-16 shrink-0 items-center gap-3 border-b border-edge px-4">
        <img src="<?= am2_asset('asset/image/logo.jpeg') ?>" alt=""
             width="36" height="36"
             class="h-9 w-9 shrink-0 rounded-full bg-white object-contain p-0.5">
        <div class="am2-rail-hide min-w-0 flex-1 overflow-hidden">
            <p class="truncate text-sm font-semibold tracking-tight text-ink">AM²</p>
            <p class="truncate font-mono text-[9px] uppercase tracking-[0.18em] text-ink-subtle">
                <?= e('brand.tagline') ?>
            </p>
        </div>
        <button type="button" data-hs-overlay="#am2-sidebar"
                class="grid h-11 w-11 place-items-center rounded-control text-ink-subtle
                       hover:bg-card-muted hover:text-ink lg:hidden"
                aria-label="<?= e('nav.close_menu') ?>"><?= am2_icon('close') ?></button>
    </div>

    <!--
        Navigation. Preline accordion group, always-open so several sections can
        stay expanded at once; the section holding the current page is the one
        that starts open.
    -->
    <nav class="hs-accordion-group flex-1 overflow-y-auto overflow-x-hidden px-3 py-4"
         data-hs-accordion-always-open>
        <ul class="flex flex-col gap-1">
            <?php foreach ($navGroups as $groupKey => $items):
                $gid = 'nav-' . preg_replace('/[^a-z]/', '', $groupKey);
                $open = ($activeGroup === $groupKey) || !in_array($groupKey, am2_folded_groups(), true);
            ?>
            <li class="hs-accordion <?= $open ? 'active' : '' ?>" id="<?= $gid ?>"
                data-group="<?= htmlspecialchars($groupKey) ?>">
                <button type="button"
                        class="hs-accordion-toggle am2-rail-hide flex w-full items-center gap-2
                               rounded-control px-2 py-1.5 text-left font-mono text-[10px]
                               uppercase tracking-[0.18em] text-ink-subtle
                               transition-colors duration-[var(--duration-micro)]
                               hover:text-ink focus:outline-none focus-visible:ring-2
                               focus-visible:ring-brand/60"
                        aria-expanded="<?= $open ? 'true' : 'false' ?>"
                        aria-controls="<?= $gid ?>-content">
                    <span class="flex-1"><?= e($groupKey) ?></span>
                    <span class="hs-accordion-active:rotate-180 transition-transform
                                 duration-[var(--duration-micro)] ease-standard">
                        <?= am2_icon('chevron', 'h-3.5 w-3.5') ?>
                    </span>
                </button>

                <div id="<?= $gid ?>-content" role="region" aria-labelledby="<?= $gid ?>"
                     class="hs-accordion-content w-full overflow-hidden
                            transition-[height] duration-[var(--duration-drawer)] ease-enter
                            <?= $open ? '' : 'hidden' ?>">
                    <ul class="mt-1 flex flex-col gap-0.5">
                        <?php foreach ($items as [$href, $labelKey, $icon, $depth]):
                            $on = $currentPage === $href; ?>
                            <li>
                                <!--
                                    Active state carries four signals, not one:
                                    the indicator bar, the background, the icon
                                    colour and the label weight. Colour alone
                                    fails for anyone who cannot separate these
                                    two hues.
                                -->
                                <a href="<?= $href ?>" <?= $on ? 'aria-current="page"' : '' ?>
                                   class="am2-nav-item group relative flex h-11 items-center gap-3
                                          rounded-control px-2 no-underline!
                                          transition-colors duration-[var(--duration-micro)]
                                          <?= $depth > 0 ? 'am2-nav-child' : '' ?>
                                          <?= $on
                                              ? 'bg-brand/10 font-semibold text-brand!'
                                              : 'text-ink-muted! hover:bg-card-muted hover:text-ink!' ?>">
                                    <?php if ($on): ?>
                                        <span aria-hidden="true"
                                              class="am2-nav-indicator absolute inset-y-2 start-0 w-[3px]
                                                     rounded-full bg-brand"></span>
                                    <?php endif; ?>
                                    <span class="grid w-7 shrink-0 place-items-center
                                                 <?= $on ? 'text-brand' : 'text-ink-subtle group-hover:text-ink' ?>">
                                        <?= am2_icon($icon) ?>
                                    </span>
                                    <span class="am2-rail-hide truncate text-sm"><?= e($labelKey) ?></span>
                                </a>
                            </li>
                        <?php endforeach; ?>
                    </ul>
                </div>
            </li>
            <?php endforeach; ?>
        </ul>
    </nav>

    <!--
        Account. Preline dropdown, opening upward out of the sidebar foot:
        https://preline.co/docs/dropdown.html
        Everything that is about the operator rather than the network lives
        here — theme, language, sign out — so the header can stay about the page.
    -->
</aside>

<!--
    Content column. Preline navbar composition:
    https://preline.co/docs/navbar.html
-->
<div id="am2-content"
     class="transition-[padding] duration-[var(--duration-drawer)] ease-enter
            <?= $rail ? 'lg:ps-[72px]' : 'lg:ps-[272px]' ?>">

    <header class="sticky top-0 z-40 border-b border-edge bg-card/90 backdrop-blur-md">
        <div class="flex h-16 items-center gap-3 px-4 lg:px-6">
            <!--
                One control in one place: left of the page title, at every
                width, with the same icon. Below lg it opens the drawer through
                Preline's own trigger; from lg up it collapses the rail. Two
                elements because the drawer must be opened by Preline rather
                than from script.
            -->
            <button type="button" data-hs-overlay="#am2-sidebar"
                    class="grid h-11 w-11 shrink-0 place-items-center rounded-control text-ink-muted
                           transition-colors duration-[var(--duration-micro)]
                           hover:bg-card-muted hover:text-ink lg:hidden"
                    aria-haspopup="dialog" aria-expanded="false" aria-controls="am2-sidebar"
                    aria-label="<?= e('nav.open_menu') ?>"><?= am2_icon('collapse', 'h-[18px] w-[18px]') ?></button>

            <button type="button" id="am2-rail-toggle"
                    class="hidden h-11 w-11 shrink-0 place-items-center rounded-control text-ink-muted
                           transition-colors duration-[var(--duration-micro)]
                           hover:bg-card-muted hover:text-ink lg:grid"
                    aria-controls="am2-sidebar" aria-expanded="<?= $rail ? 'false' : 'true' ?>"
                    aria-label="<?= e('nav.collapse') ?>" title="<?= e('nav.collapse') ?>">
                <span id="am2-rail-icon"><?= am2_icon($rail ? 'expand' : 'collapse') ?></span>
            </button>

            <div class="min-w-0 flex-1">
                <h1 class="truncate text-base font-semibold tracking-tight text-ink">
                    <?= htmlspecialchars($pageTitle ?? '') ?>
                </h1>
                <?php if (!empty($pageLede)): ?>
                    <p class="hidden truncate text-xs text-ink-muted sm:block">
                        <?= htmlspecialchars($pageLede) ?>
                    </p>
                <?php endif; ?>
            </div>

            <!-- Contextual action slot: the page's primary verb, next to its title. -->
            <?php if (!empty($pageActions)): ?>
                <div class="flex shrink-0 items-center gap-2"><?= $pageActions ?></div>
            <?php endif; ?>

            <button type="button" data-hs-overlay="#am2-palette"
                    class="hidden h-11 items-center gap-2 rounded-control border border-edge
                           bg-card-muted px-3 text-sm text-ink-subtle
                           transition-colors duration-[var(--duration-micro)]
                           hover:border-edge-strong hover:text-ink md:flex md:w-56 lg:w-64"
                    aria-haspopup="dialog" aria-expanded="false" aria-controls="am2-palette">
                <?= am2_icon('search', 'h-4 w-4') ?>
                <span class="flex-1 text-left"><?= e('search.placeholder') ?></span>
                <kbd class="rounded border border-edge px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
            </button>
            <button type="button" data-hs-overlay="#am2-palette"
                    class="grid h-11 w-11 place-items-center rounded-control border border-edge
                           text-ink-subtle md:hidden"
                    aria-haspopup="dialog" aria-expanded="false" aria-controls="am2-palette"
                    aria-label="<?= e('search.placeholder') ?>"><?= am2_icon('search', 'h-4 w-4') ?></button>

            <!--
                Language and theme sit in the bar, not behind a menu. They are
                switched often enough that a click to reveal them is a click
                too many, and hiding a theme control behind an account menu
                makes it look like an account setting.
            -->
            <div class="hidden items-center gap-1.5 sm:flex" role="group"
                 aria-label="<?= e('pref.language') ?>">
                <?php foreach (AM2_LOCALES as $loc): $onLoc = am2_locale() === $loc; ?>
                    <a href="?lang=<?= $loc ?>" <?= $onLoc ? 'aria-current="true"' : '' ?>
                       class="grid h-11 w-11 place-items-center rounded-control border no-underline!
                              font-mono text-[11px] uppercase transition-colors
                              duration-[var(--duration-micro)]
                              <?= $onLoc
                                  ? 'border-brand bg-brand/10 text-brand!'
                                  : 'border-edge text-ink-subtle! hover:border-edge-strong hover:text-ink!' ?>">
                        <?= strtoupper($loc) ?>
                    </a>
                <?php endforeach; ?>
            </div>

            <button type="button" id="themeToggle"
                    class="grid h-11 w-11 place-items-center rounded-control border border-edge
                           text-ink-subtle transition-colors duration-[var(--duration-micro)]
                           hover:border-edge-strong hover:text-ink"
                    aria-pressed="<?= am2_theme() === 'dark' ? 'true' : 'false' ?>"
                    aria-label="<?= e('pref.theme') ?>" title="<?= e('pref.theme') ?>">
                <span data-theme-icon="light" class="<?= am2_theme() === 'dark' ? 'hidden' : '' ?>"><?= am2_icon('moon', 'h-4 w-4') ?></span>
                <span data-theme-icon="dark" class="<?= am2_theme() === 'dark' ? '' : 'hidden' ?>"><?= am2_icon('sun', 'h-4 w-4') ?></span>
            </button>

            <!-- Who is signed in, and the way out. Preline dropdown. -->
            <div class="hs-dropdown relative [--placement:bottom-right]">
                <button id="am2-account" type="button"
                        class="hs-dropdown-toggle flex h-11 items-center gap-2 rounded-control
                               border border-edge px-1.5 transition-colors
                               duration-[var(--duration-micro)] hover:border-edge-strong"
                        aria-haspopup="menu" aria-expanded="false"
                        aria-label="<?= e('nav.account') ?>">
                    <span class="grid h-8 w-8 shrink-0 place-items-center rounded-full
                                 bg-card-muted font-mono text-[11px] uppercase text-brand">
                        <?= htmlspecialchars(mb_substr($displayName, 0, 2)) ?>
                    </span>
                    <span class="hidden min-w-0 pe-1 text-left lg:block">
                        <span class="block truncate text-xs text-ink"><?= htmlspecialchars($displayName) ?></span>
                        <span class="block truncate font-mono text-[9px] uppercase tracking-[0.15em] text-ink-subtle">
                            <?= htmlspecialchars($roleName) ?>
                        </span>
                    </span>
                    <span class="text-ink-subtle"><?= am2_icon('chevron', 'h-3.5 w-3.5') ?></span>
                </button>

                <div class="hs-dropdown-menu hs-dropdown-open:opacity-100 z-70 hidden w-52 opacity-0
                            rounded-panel border border-edge bg-card p-1.5 shadow-pop
                            transition-opacity duration-[var(--duration-pop)]"
                     role="menu" aria-orientation="vertical" aria-labelledby="am2-account">
                    <!-- Language repeats here for narrow screens, where the bar
                         has no room for it. -->
                    <div class="flex gap-1 px-1 pb-1.5 sm:hidden">
                        <?php foreach (AM2_LOCALES as $loc): $onLoc = am2_locale() === $loc; ?>
                            <a href="?lang=<?= $loc ?>" role="menuitem"
                               class="flex h-11 flex-1 items-center justify-center rounded-control border
                                      no-underline! font-mono text-[11px] uppercase
                                      <?= $onLoc ? 'border-brand bg-brand/10 text-brand!'
                                                 : 'border-edge text-ink-subtle!' ?>"><?= strtoupper($loc) ?></a>
                        <?php endforeach; ?>
                    </div>
                    <a href="settings.php" role="menuitem"
                       class="flex h-11 w-full items-center gap-3 rounded-control px-2.5 text-sm
                              no-underline! text-ink-muted! transition-colors
                              duration-[var(--duration-micro)] hover:bg-card-muted hover:text-ink!">
                        <?= am2_icon('sliders', 'h-4 w-4') ?><span><?= e('nav.settings') ?></span>
                    </a>
                    <div class="my-1 h-px bg-edge"></div>
                    <a href="logout.php" role="menuitem"
                       class="flex h-11 w-full items-center gap-3 rounded-control px-2.5 text-sm
                              no-underline! text-bad! transition-colors duration-[var(--duration-micro)]
                              hover:bg-bad/10">
                        <?= am2_icon('power', 'h-4 w-4') ?><span><?= e('nav.logout') ?></span>
                    </a>
                </div>
            </div>
        </div>

        <!--
            Operational status. Full width and on every page, because an
            operator should not have to navigate to the dashboard to find out
            whether the relay is up. aria-live is polite: it reports when the
            numbers change without interrupting whatever is being read.
        -->
        <div id="am2-status" aria-live="polite"
             class="flex items-center gap-4 overflow-x-auto border-t border-edge
                    bg-card-muted/60 px-4 py-2 font-mono text-[10px] uppercase
                    tracking-[0.15em] lg:px-6">
            <span class="flex shrink-0 items-center gap-1.5">
                <span id="am2-relay-dot" class="h-1.5 w-1.5 rounded-full bg-ink-subtle"></span>
                <span id="am2-relay-text" class="text-ink-subtle"><?= e('status.checking') ?></span>
            </span>
            <span class="flex shrink-0 items-center gap-1.5 text-ink-subtle">
                <span id="am2-online" class="text-ink">–</span><?= e('rail.online') ?>
            </span>
            <span class="flex shrink-0 items-center gap-1.5 text-ink-subtle">
                <span id="am2-tx-dot" class="hidden h-1.5 w-1.5 rounded-full bg-bad"></span>
                <span id="am2-tx" class="text-ink">0</span><?= e('status.transmitting') ?>
            </span>
            <span id="am2-stale" class="hidden shrink-0 text-warn"><?= e('rail.stale') ?></span>
        </div>
    </header>

    <main class="mx-auto w-full max-w-[1600px] px-4 py-6 lg:px-6 lg:py-8">
