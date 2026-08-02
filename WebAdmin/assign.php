<?php
session_start();
if (!isset($_SESSION['admin_logged_in'])) { header("Location: login.php"); exit; }
include 'config.php';

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['assign'])) {
    $user_id = $_POST['user_id'];
    $channel_id = $_POST['channel_id'];
    $is_rx = isset($_POST['is_rx']) ? 'true' : 'false';

    try {
        $stmt = $pdo->prepare("INSERT INTO user_channels (user_id, channel_id, is_rx_only) VALUES (?, ?, ?) 
                               ON CONFLICT (user_id, channel_id) DO UPDATE SET is_rx_only = EXCLUDED.is_rx_only");
        $stmt->execute([$user_id, $channel_id, $is_rx]);
        $msg = "<div class='alert alert-success'>Akses Berhasil Diperbarui!</div>";
    } catch (Exception $e) { $msg = "<div class='alert alert-danger'>Error: " . $e->getMessage() . "</div>"; }
}

$users = $pdo->query("SELECT id, name FROM users ORDER BY name ASC")->fetchAll();
$channels = $pdo->query("SELECT id, name FROM channels ORDER BY name ASC")->fetchAll();
?>

<!DOCTYPE html>
<html>
<head>
    <title>Assign Channel - am²</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
    <link rel="stylesheet" href="asset/css/am2-ui.css">
</head>
<body class="legacy-page bg-light">
<nav class="navbar navbar-expand-lg navbar-dark bg-dark mb-4 legacy-navbar">
    <div class="container">
        <a class="navbar-brand" href="#">am² PANEL</a>
        <div class="navbar-nav">
            <a class="nav-link" href="users.php">User</a>
            <a class="nav-link" href="channels.php">Channel</a>
            <a class="nav-link active" href="assign.php">Plotting Anggota</a>
            <a class="nav-link text-danger" href="logout.php">Logout</a>
        </div>
    </div>
</nav>

<div class="container helper-shell">
    <div class="row">
        <div class="col-md-4">
            <div class="card p-4 shadow toolbar-card">
                <h5 class="helper-title">Plotting Anggota ke Channel</h5>
                <?= $msg ?? '' ?>
                <form method="POST">
                    <div class="mb-3">
                        <label>Pilih User</label>
                        <select name="user_id" class="form-select">
                            <?php foreach($users as $u) echo "<option value='{$u['id']}'>{$u['name']} (ID: {$u['id']})</option>"; ?>
                        </select>
                    </div>
                    <div class="mb-3">
                        <label>Pilih Channel</label>
                        <select name="channel_id" class="form-select">
                            <?php foreach($channels as $c) echo "<option value='{$c['id']}'>{$c['name']}</option>"; ?>
                        </select>
                    </div>
                    <div class="form-check mb-3">
                        <input type="checkbox" name="is_rx" class="form-check-input" id="rx">
                        <label class="form-check-label" for="rx">Hanya Dengar (RX Only)</label>
                    </div>
                    <button type="submit" name="assign" class="btn btn-primary w-100">Berikan Akses</button>
                </form>
            </div>
        </div>
        
        <div class="col-md-8 mt-4 mt-md-0">
            <div class="card p-4 shadow">
                <h5 class="helper-title">Daftar Akses Saat Ini</h5>
                <table class="table table-striped mt-2 data-table">
                    <thead><tr><th>Nama</th><th>Channel</th><th>Mode</th></tr></thead>
                    <tbody>
                        <?php
                        $list = $pdo->query("SELECT u.name as uname, c.name as cname, uc.is_rx_only 
                                             FROM user_channels uc 
                                             JOIN users u ON uc.user_id = u.id 
                                             JOIN channels c ON uc.channel_id = c.id")->fetchAll();
                        foreach($list as $l) {
                            $mode = $l['is_rx_only'] ? '<span class="badge bg-warning">RX Only</span>' : '<span class="badge bg-success">TX/RX (Bisa Bicara)</span>';
                            echo "<tr><td data-label='Nama'>{$l['uname']}</td><td data-label='Channel'>{$l['cname']}</td><td data-label='Mode'>$mode</td></tr>";
                        }
                        ?>
                    </tbody>
                </table>
            </div>
        </div>
    </div>
</div>
</body>
</html>
