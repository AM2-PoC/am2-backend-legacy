<?php
if (session_status() === PHP_SESSION_NONE) {
    session_start();
}

if (!isset($_SESSION['admin_logged_in']) || $_SESSION['admin_logged_in'] !== true) {
    header("Location: login.php");
    exit;
}

function is_superadmin() {
    return isset($_SESSION['admin_role']) && $_SESSION['admin_role'] === 'superadmin';
}

/** Send a branch admin back to the dashboard rather than the login page. */
function require_superadmin() {
    if (!is_superadmin()) {
        header("Location: dashboard.php");
        exit;
    }
}
?>
