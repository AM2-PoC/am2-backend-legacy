<?php

require_once __DIR__ . '/config.php';
am2_session_boot();
session_destroy();
header("Location: login.php");
?>
