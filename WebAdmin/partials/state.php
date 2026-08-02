<?php
/**
 * The states a panel is in when it has nothing to show.
 *
 * Empty, no-results, error, stale and loading were each improvised per page,
 * or -- more often -- not drawn at all: a failed fetch left the last good rows
 * on screen with no sign they had stopped being true, and an empty table was a
 * blank rectangle. Every one of them now says what happened and, where there
 * is one, what to do about it.
 *
 * Structure is the same in all five: mark, heading, sentence, action. The mark
 * carries the meaning, so it is never the only thing carrying it -- the
 * heading says the same thing in words.
 */

const AM2_STATE_MARKS = [
    'empty'      => ['inbox',     'text-ink-subtle'],
    'no_results' => ['search',    'text-ink-subtle'],
    'error'      => ['alert',     'text-bad'],
    'stale'      => ['clock',     'text-warn'],
    'restricted' => ['lock',      'text-ink-subtle'],
];

/**
 * @param string      $variant One of AM2_STATE_MARKS.
 * @param string      $title   Already-translated heading.
 * @param string      $body    Already-translated sentence, or ''.
 * @param string|null $action  Raw markup for a single button or link.
 */
function am2_state(string $variant, string $title, string $body = '', ?string $action = null): string
{
    [$icon, $tone] = AM2_STATE_MARKS[$variant] ?? AM2_STATE_MARKS['empty'];

    $html = '<div class="flex flex-col items-center justify-center px-6 py-14 text-center"'
          . ' role="status">'
          . '<span class="mb-3 flex h-11 w-11 items-center justify-center rounded-full'
          . ' border border-edge bg-card-muted ' . $tone . '">'
          . am2_icon($icon, 'h-5 w-5') . '</span>'
          . '<p class="text-sm font-semibold text-ink">' . htmlspecialchars($title) . '</p>';

    if ($body !== '') {
        $html .= '<p class="mt-1 max-w-sm text-xs text-ink-muted">'
               . htmlspecialchars($body) . '</p>';
    }
    if ($action !== null) {
        $html .= '<div class="mt-4">' . $action . '</div>';
    }

    return $html . '</div>';
}

/**
 * Rows the same shape as the ones being fetched.
 *
 * A spinner in the middle of a table tells the reader that something is
 * happening; it does not tell them what is coming. These do.
 */
function am2_skeleton_rows(int $rows = 5, int $cols = 4): string
{
    $html = '<tbody aria-hidden="true">';
    for ($r = 0; $r < $rows; $r++) {
        $html .= '<tr class="border-b border-edge">';
        for ($c = 0; $c < $cols; $c++) {
            // Uneven widths: a column of identical bars reads as a pattern
            // rather than as text that has not arrived.
            $w = [70, 45, 85, 55, 60][($r + $c) % 5];
            $html .= '<td class="px-4 py-3 lg:px-5">'
                   . '<span class="am2-skeleton block h-3" style="width:' . $w . '%"></span>'
                   . '</td>';
        }
        $html .= '</tr>';
    }
    return $html . '</tbody>';
}

/** A retry button that re-runs an Alpine method. */
function am2_retry_button(string $call): string
{
    return '<button type="button" @click="' . htmlspecialchars($call, ENT_QUOTES) . '"'
         . ' class="rounded-control border border-edge px-3 py-1.5 font-mono text-[10px]'
         . ' uppercase tracking-[0.15em] text-ink-muted transition-colors duration-[var(--duration-micro)]'
         . ' hover:border-brand hover:text-brand">'
         . e('common.retry') . '</button>';
}
