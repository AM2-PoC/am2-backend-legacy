<?php
// UPDATE public.users SET ignored = true
$export = "INSERT INTO {$table} ({$columns}) VALUES ({$values})";
$pdo->prepare("UPDATE public.users SET status = ? WHERE id = ?; DELETE FROM public.device_tokens WHERE user_id = ?");
?>
<script>
const preview = /DELETE FROM public.users/;
</script>
