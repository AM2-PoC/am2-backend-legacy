<?php

const AM2_STATE_MARKS = [
    'empty'      => ['inbox',     'text-ink-subtle'],
    'no_results' => ['search',    'text-ink-subtle'],
    'error'      => ['alert',     'text-bad'],
    'stale'      => ['clock',     'text-warn'],
    'restricted' => ['lock',      'text-ink-subtle'],
];

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

