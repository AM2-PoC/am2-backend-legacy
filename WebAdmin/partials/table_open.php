<?php
/**
 * The frame the roster tables share: toolbar, filter chips, density, the
 * scroll container the sticky header needs, and the head row.
 *
 * A page sets $columns, $chips, $total, $allIds and $tableId, emits its own
 * <tbody>, then includes partials/table_close.php. It writes no JavaScript:
 * selection, keyboard, toggles and bulk all live in am2-table.js, driven by
 * the data attributes below.
 *
 * Filter, sort and page live in the query string, so a view can be sent to
 * someone else and the back button behaves.
 */

$tableId    = $tableId ?? 'am2-table';
$columns    = $columns ?? [];
$chips      = $chips ?? [];
$total      = (int) ($total ?? 0);
$allIds     = $allIds ?? [];
$selectable = $selectable ?? true;

if (!function_exists('am2_table_qs')) {
    /** The current view with some parameters replaced. Page resets on any change. */
    function am2_table_qs(array $over = []): string
    {
        $keep = ['search', 'chip', 'sort', 'dir', 'p'];
        $q = [];
        foreach ($keep as $k) {
            if (isset($_GET[$k]) && $_GET[$k] !== '') {
                $q[$k] = (string) $_GET[$k];
            }
        }
        foreach ($over as $k => $v) {
            if ($v === null || $v === '') unset($q[$k]);
            else $q[$k] = (string) $v;
        }
        if (!isset($over['p'])) unset($q['p']);
        return $q ? '?' . http_build_query($q) : '?';
    }
}

$curSort = (string) ($_GET['sort'] ?? '');
$curDir  = ($_GET['dir'] ?? 'desc') === 'asc' ? 'asc' : 'desc';
$curChip = (string) ($_GET['chip'] ?? '');
?>

