<?php
require_once __DIR__ . '/config.php';

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
