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

    try {
        $stmt = $pdo->prepare("SELECT id, username, password_hash, role, status FROM public.admin WHERE username = ?");
        $stmt->execute([$username]);
        $user = $stmt->fetch();

        if ($user && password_verify($password, $user['password_hash'])) {
            if ($user['status'] !== 'active') {
                $error = "Akun Anda sedang dinonaktifkan.";
            } else {
                $_SESSION['admin_logged_in'] = true;
                $_SESSION['admin_id']        = $user['id'];
                $_SESSION['admin_username']  = $user['username'];
                $_SESSION['admin_role']      = $user['role'];
                
                header("Location: dashboard.php");
                exit;
            }
        } else {
            $error = "Akses Ditolak: Username atau Password salah.";
        }
    } catch (PDOException $e) {
        $error = "Terjadi kesalahan sistem.";
    }
}
?>

<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Login - am²</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="asset/css/am2-ui.css">
    <style>
        body.login-page {
            --login-bg-deep: #08111f;
            --login-bg-mid: #123047;
            --login-accent: #14b8a6;
            --login-accent-strong: #0f766e;
            --login-accent-soft: #ccfbf1;
            --login-violet: #6366f1;
            --login-ink: #0f172a;
            --login-muted: #64748b;
            --login-line: #dbeafe;
            background:
                radial-gradient(circle at 14% 16%, rgba(20, 184, 166, 0.34), transparent 28rem),
                radial-gradient(circle at 88% 12%, rgba(99, 102, 241, 0.32), transparent 24rem),
                linear-gradient(145deg, var(--login-bg-deep) 0%, var(--login-bg-mid) 52%, #0f172a 100%) !important;
            color: var(--login-ink);
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            margin: 0;
            min-height: 100vh;
            min-height: 100dvh;
            overflow-x: hidden;
            padding: clamp(16px, 4vw, 40px);
        }

        .login-card {
            background: rgba(255, 255, 255, 0.96) !important;
            border: 1px solid rgba(255, 255, 255, 0.55) !important;
            border-radius: 28px !important;
            box-shadow: 0 28px 80px rgba(2, 6, 23, 0.38) !important;
            display: grid;
            grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
            max-width: 920px;
            min-height: 560px;
            overflow: hidden;
            width: 100%;
            animation: fadeIn 0.6s ease-out;
        }

        .login-page .container {
            max-width: 980px;
            padding-left: 0;
            padding-right: 0;
        }

        .login-page .row {
            --bs-gutter-x: 0;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .login-header {
            background:
                linear-gradient(160deg, rgba(8, 17, 31, 0.94), rgba(15, 118, 110, 0.88)),
                radial-gradient(circle at 20% 18%, rgba(204, 251, 241, 0.16), transparent 15rem);
            border-bottom: 0 !important;
            color: #ffffff;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            padding: clamp(28px, 5vw, 44px);
            position: relative;
            text-align: left;
        }

        .login-header::after {
            background: linear-gradient(135deg, rgba(255,255,255,0.18), rgba(255,255,255,0.02));
            border: 1px solid rgba(255,255,255,0.18);
            border-radius: 999px;
            content: "";
            height: 170px;
            position: absolute;
            right: -78px;
            top: -64px;
            width: 170px;
        }

        .brand-block {
            position: relative;
            z-index: 1;
        }

        .login-eyebrow {
            align-items: center;
            background: rgba(204, 251, 241, 0.12);
            border: 1px solid rgba(204, 251, 241, 0.22);
            border-radius: 999px;
            color: #ccfbf1;
            display: inline-flex;
            font-size: 0.72rem;
            font-weight: 800;
            gap: 8px;
            letter-spacing: 0.08em;
            margin-bottom: 18px;
            padding: 7px 12px;
            text-transform: uppercase;
        }

        .logo-am2 {
            border: 1px solid rgba(255,255,255,0.28);
            border-radius: 22px;
            box-shadow: 0 16px 36px rgba(2, 6, 23, 0.35);
            height: 76px;
            margin-bottom: 22px;
            object-fit: cover;
            width: 76px;
        }

        .am2-text {
            font-size: clamp(2rem, 6vw, 3.4rem);
            font-weight: 800;
            letter-spacing: 0;
            line-height: 1;
            margin: 0;
            text-shadow: 0 10px 30px rgba(0,0,0,0.3);
        }

        .login-subtitle {
            color: rgba(255,255,255,0.78);
            font-size: 0.96rem;
            line-height: 1.6;
            margin: 18px 0 0;
            max-width: 300px;
        }

        .security-list {
            display: grid;
            gap: 10px;
            margin: 32px 0 0;
            padding: 0;
            position: relative;
            z-index: 1;
        }

        .security-list span {
            align-items: center;
            color: rgba(255,255,255,0.82);
            display: inline-flex;
            font-size: 0.82rem;
            gap: 10px;
        }

        .security-list i {
            color: #5eead4;
            width: 16px;
        }

        .login-form-panel {
            display: flex;
            flex-direction: column;
            justify-content: center;
            padding: clamp(28px, 6vw, 56px);
        }

        .form-heading {
            margin-bottom: 26px;
        }

        .form-heading h1 {
            color: var(--login-ink);
            font-size: clamp(1.6rem, 4vw, 2.25rem);
            font-weight: 800;
            letter-spacing: 0;
            line-height: 1.12;
            margin: 0;
        }

        .form-heading p {
            color: var(--login-muted);
            font-size: 0.95rem;
            line-height: 1.55;
            margin: 10px 0 0;
        }

        .form-label {
            color: #334155;
            letter-spacing: 0.04em;
            margin-bottom: 8px;
        }

        .input-group-text {
            background-color: #f8fafc !important;
            border: 1px solid var(--login-line) !important;
            border-right: none;
            color: var(--login-accent-strong);
            justify-content: center;
            width: 48px;
        }

        .form-control {
            background-color: #f8fafc !important;
            border: 1px solid var(--login-line) !important;
            border-left: none;
            color: var(--login-ink);
            font-size: 16px !important;
            min-height: 52px;
            padding: 13px 15px;
        }

        .form-control::placeholder {
            color: #94a3b8;
        }

        .form-control:focus {
            background-color: #ffffff !important;
            border-color: rgba(20, 184, 166, 0.72) !important;
            box-shadow: 0 0 0 4px rgba(20, 184, 166, 0.14);
        }

        .input-group:focus-within {
            box-shadow: 0 14px 30px rgba(15, 23, 42, 0.08);
        }

        .btn-toggle-pwd {
            background: #f8fafc !important;
            border: 1px solid var(--login-line) !important;
            border-left: none;
            color: var(--login-muted);
            padding: 0 15px;
        }

        .btn-toggle-pwd:hover {
            color: var(--login-accent-strong);
        }

        .btn-am2 {
            background: linear-gradient(135deg, var(--login-accent) 0%, var(--login-violet) 100%);
            border: none;
            border-radius: 16px;
            box-shadow: 0 18px 34px rgba(20, 184, 166, 0.24);
            color: white;
            font-weight: 800;
            letter-spacing: 1px;
            margin-top: 6px;
            min-height: 52px;
            padding: 14px;
            transition: transform 0.2s ease, box-shadow 0.2s ease, filter 0.2s ease;
        }

        .btn-am2:hover {
            color: white;
            filter: saturate(1.08);
            transform: translateY(-2px);
            box-shadow: 0 22px 40px rgba(99, 102, 241, 0.24);
        }

        .btn-am2:active {
            transform: translateY(0);
        }

        .alert-danger {
            background: #fff1f2;
            border: 1px solid #fecdd3 !important;
            color: #9f1239;
        }

        .footer-text {
            color: rgba(255,255,255,0.78);
            font-size: 0.76rem;
            line-height: 1.6;
            margin-top: 22px;
            text-align: center;
        }

        .version-pill {
            background: rgba(255,255,255,0.12);
            border: 1px solid rgba(255,255,255,0.16);
            color: rgba(255,255,255,0.86);
        }

        @media (max-width: 767.98px) {
            body.login-page {
                align-items: center;
                padding: 12px;
            }

            .login-card {
                border-radius: 22px !important;
                grid-template-columns: 1fr;
                margin: auto;
                max-width: 430px;
                min-height: 0;
            }

            .login-header {
                align-items: center;
                justify-content: center;
                min-height: 198px;
                padding: 24px;
                text-align: center;
            }

            .login-header::after {
                height: 118px;
                right: -52px;
                top: -46px;
                width: 118px;
            }

            .security-list {
                display: none;
            }

            .login-eyebrow {
                font-size: 0.66rem;
                margin-bottom: 14px;
                padding: 6px 10px;
            }

            .brand-block {
                align-items: center;
                display: flex;
                flex-direction: column;
                max-width: 320px;
            }

            .logo-am2 {
                border-radius: 18px;
                height: 58px;
                margin-bottom: 14px;
                width: 58px;
            }

            .am2-text {
                font-size: 2rem;
            }

            .login-subtitle {
                font-size: 0.88rem;
                line-height: 1.45;
                margin-top: 10px;
                max-width: 280px;
            }

            .login-form-panel {
                padding: 24px 20px 26px;
            }

            .form-heading {
                margin-bottom: 20px;
                text-align: center;
            }

            .form-heading h1 {
                font-size: 1.55rem;
            }

            .form-heading p {
                font-size: 0.88rem;
                line-height: 1.45;
            }

            .login-form-panel .mb-4 {
                margin-bottom: 1rem !important;
            }

            .input-group-text {
                width: 44px;
            }

            .form-control,
            .btn-am2 {
                min-height: 48px;
            }
        }

        @media (max-width: 390px) {
            body.login-page {
                padding: 10px;
            }

            .login-card {
                border-radius: 18px !important;
            }

            .login-header {
                min-height: 172px;
                padding: 20px;
            }

            .login-eyebrow {
                font-size: 0.62rem;
                gap: 6px;
                margin-bottom: 12px;
            }

            .logo-am2 {
                height: 50px;
                margin-bottom: 12px;
                width: 50px;
            }

            .am2-text {
                font-size: 1.75rem;
            }

            .login-subtitle {
                font-size: 0.8rem;
                line-height: 1.4;
            }

            .login-form-panel {
                padding: 20px 16px 22px;
            }

            .form-heading {
                margin-bottom: 16px;
            }

            .form-heading h1 {
                font-size: 1.35rem;
            }

            .form-heading p {
                font-size: 0.82rem;
                margin-top: 6px;
            }

            .form-label {
                font-size: 0.68rem;
            }

            .form-control {
                padding-left: 12px;
                padding-right: 12px;
            }

            .btn-toggle-pwd {
                padding-left: 12px;
                padding-right: 12px;
            }

            .footer-text {
                margin-top: 14px;
            }
        }

        @media (max-width: 340px) {
            .login-header {
                min-height: 148px;
                padding: 18px;
            }

            .login-subtitle {
                display: none;
            }

            .login-form-panel {
                padding: 20px 14px;
            }
        }
    </style>
</head>
<body class="login-page">
    <div class="container">
        <div class="row justify-content-center">
            <div class="col-12 d-flex flex-column align-items-center">
                
                <div class="card login-card">
                    <div class="login-header">
                        <div class="brand-block">
                            <span class="login-eyebrow"><i class="fas fa-shield-halved"></i> Admin Access</span>
                            <img src="asset/image/logo.jpeg" alt="Logo am²" class="logo-am2">
                            <h5 class="am2-text">am²</h5>
                            <p class="login-subtitle">Secure control center for monitoring, channels, users, and operational access.</p>
                        </div>
                        <div class="security-list" aria-label="Security features">
                            <span><i class="fas fa-lock"></i> Protected admin session</span>
                            <span><i class="fas fa-network-wired"></i> Infrastructure operations</span>
                            <span><i class="fas fa-user-check"></i> Role-based console access</span>
                        </div>
                    </div>
                    
                    <div class="login-form-panel">
                        <div class="form-heading">
                            <h1>Welcome back</h1>
                            <p>Sign in with your administrator credentials to continue.</p>
                        </div>

                        <?php if($error !== ""): ?>
                            <div class="alert alert-danger py-3 shadow-sm mb-4 border-0 rounded-3" role="alert" style="font-size: 0.85rem;">
                                <i class="fas fa-exclamation-triangle me-2"></i> <?= htmlspecialchars($error) ?>
                            </div>
                        <?php endif; ?>

                        <form method="POST" autocomplete="off">
                            <div class="mb-4">
                                <label class="form-label small fw-bold text-uppercase">Username</label>
                                <div class="input-group shadow-sm rounded-3 overflow-hidden">
                                    <span class="input-group-text border-0"><i class="fas fa-user-shield"></i></span>
                                    <input type="text" name="username" class="form-control border-0" placeholder="Masukkan username" required autofocus>
                                </div>
                            </div>
                            
                            <div class="mb-4">
                                <label class="form-label small fw-bold text-uppercase">Kata Sandi</label>
                                <div class="input-group shadow-sm rounded-3 overflow-hidden">
                                    <span class="input-group-text border-0"><i class="fas fa-key"></i></span>
                                    <input type="password" name="password" id="password" class="form-control border-0" placeholder="Masukkan kata sandi" required>
                                    <button class="btn btn-toggle-pwd border-0" type="button" id="togglePassword" aria-label="Tampilkan password" aria-pressed="false">
                                        <i class="fas fa-eye" id="eyeIcon"></i>
                                    </button>
                                </div>
                            </div>

                            <button type="submit" class="btn btn-am2 w-100 shadow">
                                <i class="fas fa-arrow-right-to-bracket me-2"></i> Login
                            </button>
                        </form>
                    </div>
                </div>

                <div class="footer-text">
                    <p class="mb-0 fw-bold">&copy; 2026 am²</p>
                    <span class="opacity-75">Secure Infrastructure & Communication Access</span><br>
                    <span class="badge version-pill mt-2 px-3 py-2">v1.0.0 Mobile Optimized</span>
                </div>

            </div>
        </div>
    </div>

    <script>
        const togglePassword = document.querySelector('#togglePassword');
        const passwordInput = document.querySelector('#password');
        const eyeIcon = document.querySelector('#eyeIcon');

        togglePassword.addEventListener('click', function () {
            const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
            passwordInput.setAttribute('type', type);
            eyeIcon.classList.toggle('fa-eye');
            eyeIcon.classList.toggle('fa-eye-slash');
            const isVisible = type === 'text';
            togglePassword.setAttribute('aria-pressed', isVisible ? 'true' : 'false');
            togglePassword.setAttribute('aria-label', isVisible ? 'Sembunyikan password' : 'Tampilkan password');
        });
    </script>
</body>
</html>
