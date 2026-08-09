<?php
/**
 * The other half of the frame: pagination, the offer to extend a selection
 * past the current page, and the bulk bar.
 *
 * A page sets $page, $pages, $total, $pageSize and $bulkActions before
 * including this. See partials/table_open.php for the rest of the contract.
 */

$page       = max(1, (int) ($page ?? 1));
$pages      = max(1, (int) ($pages ?? 1));
$total      = (int) ($total ?? 0);
$pageSize   = (int) ($pageSize ?? 20);
$bulkActions = $bulkActions ?? [];

$from = $total === 0 ? 0 : (($page - 1) * $pageSize) + 1;
$to   = min($total, $page * $pageSize);

/** Pages worth drawing: the ends, and a window around where you are. */
$window = [];
for ($i = 1; $i <= $pages; $i++) {
    if ($i <= 2 || $i > $pages - 2 || abs($i - $page) <= 1) {
        $window[] = $i;
    }
}
?>
        </table>
    </div>

    <footer class="flex flex-col gap-3 border-t border-edge px-4 py-3 sm:flex-row
                   sm:items-center sm:justify-between lg:px-5">
        <p class="text-center font-mono text-[11px] uppercase tracking-[0.15em]
                  text-ink-subtle sm:text-start">
            <?= e('tbl.showing', [
                'from'  => number_format($from),
                'to'    => number_format($to),
                'total' => number_format($total),
            ]) ?>
        </p>

        <?php if ($pages > 1): ?>
            <nav class="flex flex-wrap items-center justify-center gap-1 sm:justify-end"
                 aria-label="<?= e('tbl.pagination') ?>">
                <a href="<?= htmlspecialchars(am2_table_qs(['p' => max(1, $page - 1)])) ?>"
                   <?= $page === 1 ? 'aria-disabled="true" tabindex="-1"' : '' ?>
                   class="grid h-9 w-9 place-items-center rounded-control border border-edge
                          font-mono text-xs no-underline! transition-colors
                          duration-[var(--duration-micro)]
                          <?= $page === 1 ? 'pointer-events-none text-ink-subtle! opacity-40'
                                          : 'text-ink-muted! hover:border-brand hover:text-brand!' ?>"
                   aria-label="<?= e('tbl.prev') ?>">‹</a>

                <?php $last = 0; foreach ($window as $i): ?>
                    <?php if ($last && $i > $last + 1): ?>
                        <span class="px-1 font-mono text-xs text-ink-subtle">…</span>
                    <?php endif; ?>
                    <a href="<?= htmlspecialchars(am2_table_qs(['p' => $i])) ?>"
                       <?= $i === $page ? 'aria-current="page"' : '' ?>
                       class="grid h-9 min-w-9 place-items-center rounded-control border px-2
                              font-mono text-xs tabular-nums no-underline! transition-colors
                              duration-[var(--duration-micro)]
                              <?= $i === $page ? 'border-brand bg-brand/10 text-brand!'
                                               : 'border-edge text-ink-muted! hover:border-brand hover:text-brand!' ?>">
                        <?= $i ?>
                    </a>
                    <?php $last = $i; ?>
                <?php endforeach; ?>

                <a href="<?= htmlspecialchars(am2_table_qs(['p' => min($pages, $page + 1)])) ?>"
                   <?= $page === $pages ? 'aria-disabled="true" tabindex="-1"' : '' ?>
                   class="grid h-9 w-9 place-items-center rounded-control border border-edge
                          font-mono text-xs no-underline! transition-colors
                          duration-[var(--duration-micro)]
                          <?= $page === $pages ? 'pointer-events-none text-ink-subtle! opacity-40'
                                               : 'text-ink-muted! hover:border-brand hover:text-brand!' ?>"
                   aria-label="<?= e('tbl.next') ?>">›</a>
            </nav>
        <?php endif; ?>
    </footer>
</section>

