<?php
require_once __DIR__ . '/config.php';

function is_superadmin() {
    return isset($_SESSION['admin_role']) && $_SESSION['admin_role'] === 'superadmin';
}

function require_superadmin() {
    if (!is_superadmin()) {
        header("Location: dashboard.php");
        exit;
    }
}
