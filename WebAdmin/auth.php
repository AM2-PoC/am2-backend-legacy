<?php
/**
 * What a panel page needs beyond being signed in.
 *
 * This file used to be the session guard, and it wrote the refusal out itself:
 * 401 with a JSON body for a fetch(), a redirect to login.php for a document
 * request. Two things were wrong with that. It covered only the eight pages
 * that remembered to include it, so the thirteen JSON endpoints each invented
 * their own answer and disagreed — one of them returning HTTP 200 with an
 * `error` field, a refusal no client could see. And it was a second copy of a
 * rule, which is two chances to fix one of them.
 *
 * The refusal now lives in am2_require_identity() (WebAdmin/auth_guard.php) and
 * runs from the config.php bootstrap for every request, so by the time this
 * file is reached the caller is signed in. Ordering is preserved and still
 * matters: config.php starts the session, applies idle expiry and only then
 * authorizes, which is what stopped the first request after a timeout from
 * running its handler with a null admin id.
 *
 * What is left here is what was always specific to a page: the two superadmin
 * helpers, which send a branch admin back to the dashboard rather than to the
 * login screen — being signed in and not being allowed are different answers.
 */

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
