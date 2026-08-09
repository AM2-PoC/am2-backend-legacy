<?php
require_once __DIR__ . '/session_boot.php';
am2_session_boot();
session_destroy();
header("Location: login.php");
?>