<section id="<?= htmlspecialchars($tableId) ?>" data-am2-table
         data-total="<?= $total ?>"
         data-all-ids="<?= htmlspecialchars(implode(' ', $allIds)) ?>"
         class="am2-surface flex flex-col rounded-card">

    <header class="flex flex-col gap-3 border-b border-edge p-4 lg:flex-row lg:items-center lg:gap-4 lg:px-5">

        <!-- Search keeps ?search=, the parameter the command palette sends. -->
        <form method="GET" class="relative min-w-0 flex-1">
            <?php foreach (['chip', 'sort', 'dir'] as $carry): ?>
                <?php if (!empty($_GET[$carry])): ?>
                    <input type="hidden" name="<?= $carry ?>"
                           value="<?= htmlspecialchars((string) $_GET[$carry]) ?>">
                <?php endif; ?>
            <?php endforeach; ?>
            <span class="pointer-events-none absolute inset-y-0 start-0 grid w-10 place-items-center
                         text-ink-subtle"><?= am2_icon('search', 'h-4 w-4') ?></span>
            <!-- A placeholder is not a label. It leaves as soon as there is
                 anything to read, so a screen reader reaching a half-typed
                 search finds a text box called nothing at all. -->
            <input name="search" type="search" data-table-search
                   value="<?= htmlspecialchars((string) ($_GET['search'] ?? '')) ?>"
                   aria-label="<?= e($searchPlaceholder ?? 'search.placeholder') ?>"
                   placeholder="<?= e($searchPlaceholder ?? 'search.placeholder') ?>"
                   class="h-11 w-full rounded-control border border-edge bg-card ps-10 pe-3 text-sm
                          text-ink transition-colors duration-[var(--duration-micro)]
                          hover:border-edge-strong focus:border-brand focus:outline-none
                          focus:ring-2 focus:ring-brand/25">
        </form>

        <?php if ($chips): ?>
            <!-- Not decoration: "tanpa channel" is a unit that cannot talk to
                 anyone, and nothing in this panel said so before. -->
            <div class="flex flex-wrap items-center gap-1.5">
                <?php foreach ($chips as $chip):
                    $on = $curChip === $chip['value']; ?>
                    <a href="<?= htmlspecialchars(am2_table_qs(['chip' => $chip['value'] ?: null])) ?>"
                       class="inline-flex h-11 items-center gap-1.5 rounded-control border px-3 font-mono
                              text-[11px] uppercase tracking-[0.15em] no-underline! transition-colors
                              duration-[var(--duration-micro)]
                              <?= $on ? 'border-brand bg-brand/10 text-brand!'
                                      : 'border-edge text-ink-muted! hover:border-brand hover:text-brand!' ?>">
                        <?php if (!empty($chip['dot'])): ?>
                            <span class="h-1.5 w-1.5 rounded-full <?= $chip['dot'] ?>" aria-hidden="true"></span>
                        <?php endif; ?>
                        <?= e($chip['key']) ?>
                    </a>
                <?php endforeach; ?>
            </div>
        <?php endif; ?>

        <div class="flex shrink-0 items-center gap-3">
            <!-- The page's own verb, in the toolbar with the thing it acts on.
                 It was in the shell's header, which is where the app's
                 navigation lives, not a page's controls. -->
            <?php if (!empty($tableAction)): ?>
                <?= $tableAction ?>
            <?php endif; ?>

            <span class="whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle">
                <?= e($countKey ?? 'tbl.rows', ['n' => number_format($total)]) ?>
            </span>
        </div>
    </header>

    <!--
        The sticky head only sticks to a real scroll container. Pinning it to
        the window instead is a header that quietly does nothing, which is how
        it was wrong on the log page once.
    -->
    <div class="max-h-[calc(100dvh-20rem)] overflow-auto">
        <!--
            The wrapper scrolls, but a table that is only w-full has nothing to
            scroll: the browser shrinks the columns to fit instead, which is how
            the action buttons ended up overlapping at 1032px. A minimum width
            makes the overflow real. Desktop only -- below lg the table is a
            card list, and a minimum width there would reintroduce the very
            horizontal scroll the cards exist to avoid.
        -->
        <table class="data-table am2-roster w-full text-sm lg:min-w-[56rem]">
            <thead class="sticky top-0 z-10 bg-card-muted text-left font-mono text-[11px]
                          uppercase tracking-[0.15em] text-ink-subtle">
                <tr>
                    <?php if ($selectable): ?>
                        <th scope="col" class="w-10 px-4 py-2.5 lg:ps-5">
                            <input type="checkbox" data-select-page
                                   aria-label="<?= e('tbl.select_page') ?>"
                                   class="h-4 w-4 cursor-pointer rounded border-edge-strong
                                          text-brand focus:ring-brand/40">
                        </th>
                    <?php endif; ?>

                    <?php foreach ($columns as $col):
                        $align = ($col['align'] ?? 'left') === 'right' ? 'text-right' : 'text-left'; ?>
                        <th scope="col" class="px-4 py-2.5 font-normal <?= $align ?> <?= $col['class'] ?? '' ?>">
                            <?php if (!empty($col['sort'])):
                                $active = $curSort === $col['sort'];
                                $next = ($active && $curDir === 'asc') ? 'desc' : 'asc'; ?>
                                <a href="<?= htmlspecialchars(am2_table_qs(['sort' => $col['sort'], 'dir' => $next])) ?>"
                                   class="inline-flex items-center gap-1 no-underline!
                                          <?= $active ? 'text-brand!' : 'text-ink-subtle! hover:text-ink!' ?>">
                                    <?= e($col['key']) ?>
                                    <span aria-hidden="true" class="<?= $active ? '' : 'opacity-40' ?>">
                                        <?= $active && $curDir === 'asc' ? '↑' : '↓' ?>
                                    </span>
                                </a>
                            <?php else: ?>
                                <?= e($col['key']) ?>
                            <?php endif; ?>
                        </th>
                    <?php endforeach; ?>
                </tr>
            </thead>
