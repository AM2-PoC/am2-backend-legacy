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
        <p class="text-center font-mono text-[10px] uppercase tracking-[0.15em]
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
        The bar rises over the content and stays put while the table scrolls,
        because a bar that drifts away from the rows it acts on makes people
        hesitate. It states the count first: the number is the thing that
        decides whether the next click is routine or irreversible.
    -->
    <!--
        A pill the width of what is in it, not a strip the width of the screen.
        inset-x pinned both edges, so w-auto could never shrink: the bar was
        374px on a phone and 704px on a desk to hold about 330px of controls.
        Both insets zero with width:max-content and margin auto, which centres
        it without a transform -- a transform makes a containing block, and the
        bar would have anchored to whatever ancestor had one.
    -->
    <div data-bulk-bar hidden
         class="fixed inset-x-0 bottom-2 z-40 mx-auto flex w-fit max-w-[calc(100vw-1rem)]
                flex-col gap-1.5 rounded-card border border-edge bg-card p-1
                shadow-panel sm:bottom-4 sm:p-1.5">

        <p data-select-all-matching hidden
           class="flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-control
                  bg-card-muted px-2.5 py-1.5 text-[11px] text-ink-muted">
            <?= e('tbl.page_selected') ?>
            <button type="button"
                    class="font-mono text-[10px] uppercase tracking-[0.15em] text-brand underline
                           underline-offset-2">
                <?= e('tbl.select_all_matching', ['n' => number_format($total)]) ?>
            </button>
        </p>

        <!-- One row at every width. Five glyphs and a count fit a 390px
             phone with room to spare, so there is nothing to stack. -->
        <div class="flex items-center gap-2">

            <!-- Always visible, and on a phone this is the whole bar: one row
                 of forty pixels. The count sits with the control that clears
                 it, because they are the same thought. -->
            <div class="flex shrink-0 items-center gap-1.5">
                <span class="whitespace-nowrap ps-1.5 font-mono text-[9px] uppercase
                             tracking-[0.12em] text-ink">
                    <span data-bulk-count class="text-brand">0</span> <?= e('tbl.selected') ?>
                </span>

            </div>

            <!-- Icons on a phone, words from sm up. Five verbs fit a narrow
                 row when each is a glyph, so nothing has to be folded away
                 behind a control that says AKSI and nothing about what is
                 inside it. -->
            <span data-bulk-verbs
                  class="flex flex-1 items-center justify-end gap-1 sm:gap-1.5">
                <?php foreach ($bulkActions as $act): ?>
                    <button type="button" data-bulk="<?= htmlspecialchars($act['verb']) ?>"
                            <?php foreach (($act['data'] ?? []) as $k => $v): ?>
                                data-<?= $k ?>="<?= htmlspecialchars((string) $v) ?>"
                            <?php endforeach; ?>
                            aria-label="<?= e($act['key']) ?>" title="<?= e($act['key']) ?>"
                            class="grid h-9 w-9 shrink-0 place-items-center rounded-control border
                                   transition-colors duration-[var(--duration-micro)]
                                   focus:outline-none focus-visible:ring-2 sm:h-8 sm:w-8
                                   <?= !empty($act['danger'])
                                       ? 'border-bad/50 text-bad hover:bg-bad/10 focus-visible:ring-bad/60'
                                       : 'border-edge text-ink hover:border-brand hover:text-brand focus-visible:ring-brand/60' ?>">
                        <?= am2_icon($act['icon'] ?? 'chevron', 'h-4 w-4') ?>
                        <span class="sr-only"><?= e($act['key']) ?></span>
                    </button>
                <?php endforeach; ?>
            </span>

                <button type="button" data-clear-selection
                        aria-label="<?= e('tbl.clear_selection') ?>" title="<?= e('tbl.clear_selection') ?>"
                        class="grid h-9 w-9 shrink-0 place-items-center rounded-control text-ink-subtle sm:h-8 sm:w-8
                               transition-colors duration-[var(--duration-micro)] hover:text-ink
                               focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60">
                    <?= am2_icon('close', 'h-4 w-4') ?>
                </button>
        </div>
    </div>
<?php endif; ?>
