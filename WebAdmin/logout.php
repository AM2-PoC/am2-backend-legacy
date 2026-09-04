<?php
// The ordinary guard, like every other page. Signed out already means
// there is nothing to destroy and the redirect to login is the right end
// state either way.
require_once __DIR__ . '/config.php';
am2_session_boot();
session_destroy();
header("Location: login.php");
?>
