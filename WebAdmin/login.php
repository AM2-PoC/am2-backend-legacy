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
    <link rel="icon" href="<?= am2_asset('asset/image/logo.jpeg') ?>">
    <link rel="preload" as="font" type="font/woff2" href="asset/font/Inter.woff2" crossorigin>
    <link rel="stylesheet" href="<?= am2_asset('asset/css/am2-ui.css') ?>">
    <link rel="stylesheet" href="<?= am2_asset('asset/css/am2-tailwind.css') ?>">
</head>
<body class="min-h-dvh bg-app font-sans text-ink antialiased">

<div class="min-h-dvh lg:grid lg:grid-cols-[1.1fr_1fr]">

    <!-- Brand side, desktop only. On a phone the form has to come first; half a
         screen of atmosphere would push it below the fold. -->
    <aside class="relative hidden overflow-hidden bg-slate-950 lg:flex lg:flex-col
                  lg:justify-between lg:border-r lg:border-brand/25 lg:p-12">

        <!-- The mark already draws two orbital arcs. Repeating them as rings
             travelling outward turns the logo into what it depicts: a signal
             leaving a transmitter. -->
        <div class="pointer-events-none absolute inset-0 grid place-items-center" aria-hidden="true">
            <span class="am2-ring" style="--delay:0s"></span>
            <span class="am2-ring" style="--delay:1.6s"></span>
            <span class="am2-ring" style="--delay:3.2s"></span>
        </div>

        <p class="relative font-mono text-[11px] uppercase tracking-[0.25em] text-white/40">
            AM<sup>2</sup> — <?= e('login.subtitle') ?>
        </p>

        <div class="relative grid place-items-center">
            <img src="<?= am2_asset('asset/image/logo.jpeg') ?>" alt=""
                 width="176" height="176"
                 class="h-44 w-44 rounded-full bg-white object-contain p-3 shadow-2xl">
        </div>

        <dl class="relative grid grid-cols-3 gap-6 border-t border-white/10 pt-6
                   font-mono text-[10px] uppercase tracking-[0.15em]">
            <?php foreach (['ptt', 'channels', 'tracking'] as $k): ?>
                <div>
                    <dt class="text-white/70"><?= e('login.fact_' . $k . '_label') ?></dt>
                    <dd class="mt-1 normal-case tracking-normal text-white/40"><?= e('login.fact_' . $k) ?></dd>
                </div>
            <?php endforeach; ?>
        </dl>
    </aside>

    <!-- Form side: a card on a phone, a plain column on desktop where the
         brand panel already provides the frame. -->
    <main class="grid min-h-dvh place-items-center px-4 py-10 lg:min-h-0 lg:px-12">
        <div class="w-full max-w-sm rounded-card border border-edge bg-card p-6 shadow-sm
                    lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none">

            <div class="flex items-center gap-4 lg:hidden">
                <img src="<?= am2_asset('asset/image/logo.jpeg') ?>" alt=""
                     width="48" height="48" class="h-12 w-12 rounded-full bg-white object-contain p-1">
                <div>
                    <p class="text-xl font-semibold leading-none">AM<sup class="text-xs">2</sup></p>
                    <p class="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-subtle">
                        <?= e('login.subtitle') ?>
                    </p>
                </div>
            </div>

            <div class="mt-8 lg:mt-0">
                <h1 class="text-2xl font-semibold tracking-tight"><?= e('login.heading') ?></h1>
                <p class="mt-2 text-sm text-ink-muted"><?= e('login.lede') ?></p>
            </div>

            <?php if ($error !== ""): ?>
                <p role="alert"
                   class="mt-6 flex items-start gap-2 rounded-control border-l-2 border-bad bg-bad/5 py-3 pl-3 pr-3 text-sm">
                    <span aria-hidden="true" class="mt-px font-mono font-bold text-bad">!</span>
                    <span><?= htmlspecialchars($error) ?></span>
                </p>
            <?php endif; ?>

            <form method="POST" autocomplete="off" class="mt-8 space-y-5"
                  x-data="signIn()" @submit="working = true">

                <div>
                    <label for="username"
                           class="block font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle">
                        <?= e('login.username') ?>
                    </label>
                    <input id="username" name="username" type="text" required autofocus
                           autocapitalize="none" spellcheck="false"
                           class="mt-2 w-full rounded-control border border-edge bg-card px-3 py-2.5
                                  font-mono text-base text-ink transition-colors
                                  hover:border-edge-strong focus:border-brand focus:outline-none">
                </div>

                <div>
                    <div class="flex items-baseline justify-between">
                        <label for="password"
                               class="block font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle">
                            <?= e('login.password') ?>
                        </label>
                        <button type="button" @click="shown = !shown"
                                :aria-pressed="shown ? 'true' : 'false'"
                                class="font-mono text-[10px] uppercase tracking-[0.15em]
                                       text-ink-subtle hover:text-brand
                                       focus-visible:outline-2 focus-visible:outline-offset-2
                                       focus-visible:outline-brand">
                            <!-- Rendered server-side as well: x-text leaves this
                                 blank until Alpine boots, and blank for good if
                                 it never does. -->
                            <span x-text="shown
                                ? <?= json_encode(t('login.hide_password')) ?>
                                : <?= json_encode(t('login.show_password')) ?>"><?= e('login.show_password') ?></span>
                        </button>
                    </div>
                    <input id="password" name="password" required
                           :type="shown ? 'text' : 'password'"
                           @keyup="caps = $event.getModifierState && $event.getModifierState('CapsLock')"
                           class="mt-2 w-full rounded-control border border-edge bg-card px-3 py-2.5
                                  font-mono text-base text-ink transition-colors
                                  hover:border-edge-strong focus:border-brand focus:outline-none">
                    <!-- Caps Lock is the commonest cause of a rejected sign-in
                         that the person cannot see. Say so before they submit. -->
                    <p x-cloak x-show="caps"
                       class="mt-2 flex items-center gap-2 font-mono text-[10px] uppercase
                              tracking-[0.15em] text-warn">
                        <span aria-hidden="true">&#8679;</span><?= e('login.caps_on') ?>
                    </p>
                </div>

                <button type="submit" :disabled="working"
                        class="group flex w-full items-center justify-between rounded-control border border-brand
                               bg-brand px-4 py-3 font-mono text-xs uppercase tracking-[0.2em]
                               text-slate-950 transition
                               hover:border-brand-hover hover:bg-brand-hover
                               disabled:cursor-wait disabled:opacity-70
                               focus-visible:outline-2 focus-visible:outline-offset-2
                               focus-visible:outline-brand">
                    <span x-text="working
                        ? <?= json_encode(t('login.connecting')) ?>
                        : <?= json_encode(t('login.submit')) ?>"><?= e('login.submit') ?></span>
                    <span aria-hidden="true"
                          class="transition-transform group-hover:translate-x-1"
                          x-text="working ? '…' : '→'">&rarr;</span>
                </button>
            </form>

            <div class="mt-10 flex items-center justify-between border-t border-edge pt-4">
                <div class="flex gap-4 font-mono text-[10px] uppercase tracking-[0.15em]">
                    <?php foreach (AM2_LOCALES as $loc): ?>
                        <!-- important suffix: am2-ui.css styles bare anchors with
                             !important and would otherwise win the cascade. -->
                        <a href="?lang=<?= $loc ?>"
                           class="no-underline! <?= am2_locale() === $loc
                               ? 'text-brand!' : 'text-ink-subtle! hover:text-ink!' ?>"
                           <?= am2_locale() === $loc ? 'aria-current="true"' : '' ?>><?= strtoupper($loc) ?></a>
                    <?php endforeach; ?>
                </div>
                <button type="button" id="themeToggle"
                        class="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle hover:text-ink"
                        aria-pressed="<?= am2_theme() === 'dark' ? 'true' : 'false' ?>">
                    <?= e('pref.theme') ?>
                </button>
            </div>
        </div>
    </main>
</div>

<script src="<?= am2_asset('asset/js/alpine.min.js') ?>" defer></script>
<script>
    function signIn() {
        return { shown: false, caps: false, working: false };
    }
    // Outside Alpine on purpose: the theme must work whether or not that loads.
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