<?php if ($bulkActions): ?>
    <!--
        A contextual command bar: count and scope lead, routine commands sit in
        the middle, and the destructive command is deliberately separate. On a
        phone only the two highest-frequency commands remain in the tray; More
        keeps every other action reachable without making five tiny targets.
    -->
    <div data-bulk-bar hidden role="toolbar" aria-label="<?= e('tbl.bulk_actions') ?>"
         class="fixed inset-x-0 bottom-2 z-40 mx-auto flex w-[calc(100vw-1rem)] max-w-[46rem]
                flex-col gap-1.5 rounded-card border border-edge bg-card p-2 shadow-panel sm:bottom-4 sm:w-fit">

        <p data-select-all-matching hidden
           class="flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-control
                  bg-card-muted px-2.5 py-1.5 text-[11px] text-ink-muted">
            <?= e('tbl.page_selected') ?>
            <button type="button"
                    class="font-mono text-[11px] uppercase tracking-[0.15em] text-brand underline
                           underline-offset-2">
                <?= e('tbl.select_all_matching', ['n' => number_format($total)]) ?>
            </button>
        </p>

        <div class="flex min-w-0 items-center gap-2">
            <div class="flex min-w-0 flex-1 items-center justify-between gap-2 sm:flex-none">
                <span class="whitespace-nowrap ps-1 font-mono text-[11px] uppercase tracking-[0.12em] text-ink">
                    <span data-bulk-count aria-live="polite" class="text-brand">0</span> <?= e('tbl.selected') ?>
                </span>
                <button type="button" data-clear-selection
                        aria-label="<?= e('tbl.clear_selection') ?>" title="<?= e('tbl.clear_selection') ?>"
                        class="grid min-h-11 min-w-11 shrink-0 place-items-center rounded-control text-ink-subtle
                               transition-colors duration-[var(--duration-micro)] hover:bg-card-muted hover:text-ink
                               focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60">
                    <?= am2_icon('close', 'h-4 w-4') ?>
                </button>
            </div>

            <span data-bulk-verbs class="flex min-w-0 flex-1 items-center justify-end gap-1.5">
                <?php foreach ($bulkActions as $index => $act):
                    $isDanger = !empty($act['danger']);
                    $isPrimary = !$isDanger && $index < 2;
                    $actionClass = $isDanger ? 'data-bulk-danger' : ($isPrimary ? 'data-bulk-primary' : 'data-bulk-optional'); ?>
                    <button type="button" data-bulk="<?= htmlspecialchars($act['verb']) ?>" <?= $actionClass ?>
                            <?php foreach (($act['data'] ?? []) as $k => $v): ?>
                                data-<?= $k ?>="<?= htmlspecialchars((string) $v) ?>"
                            <?php endforeach; ?>
                            aria-label="<?= e($act['key']) ?>" title="<?= e($act['key']) ?>"
                            class="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-control border px-3
                                   text-sm transition-colors duration-[var(--duration-micro)] focus:outline-none focus-visible:ring-2
                                   <?= $isDanger
                                       ? 'border-bad/50 text-bad hover:bg-bad/10 focus-visible:ring-bad/60'
                                       : 'border-edge text-ink hover:border-brand hover:bg-brand/5 hover:text-brand focus-visible:ring-brand/60' ?>">
                        <?= am2_icon($act['icon'] ?? 'chevron', 'h-4 w-4') ?>
                        <span data-bulk-label class="hidden sm:inline"><?= e($act['toolbar_key'] ?? $act['key']) ?></span>
                    </button>
                <?php endforeach; ?>

                <button type="button" data-bulk-more aria-haspopup="menu" aria-expanded="false"
                        aria-label="<?= e('tbl.more_actions') ?>" title="<?= e('tbl.more_actions') ?>"
                        class="grid min-h-11 min-w-11 shrink-0 place-items-center rounded-control border border-edge text-ink
                               transition-colors duration-[var(--duration-micro)] hover:border-brand hover:text-brand
                               focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 sm:hidden">
                    <?= am2_icon('more', 'h-4 w-4') ?>
                    <span class="sr-only"><?= e('tbl.more_actions') ?></span>
                </button>
            </span>
        </div>

        <!-- The narrow tray carries the frequent pair. Less frequent and
             destructive commands remain available in this explicit menu rather
             than shrinking every target until it is hard to use. -->
        <div data-bulk-more-menu hidden role="menu" aria-label="<?= e('tbl.more_actions') ?>"
             class="rounded-control border border-edge bg-card-muted p-1 sm:hidden">
            <?php foreach ($bulkActions as $index => $act):
                $isDanger = !empty($act['danger']);
                $isPrimary = !$isDanger && $index < 2;
                if ($isPrimary) continue; ?>
                <button type="button" role="menuitem" data-bulk="<?= htmlspecialchars($act['verb']) ?>"
                        <?php foreach (($act['data'] ?? []) as $k => $v): ?>
                            data-<?= $k ?>="<?= htmlspecialchars((string) $v) ?>"
                        <?php endforeach; ?>
                        class="flex min-h-11 w-full items-center gap-2 rounded-control px-3 text-left text-sm
                               transition-colors duration-[var(--duration-micro)] focus:outline-none focus-visible:ring-2
                               <?= $isDanger
                                   ? 'text-bad hover:bg-bad/10 focus-visible:ring-bad/60'
                                   : 'text-ink hover:bg-brand/5 hover:text-brand focus-visible:ring-brand/60' ?>">
                    <?= am2_icon($act['icon'] ?? 'chevron', 'h-4 w-4') ?>
                    <?= e($act['key']) ?>
                </button>
            <?php endforeach; ?>
        </div>
    </div>
<?php endif; ?>
