<?php
/**
 * The result of a write, said once.
 *
 * Rendered by the server so that a browser which never runs the bundle still
 * sees it; hidden by `.am2-js .am2-notice` while script is working, and turned
 * into a toast by am2-ui.js on load. `data-notice` carries which kind it is,
 * because the toast has to know before it draws anything.
 *
 * Pages set $noticeOk and $noticeText before including this, or set neither.
 */
$noticeText = trim((string) ($noticeText ?? ''));
if ($noticeText !== ''):
    $noticeOk = $noticeOk ?? true;
?>
<p class="am2-notice mb-5 rounded-control border-l-2 py-3 pl-3 pr-3 text-sm
          <?= $noticeOk ? 'border-ok bg-ok/5' : 'border-bad bg-bad/5' ?>"
   role="<?= $noticeOk ? 'status' : 'alert' ?>"
   data-notice="<?= $noticeOk ? 'ok' : 'bad' ?>"><?= htmlspecialchars($noticeText) ?></p>
<?php
endif;
$noticeText = '';
