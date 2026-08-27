<?php
require_once __DIR__ . '/session_boot.php';
am2_session_boot();
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
                // Rotating leaves two Set-Cookie headers behind, so the helper
                // collapses them to one; see session_boot.php.
                am2_session_login();
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
    <link rel="preload" as="font" type="font/woff2" href="asset/font/IBMPlexSans-Regular.woff2" crossorigin>
    <link rel="stylesheet" href="<?= am2_asset('asset/css/am2-ui.css') ?>">
    <link rel="stylesheet" href="<?= am2_asset('asset/css/am2-tailwind.css') ?>">
</head>
<body class="min-h-dvh bg-app font-sans text-ink antialiased">

<div class="min-h-dvh lg:grid lg:grid-cols-[2fr_3fr]">

    <!--
        Brand side, desktop only. On a phone the form has to come first: half a
        screen of atmosphere would push the thing the page exists for below the
        fold. Two fifths rather than half — the smaller claim on the screen,
        because it is the smaller part of the job.
    -->
    <aside class="am2-brand-panel relative hidden overflow-hidden lg:flex lg:flex-col
                  lg:justify-between lg:p-10">
        <div class="am2-brand-geometry" aria-hidden="true">
            <span class="am2-brand-grid"></span>
            <span class="am2-brand-axis am2-brand-axis-x"></span>
            <span class="am2-brand-axis am2-brand-axis-y"></span>
            <span class="am2-brand-sweep"></span>
        </div>

        <!-- The mark already draws two orbital arcs. Rings travelling outward
             turn the logo into what it depicts: a signal leaving a
             transmitter. Motion drives them rather than CSS keyframes, so
             there is one owner and reduced motion is a branch instead of a
             media query fighting an animation. -->
        <p class="relative font-mono text-[11px] uppercase tracking-[0.25em] text-ink-subtle">
            AM<sup>2</sup> — <?= e('login.subtitle') ?>
        </p>

        <div class="relative grid place-items-center gap-6 py-8">
            <!-- The rings belong to the mark, so they are anchored to it. Centred
                 on the panel instead, they ran straight through the wordmark. -->
            <div class="am2-signal-core relative grid place-items-center">
                <div class="pointer-events-none absolute inset-0 grid place-items-center"
                     aria-hidden="true">
                    <span data-am2-ring class="am2-ring"></span>
                    <span data-am2-ring class="am2-ring"></span>
                    <span data-am2-ring class="am2-ring"></span>
                </div>
                <img src="<?= am2_asset('asset/image/logo.jpeg') ?>" alt="AM²"
                     width="160" height="160"
                     class="relative h-40 w-40 rounded-full bg-white object-contain p-3"
                     style="box-shadow: var(--am2-card-shadow)">
            </div>
        </div>

        <!-- What the product does, in the operator's words. Three facts, not a
             pitch: whoever reads this page already bought it. -->
        <div class="am2-brand-copy relative">
            <p class="text-2xl font-semibold tracking-tight text-ink">AM²</p>
            <p class="mt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-ink-subtle">
                <?= e('login.wordmark_note') ?>
            </p>

            <dl class="am2-brand-facts mt-6 grid grid-cols-3 gap-0">
                <?php foreach ([
                    ['login.fact_ptt_label', 'login.fact_ptt'],
                    ['login.fact_channels_label', 'login.fact_channels'],
                    ['login.fact_tracking_label', 'login.fact_tracking'],
                ] as [$labelKey, $bodyKey]): ?>
                    <div class="am2-brand-fact">
                        <dt class="font-mono text-[11px] uppercase tracking-[0.18em] text-brand">
                            <?= e($labelKey) ?>
                        </dt>
                        <dd class="mt-1 font-mono text-[11px] leading-relaxed text-ink-muted">
                            <?= e($bodyKey) ?>
                        </dd>
                    </div>
                <?php endforeach; ?>
            </dl>
        </div>
    </aside>

    <!-- Form side. The geometry belongs to the room around the card, not to the
         surface users have to read. Its low-contrast shapes frame the action
         without competing with it. -->
    <main class="am2-login-stage relative isolate flex min-h-dvh flex-col items-center
                 justify-center overflow-hidden px-5 py-10 sm:px-8">
        <div class="am2-login-geometry" aria-hidden="true">
            <span class="am2-geo am2-geo-grid"></span>
            <span class="am2-geo am2-geo-steps"></span>
            <span class="am2-geo am2-geo-orbit"></span>
            <span class="am2-geo am2-geo-diamond"></span>
            <span class="am2-geo am2-geo-cross am2-geo-cross-a"></span>
            <span class="am2-geo am2-geo-cross am2-geo-cross-b"></span>
        </div>

        <div class="relative z-10 w-full max-w-[420px]">

            <!-- The mark repeats above the card on small screens, where the
                 brand panel does not exist at all. -->
            <div class="mb-6 flex items-center gap-3 lg:hidden">
                <img src="<?= am2_asset('asset/image/logo.jpeg') ?>" alt=""
                     width="44" height="44"
                     class="h-11 w-11 rounded-full bg-white object-contain p-0.5">
                <div>
                    <p class="text-sm font-semibold tracking-tight">AM²</p>
                    <p class="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">
                        <?= e('login.subtitle') ?>
                    </p>
                </div>
            </div>

            <!--
                Preline card: https://preline.co/docs/card.html
                The form sat on the bare background before, which read as a
                page that had not finished rendering rather than a deliberate
                one.
            -->
            <div id="am2-login-card"
                 class="am2-surface am2-surface-accent rounded-card p-6 sm:p-8">

                <div data-am2-field>
                    <p class="font-mono text-[11px] uppercase tracking-[0.2em] text-brand">
                        <?= e('login.eyebrow') ?>
                    </p>
                    <h1 class="mt-1.5 text-xl font-semibold tracking-tight"><?= e('login.heading') ?></h1>
                    <p class="mt-1 text-sm text-ink-muted"><?= e('login.lede') ?></p>
                </div>

                <?php if ($error !== ""): ?>
                    <!-- Preline alert: https://preline.co/docs/alerts.html
                         role=alert so a screen reader is told without being
                         moved, and the left border carries the meaning as well
                         as the colour does. -->
                    <div id="am2-login-error" role="alert"
                         class="mt-5 flex items-start gap-2.5 rounded-control border border-bad/40
                                border-l-2 border-l-bad bg-bad/5 px-3 py-3 text-sm">
                        <span class="mt-px shrink-0 text-bad" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
                                 stroke-linecap="round" class="h-4 w-4">
                                <circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>
                            </svg>
                        </span>
                        <span><?= htmlspecialchars($error) ?></span>
                    </div>
                <?php endif; ?>

                <!-- method, field names and ids are the contract: the handler
                     above reads $_POST['username'] and $_POST['password'], and
                     the form posts to this same URL. None of it changes. -->
                <form id="am2-login-form" method="POST" autocomplete="off" class="mt-6 space-y-4">

                    <div data-am2-field>
                        <label for="username"
                               class="block font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle">
                            <?= e('login.username') ?>
                        </label>
                        <input id="username" name="username" type="text" required autofocus
                               autocapitalize="none" spellcheck="false"
                               class="mt-2 h-12 w-full rounded-control border border-edge bg-card px-3
                                      font-mono text-base text-ink transition-colors
                                      duration-[var(--duration-micro)]
                                      hover:border-edge-strong focus:border-brand focus:outline-none
                                      focus:ring-2 focus:ring-brand/25">
                    </div>

                    <div data-am2-field>
                        <label for="password"
                               class="block font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle">
                            <?= e('login.password') ?>
                        </label>
                        <!--
                            Preline toggle-password:
                            https://preline.co/docs/toggle-password.html
                            Replaces the hand-rolled reveal. Preline owns the
                            input's type and the pressed state; the two icons
                            swap on hs-password-active, so nothing here has to
                            be rendered twice to survive a script that never
                            loaded.
                        -->
                        <div class="relative mt-2">
                            <input id="password" name="password" type="password" required
                                   class="h-12 w-full rounded-control border border-edge bg-card pe-12 ps-3
                                          font-mono text-base text-ink transition-colors
                                          duration-[var(--duration-micro)]
                                          hover:border-edge-strong focus:border-brand focus:outline-none
                                          focus:ring-2 focus:ring-brand/25">
                            <button type="button" data-hs-toggle-password='{"target": "#password"}'
                                    class="absolute inset-y-0 end-0 grid w-12 place-items-center
                                           rounded-e-control text-ink-subtle transition-colors
                                           duration-[var(--duration-micro)] hover:text-brand
                                           focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                                    aria-label="<?= e('login.show_password') ?>">
                                <svg class="hs-password-active:hidden h-5 w-5" viewBox="0 0 24 24" fill="none"
                                     stroke="currentColor" stroke-width="1.75" stroke-linecap="round"
                                     stroke-linejoin="round" aria-hidden="true">
                                    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/>
                                    <circle cx="12" cy="12" r="3"/>
                                </svg>
                                <svg class="hs-password-active:block hidden h-5 w-5" viewBox="0 0 24 24" fill="none"
                                     stroke="currentColor" stroke-width="1.75" stroke-linecap="round"
                                     stroke-linejoin="round" aria-hidden="true">
                                    <path d="M10.7 5.1A10.9 10.9 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-2.4 3.4"/>
                                    <path d="M6.6 6.6A18 18 0 0 0 2 12s3.6 7 10 7a10.7 10.7 0 0 0 5.4-1.4"/>
                                    <path d="m2 2 20 20"/>
                                </svg>
                            </button>
                        </div>

                        <!-- Caps Lock is the commonest reason a correct password
                             is rejected. Plain JS: one listener, and it is about
                             the keyboard rather than about a component. -->
                        <p id="am2-caps" hidden
                           class="mt-2 flex items-center gap-1.5 font-mono text-[11px] uppercase
                                  tracking-[0.15em] text-warn">
                            <span aria-hidden="true">⇪</span><?= e('login.caps_on') ?>
                        </p>
                    </div>

                    <div data-am2-field class="pt-1">
                        <button type="submit" id="am2-login-submit"
                                class="group flex h-12 w-full items-center justify-center gap-2
                                       rounded-control bg-brand px-4 font-mono text-[11px] font-semibold
                                       uppercase tracking-[0.2em] text-slate-950 transition-colors
                                       duration-[var(--duration-micro)] hover:bg-brand-hover
                                       focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60
                                       disabled:cursor-not-allowed disabled:opacity-60">
                            <span data-submit-label><?= e('login.submit') ?></span>
                            <span aria-hidden="true" data-submit-arrow
                                  class="transition-transform duration-[var(--duration-micro)]
                                         group-hover:translate-x-1">&rarr;</span>
                        </button>
                    </div>
                </form>

                <!--
                    Operator controls, inside the card. They were floating
                    underneath it, which left the card looking unfinished and
                    the page with three separate things to look at instead of
                    one. Same 44px targets as the shell behind this page.
                -->
                <div class="mt-7 flex items-center justify-between border-t border-edge pt-4">
                <div class="flex gap-1.5">
                    <?php foreach (AM2_LOCALES as $loc): $on = am2_locale() === $loc; ?>
                        <!-- important suffix: am2-ui.css styles bare anchors with
                             !important and would otherwise win the cascade. -->
                        <a href="?lang=<?= $loc ?>"
                           <?= $on ? 'aria-current="true"' : '' ?>
                           class="grid h-11 w-11 place-items-center rounded-control border no-underline!
                                  font-mono text-[11px] uppercase transition-colors
                                  duration-[var(--duration-micro)]
                                  <?= $on
                                      ? 'border-brand bg-brand/10 text-brand!'
                                      : 'border-edge text-ink-subtle! hover:border-brand hover:text-brand!' ?>">
                            <?= strtoupper($loc) ?>
                        </a>
                    <?php endforeach; ?>
                </div>

                <button type="button" id="themeToggle"
                        class="grid h-11 w-11 place-items-center rounded-control border border-edge
                               text-ink-subtle transition-colors duration-[var(--duration-micro)]
                               hover:border-brand hover:text-brand"
                        aria-pressed="<?= am2_theme() === 'dark' ? 'true' : 'false' ?>"
                        aria-label="<?= e('pref.theme') ?>" title="<?= e('pref.theme') ?>">
                    <span data-theme-icon="light" class="<?= am2_theme() === 'dark' ? 'hidden' : '' ?>">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
                             stroke-linecap="round" class="h-4 w-4" aria-hidden="true">
                            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
                        </svg>
                    </span>
                    <span data-theme-icon="dark" class="<?= am2_theme() === 'dark' ? '' : 'hidden' ?>">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
                             stroke-linecap="round" class="h-4 w-4" aria-hidden="true">
                            <circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/>
                            <path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/>
                            <path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>
                        </svg>
                    </span>
                </button>
                </div>
            </div>
        </div>
    </main>
