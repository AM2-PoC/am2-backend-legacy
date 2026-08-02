<?php
require_once 'auth.php';
date_default_timezone_set('Asia/Jakarta');

require_once 'config.php';



?>

<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Log Aktivitas - am²</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="asset/css/am2-ui.css">
    <style>
        body { background-color: var(--color-bg); font-family: 'Segoe UI', system-ui, sans-serif; }
        .main-content { padding: 20px; transition: all 0.3s; }
        .card-custom { background: var(--color-surface); border-radius: 12px; box-shadow: var(--am2-shadow-sm); border: 1px solid var(--color-border); position: relative; overflow: hidden; }
        .card-custom::before { content: ""; position: absolute; top: 0; left: 0; width: 100%; height: 4px; background: linear-gradient(90deg, var(--color-sidebar-bg), var(--color-primary)); z-index: 10; }
        .header-title { font-weight: 800; color: var(--color-text); border-left: 4px solid var(--color-primary); padding-left: 12px; text-transform: uppercase; font-size: 1.1rem; }
        .filter-btn { font-size: 10px; font-weight: 700; padding: 6px 14px; border-radius: 15px; cursor: pointer; border: 1px solid var(--color-border-strong); background: var(--color-surface); color: var(--color-text-muted); }
        .filter-btn.active { background: var(--color-primary); color: var(--color-on-primary); border-color: var(--color-primary); }
        .table thead th { background-color: var(--color-surface-muted); color: var(--color-text-muted); font-size: 11px; text-transform: uppercase; font-weight: 700; padding: 15px; border-bottom: 2px solid var(--color-border); }
        #loading-indicator { font-size: 10px; font-weight: 800; color: var(--color-on-primary); display: none; background: var(--color-primary); padding: 5px 14px; border-radius: 20px; }
        .refresh-btn { font-weight: 700; font-size: 11px; background: var(--color-surface); border: 1px solid var(--color-border-strong); color: var(--color-text); padding: 8px 16px; }

    </style>
</head>
<body>

<div class="container-fluid">
    <div class="row">
        <?php include 'sidebar.php'; ?>

        <main class="col-md-9 ms-sm-auto col-lg-10 main-content">
            <div class="row g-3 g-md-4 mb-4">
                <div class="col-12">
                    <div class="app-toolbar am2-page-hero d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-3">
                        <div>
                            <h4 class="header-title mb-1">Monitoring Konsol Log</h4>
                            <span id="last-update-time" class="small am2-hero-subtext fw-bold"><i class="far fa-clock me-1"></i> Menghubungkan...</span>
                        </div>
                        <div class="am2-hero-actions">
                            <span id="loading-indicator"><i class="fas fa-satellite-dish pulse-live me-1"></i> SYNC</span>
                            <button onclick="manualRefresh()" class="btn refresh-btn rounded-pill shadow-sm am2-hero-action"><i class="fas fa-sync-alt me-1 text-warning"></i> REFRESH</button>
                        </div>
                    </div>
                </div>
            </div>

            <div class="row g-3 g-md-4 mb-4">
                <div class="col-12">
                    <div class="card card-custom toolbar-card p-3">
                        <div class="row g-2">
                            <div class="col-12 col-md-4">
                                <input type="text" id="logSearchInput" class="form-control" placeholder="Cari..." onkeyup="applyFilters()">
                            </div>
                            <div class="col-12 col-md-8 d-flex align-items-center gap-2 overflow-auto">
                                <span class="small fw-bold text-muted">FILTER:</span>
                                <div class="filter-btn active" id="btn-all" onclick="setCategory('ALL')">SEMUA</div>
                                <div class="filter-btn" id="btn-ptt" onclick="setCategory('PTT')">USER PTT</div>
                                <div class="filter-btn" id="btn-adm" onclick="setCategory('ADM')">ADMIN</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="row g-3 g-md-4 mb-4">
                <div class="col-12">
                    <div class="card-custom">
                        <div class="table-responsive">
                            <table class="table table-hover align-middle mb-0 data-table" id="main-log-table">
                        <thead>
                            <tr>
                                <th style="width: 15%;">Waktu</th>
                                <th style="width: 25%;">Pelaksana</th>
                                <th style="width: 35%;">Detail Informasi</th>
                                <th style="width: 25%; text-align: right;" class="pe-4">Status</th>
                            </tr>
                        </thead>
                        <tbody id="log-table-body">
                            <tr><td data-label="" colspan="4" class="text-center py-5"><div class="spinner-border spinner-border-sm text-primary"></div></td></tr>
                        </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        </main>
    </div>
</div>

