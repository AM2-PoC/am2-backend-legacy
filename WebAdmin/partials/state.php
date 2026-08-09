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