</div>

<script src="<?= am2_asset('asset/js/am2-ui.min.js') ?>" defer></script>
<?php include 'partials/theme_toggle.php'; ?>

<script>
(() => {
    'use strict';

    /* Theme lives in partials/theme_toggle.php, included above -- it was a
     * second copy here and drifted from the shell's. */

    /* Caps Lock. */
    const caps = document.getElementById('am2-caps');
    document.getElementById('password')?.addEventListener('keyup', (e) => {
        if (!e.getModifierState) return;
        caps.hidden = !e.getModifierState('CapsLock');
    });

    /* Submit state. The button is disabled once the browser has accepted the
     * form, never on click: disabling earlier swallows the submit when a
     * required field is still empty. */
    const form = document.getElementById('am2-login-form');
    const submit = document.getElementById('am2-login-submit');
    form?.addEventListener('submit', () => {
        submit.disabled = true;
        submit.querySelector('[data-submit-label]').textContent = <?= json_encode(t('login.connecting')) ?>;
        submit.querySelector('[data-submit-arrow]').textContent = '…';
    });

    /* Motion. All of this is decoration in the strict sense — the page works
     * without it — so it waits for the bundle and does nothing if the bundle
     * never comes. */
    window.addEventListener('load', () => {
        const AM2 = window.AM2;
        if (!AM2) return;
        AM2.enterOnce('[data-am2-field]', document.getElementById('am2-login-card'));
        const err = document.getElementById('am2-login-error');
        if (err) AM2.toast(err);
        AM2.emit('[data-am2-ring]');
    });
})();
</script>
</body>
</html>
