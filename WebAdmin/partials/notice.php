<?php

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
