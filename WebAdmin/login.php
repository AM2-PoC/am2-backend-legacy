<?php
session_start();
include 'config.php';

if (isset($_SESSION['admin_logged_in'])) {
    header("Location: dashboard.php");
    exit;
}

$error = "";

if ($_SERVER['REQUEST_METHOD'] == 'POST') {
    $username = $_POST['username'];
    $password = $_POST['password'];
    // Per account and per source, not per source alone.
    $client = am2_client_ip() . '|' . $username;

    try {
        if (am2_login_blocked($client)) {
            // bcrypt is deliberately slow, so an unthrottled login form is both
            // a guessing oracle and a cheap way to load the server.
            $error = t('login.error_throttled');
            throw new RuntimeException('throttled');
        }

        $stmt = $pdo->prepare("SELECT id, username, password_hash, role, status FROM public.admin WHERE username = ?");
        $stmt->execute([$username]);
        $user = $stmt->fetch();

        if ($user && password_verify($password, $user['password_hash'])) {
            if ($user['status'] !== 'active') {
                $error = t('login.error_disabled');
            } else {
                // Without this, the session id issued before authentication
                // survives it, so an id planted beforehand becomes a valid one.
                session_regenerate_id(true);
                am2_login_succeeded($client);

                $_SESSION['admin_logged_in'] = true;
                $_SESSION['last_seen']       = time();
                $_SESSION['admin_id']        = $user['id'];
                $_SESSION['admin_username']  = $user['username'];
                $_SESSION['admin_role']      = $user['role'];
                
                header("Location: dashboard.php");
                exit;
            }
        } else {
            am2_login_failed($client);
            $error = t('login.error_credentials');
        }
    } catch (RuntimeException $e) {
        // Throttled: $error is already set, nothing else to do.
    } catch (PDOException $e) {
        $error = am2_safe_error($e, 'login');
    }
}
?>
<!DOCTYPE html>
<html <?= am2_html_attrs() ?>>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title><?= e('login.title') ?> — AM²</title>
    <link rel="preload" as="font" type="font/woff2" href="asset/font/Inter.woff2" crossorigin>
    <link rel="stylesheet" href="asset/css/am2-ui.css">
    <link rel="stylesheet" href="asset/css/am2-tailwind.css">
</head>
<body class="min-h-dvh bg-app font-sans text-ink antialiased">

<main class="min-h-dvh grid place-items-center px-6 py-12">
    <div class="w-full max-w-sm">

        <!-- The lamp is the only colour on the page until a field is focused.
             On a radio console a lit indicator means the system is live; here
             it means the same thing and nothing more. -->
        <div class="flex items-baseline gap-3">
            <h1 class="text-4xl font-semibold tracking-tight">AM<sup class="text-xl">2</sup></h1>
            <span class="size-2 rounded-full bg-brand" aria-hidden="true"></span>
        </div>
        <p class="mt-2 font-mono text-[11px] uppercase tracking-[0.2em] text-ink-subtle">
            <?= e('login.subtitle') ?>
        </p>

        <?php if ($error !== ""): ?>
            <p role="alert"
               class="mt-8 border-l-2 border-bad bg-bad/5 py-3 pl-4 pr-3 text-sm text-ink">
                <?= htmlspecialchars($error) ?>
            </p>
        <?php endif; ?>

        <!-- Ruled fields rather than boxes: a dispatch log is typed onto ruled
             lines, and the form is read far more often than it is filled in. -->
        <form method="POST" autocomplete="off" class="mt-10 space-y-8">
            <div class="group">
                <label for="username"
                       class="block font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle">
                    <?= e('login.username') ?>
                </label>
                <input id="username" name="username" type="text" required autofocus
                       autocapitalize="none" spellcheck="false"
                       class="mt-2 w-full border-0 border-b-2 border-edge bg-transparent px-0 pb-2
                              font-mono text-lg text-ink
                              focus:border-brand focus:outline-none">
            </div>

            <div x-data="{ shown: false }">
                <div class="flex items-baseline justify-between">
                    <label for="password"
                           class="block font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle">
                        <?= e('login.password') ?>
                    </label>
                    <button type="button" @click="shown = !shown"
                            :aria-pressed="shown ? 'true' : 'false'"
                            class="font-mono text-[11px] uppercase tracking-[0.15em]
                                   text-ink-subtle hover:text-brand
                                   focus-visible:outline-2 focus-visible:outline-offset-2
                                   focus-visible:outline-brand">
                        <span x-text="shown
                            ? <?= json_encode(t('login.hide_password')) ?>
                            : <?= json_encode(t('login.show_password')) ?>"></span>
                    </button>
                </div>
                <input id="password" name="password" required
                       :type="shown ? 'text' : 'password'"
                       class="mt-2 w-full border-0 border-b-2 border-edge bg-transparent px-0 pb-2
                              font-mono text-lg text-ink
                              focus:border-brand focus:outline-none">
            </div>

            <button type="submit"
                    class="group flex w-full items-center justify-between border border-edge-strong
                           px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-ink
                           transition-colors hover:border-brand hover:text-brand
                           focus-visible:outline-2 focus-visible:outline-offset-2
                           focus-visible:outline-brand">
                <span><?= e('login.submit') ?></span>
                <span aria-hidden="true" class="transition-transform group-hover:translate-x-1">&rarr;</span>
            </button>
        </form>

        <div class="mt-12 flex items-center justify-between border-t border-edge pt-4">
            <div class="flex gap-3 font-mono text-[11px] uppercase tracking-[0.15em]">
                <?php foreach (AM2_LOCALES as $loc): ?>
                    <a href="?lang=<?= $loc ?>"
                       class="<?= am2_locale() === $loc
                           ? 'text-brand' : 'text-ink-subtle hover:text-ink' ?>"
                       <?= am2_locale() === $loc ? 'aria-current="true"' : '' ?>><?= strtoupper($loc) ?></a>
                <?php endforeach; ?>
            </div>
            <button type="button" id="themeToggle"
                    class="font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle hover:text-ink"
                    aria-pressed="<?= am2_theme() === 'dark' ? 'true' : 'false' ?>">
                <?= e('pref.theme') ?>
            </button>
        </div>
    </div>
</main>

<script src="asset/js/alpine.min.js" defer></script>
<script>
    // Kept out of Alpine: it has to work whether or not that script loaded.
    document.getElementById('themeToggle').addEventListener('click', function () {
        const root = document.documentElement;
        const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        document.cookie = 'am2_theme=' + next + ';path=/;max-age=31536000;samesite=lax';
        this.setAttribute('aria-pressed', next === 'dark' ? 'true' : 'false');
    });
</script>
</body>
</html>
