<?php
session_start();
if (!isset($_SESSION['admin_logged_in'])) {
    header("Location: login.php");
    exit;
}
require_once 'config.php';

$message = "";

if ($_SERVER['REQUEST_METHOD'] == 'POST') {
    $id = $_POST['id'];
    $name = $_POST['name'];
    $password = $_POST['password'];
    $role = 'superadmin';

    try {
        $hashed_password = password_hash($password, PASSWORD_BCRYPT);

        $stmt = $pdo->prepare("INSERT INTO users (id, name, password, role, status) VALUES (?, ?, ?, ?, 'offline')");
        $stmt->execute([$id, $name, $hashed_password, $role]);
        
        $message = "<div class='alert alert-success'>Admin [$name] Berhasil Dibuat!</div>";
    } catch (PDOException $e) {
        $message = "<div class='alert alert-danger'>Gagal: " . $e->getMessage() . "</div>";
    }
}
?>

<!DOCTYPE html>
<html>
<head>
    <title>Tambah Super Admin - am²</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
    <link rel="stylesheet" href="asset/css/am2-ui.css">
</head>
<body class="legacy-page bg-light">

<nav class="navbar navbar-expand-lg navbar-dark bg-dark mb-4 legacy-navbar">
    <div class="container">
        <a class="navbar-brand" href="#">am² PANEL</a>
        <div class="navbar-nav">
            <a class="nav-link" href="users.php">Kelola User</a>
            <a class="nav-link" href="channels.php">Kelola Channel</a>
            <a class="nav-link active" href="create_admin.php">Tambah Admin</a>
            <a class="nav-link text-danger" href="logout.php">Logout</a>
        </div>
    </div>
</nav>

<div class="container helper-shell">
    <div class="row justify-content-center">
        <div class="col-md-6">
            <div class="card shadow">
                <div class="card-header bg-primary text-white helper-card-header">
                    <h5 class="mb-0">Registrasi Super Admin Baru</h5>
                </div>
                <div class="card-body">
                    <?= $message ?>
                    <form method="POST">
                        <div class="mb-3">
                            <label class="form-label">ID User (Unique)</label>
                            <input type="text" name="id" class="form-control" placeholder="Contoh: 001" required>
                            <small class="text-muted">ID ini harus berbeda dari user biasa.</small>
                        </div>
                        <div class="mb-3">
                            <label class="form-label">Nama Admin (Username Login)</label>
                            <input type="text" name="name" class="form-control" placeholder="Contoh: admin_pusat" required>
                        </div>
                        <div class="mb-3">
                            <label class="form-label">Password</label>
                            <input type="password" name="password" class="form-control" placeholder="Masukkan password kuat" required>
                        </div>
                        <hr>
                        <button type="submit" class="btn btn-primary w-100">Daftarkan Super Admin</button>
                    </form>
                </div>
            </div>
            
            <div class="mt-4">
                <h6 class="helper-title">Daftar Admin Saat Ini:</h6>
                <ul class="list-group">
                    <?php
                    $stmt = $pdo->query("SELECT name FROM users WHERE role = 'superadmin'");
                    while ($row = $stmt->fetch()) {
                        echo "<li class='list-group-item d-flex justify-content-between align-items-center'>
                                " . htmlspecialchars($row['name']) . "
                                <span class='badge bg-info'>Superadmin</span>
                              </li>";
                    }
                    ?>
                </ul>
            </div>
        </div>
    </div>
</div>

</body>
</html>