<script>
    let isFetching = false;
    let currentCategory = "ALL";
    let lastAdminId = "";
    let lastPttId = "";
    let cachedAdminData = [];
    let cachedPttData = [];

    // keterangan is free text written by admins and by a database trigger.
    // It was interpolated into a template literal and inserted with innerHTML.
    function esc(v) {
        return String(v ?? '').replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function renderLogHTML(log) {
        const type = log.aksi.toUpperCase();
        const isAdm = log.kategori === 'ADM';
        const rowClass = isAdm ? 'is-admin-log' : 'is-ptt-log';
        const icon = isAdm ? 'fa-user-shield text-warning' : 'fa-user text-primary';

        let badgeClass = "bg-light text-dark border";
        let badgeText = type;

        if (['PUSH', 'TX', 'START', 'PTT_ON'].includes(type)) {
            badgeClass = "bg-danger text-white"; badgeText = "TX / ON";
        } else if (type === 'LOGIN') {
            badgeClass = "bg-success text-white"; badgeText = "ONLINE";
        } else if (type.includes('CREATE')) {
            badgeClass = "bg-success text-white"; badgeText = "BARU";
        }

        return `<tr class="${rowClass}">
            <td data-label="Waktu">
                <div class="fw-bold text-dark log-time">${esc(log.jam)}</div>
                <div class="text-muted log-meta">${esc(log.tanggal)}</div>
            </td>
            <td data-label="Pelaksana">
                <div class="fw-bold text-uppercase log-actor"><i class="fas ${icon} me-1"></i>${esc(log.pelaksana)}</div>
                <code class="text-muted log-meta">ID: ${esc(log.pelaksana_id)}</code>
            </td>
            <td data-label="Aktivitas">
                <div class="text-dark fw-medium log-detail">
                    ${isAdm ? '<i class="fas fa-info-circle me-1 text-primary"></i>' : '<i class="fas fa-satellite-dish me-1 text-muted"></i>'}
                    ${esc(log.target)}
                </div>
            </td>
            <td data-label="Status" class="text-end pe-4">
                <span class="badge ${badgeClass} log-status-badge">${badgeText}</span>
            </td>
        </tr>`;
    }

    function loadLogs() {
        if (isFetching) return;
        isFetching = true;
        document.getElementById('loading-indicator').style.display = 'inline-block';
        
        fetch('fetch_logs.php')
        .then(res => res.json())
        .then(data => {
            if(data.error) return;

            const currentNewestAdminId = data.adm.length > 0 ? data.adm[0].id : "";
            const currentNewestPttId = data.ptt.length > 0 ? data.ptt[0].id : "";

            let needsUpdate = false;

            if (currentNewestAdminId !== lastAdminId) {
                cachedAdminData = data.adm;
                lastAdminId = currentNewestAdminId;
                needsUpdate = true;
            }

            if (currentNewestPttId !== lastPttId) {
                cachedPttData = data.ptt;
                lastPttId = currentNewestPttId;
                needsUpdate = true;
            }

            if (needsUpdate) {
                updateTableUI();
            }

            document.getElementById('last-update-time').innerHTML = `<i class="fas fa-check-circle text-success me-1"></i> Terkoneksi: ${new Date().toLocaleTimeString()} WIB`;
        })
        .finally(() => {
            isFetching = false;
            setTimeout(() => { document.getElementById('loading-indicator').style.display = 'none'; }, 500);
        });
    }

    function updateTableUI() {
        const tableBody = document.getElementById('log-table-body');
        let displayData = [];

        if (currentCategory === "ADM") {
            displayData = cachedAdminData;
        } else if (currentCategory === "PTT") {
            displayData = cachedPttData;
        } else {
            displayData = [...cachedAdminData, ...cachedPttData];
            displayData.sort((a, b) => new Date(b.raw_time) - new Date(a.raw_time));
        }

        if (displayData.length === 0) {
                tableBody.innerHTML = '<tr><td data-label="" colspan="4" class="text-center py-5 text-muted">Belum ada aktivitas.</td></tr>';
        } else {
            tableBody.innerHTML = displayData.slice(0, 100).map(log => renderLogHTML(log)).join('');
        }
        applyFilters();
    }

    function applyFilters() {
        const search = document.getElementById("logSearchInput").value.toUpperCase();
        const rows = document.querySelectorAll("#log-table-body tr");
        rows.forEach(row => {
            if(row.cells.length < 3) return;
            row.style.display = row.innerText.toUpperCase().includes(search) ? "" : "none";
        });
    }

    function setCategory(cat) {
        currentCategory = cat;
        document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
        document.getElementById('btn-' + cat.toLowerCase()).classList.add('active');
        updateTableUI();
    }

    function manualRefresh() { lastAdminId = ""; lastPttId = ""; loadLogs(); }
    setInterval(loadLogs, 4000);
    document.addEventListener('DOMContentLoaded', loadLogs);
</script>
</body>
</html>
