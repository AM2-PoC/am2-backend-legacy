<?php
require_once 'config.php';
session_start();

if (!isset($_SESSION['admin_logged_in'])) {
    header("Location: login.php");
    exit;
}

$pageTitle = "LIVE TRACKING UNIT";
?>

<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title><?= $pageTitle ?> | am²</title>

    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="asset/css/am2-ui.css">
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />

    <style>
        body { background-color: var(--color-bg); font-family: 'Segoe UI', sans-serif; margin: 0; padding: 0; overflow: hidden; }

        .main-content {
            position: relative;
            height: 100vh;
            overflow: hidden;
            padding: 0 !important;
            transition: margin-left 0.3s ease;
            background: var(--color-map-bg);
        }

        #map { width: 100%; height: 100%; z-index: 1; }

        .map-overlay-panel {
            position: absolute; top: 20px; right: 20px; z-index: 1000;
            width: 310px; max-height: calc(100vh - 60px);
            background: color-mix(in srgb, var(--color-surface) 94%, transparent); backdrop-filter: blur(10px);
            border-radius: 18px; box-shadow: 0 10px 35px rgba(var(--shadow-color),0.2);
            display: flex; flex-direction: column; border: 1px solid var(--color-border);
            overflow: hidden; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .panel-header {
            background: var(--color-sidebar-bg); color: var(--color-sidebar-hover-text);
            padding: 15px; border-bottom: 3px solid var(--color-primary);
            font-size: 0.7rem; font-weight: 800; display: flex;
            justify-content: space-between; align-items: center;
            text-transform: uppercase; letter-spacing: 1px;
        }

        .unit-list { overflow-y: auto; flex-grow: 1; padding: 10px; scrollbar-width: thin; display: flex; flex-direction: column; }
        
        .unit-item {
            padding: 12px 15px; border-radius: 12px; margin-bottom: 8px;
            cursor: pointer; transition: all 0.2s ease; background: var(--color-surface);
            border: 1px solid var(--color-border); display: flex; align-items: center;
            position: relative;
        }
        
        .unit-item.speaking-active {
            border: 2px solid var(--color-danger);
            background: var(--color-danger-surface);
            box-shadow: 0 4px 12px color-mix(in srgb, var(--color-danger) 22%, transparent);
            order: -1;
        }

        .unit-item:hover { transform: translateY(-2px); border-color: var(--color-primary); box-shadow: var(--am2-shadow-sm); }

        .custom-marker { display: flex; flex-direction: column; align-items: center; transition: all 0.3s; }
        .marker-label {
            background: var(--color-sidebar-bg); color: var(--color-sidebar-hover-text); padding: 3px 10px;
            border-radius: 20px; font-size: 10px; font-weight: 700;
            border: 1.5px solid var(--color-primary); white-space: nowrap; margin-bottom: 5px;
            box-shadow: 0 4px 10px rgba(var(--shadow-color),0.3); pointer-events: none;
        }
        
        .pulse-dot {
            width: 14px; height: 14px; border: 2.5px solid var(--color-surface);
            border-radius: 50%; background: var(--color-success);
            box-shadow: 0 0 8px rgba(var(--shadow-color),0.3);
        }

        .speaking-marker .pulse-dot {
            background: var(--color-danger) !important;
            width: 18px; height: 18px;
            animation: pulse-red-map 1s infinite;
        }
        .speaking-marker .marker-label {
            background: var(--color-danger); border-color: var(--color-surface);
            box-shadow: 0 0 15px color-mix(in srgb, var(--color-danger) 45%, transparent);
        }

        @keyframes pulse-red-map {
            0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-danger) 70%, transparent); transform: scale(1); }
            70% { box-shadow: 0 0 0 15px transparent; transform: scale(1.1); }
            100% { box-shadow: 0 0 0 0 transparent; transform: scale(1); }
        }

        .btn-reset-view {
            width: 45px; height: 45px; background: var(--color-surface); border-radius: 12px;
            position: absolute; right: 20px; bottom: 40px; z-index: 1000;
            display: flex; align-items: center; justify-content: center;
            box-shadow: var(--am2-shadow); border: 1px solid var(--color-border); cursor: pointer;
            color: var(--color-text); transition: 0.2s;
        }
        .btn-reset-view:hover { background: var(--color-primary); color: var(--color-on-primary); }

        .btn-toggle-panel {
            position: absolute;
            top: 20px;
            right: 20px;
            z-index: 1000;
            background: var(--color-sidebar-bg);
            color: var(--color-sidebar-hover-text);
            border: 2px solid var(--color-primary);
            border-radius: 12px;
            padding: 10px;
            box-shadow: var(--am2-shadow);
        }

        @keyframes flash-text { from { opacity: 1; } to { opacity: 0.5; } }
        .tx-badge-anim { animation: flash-text 0.6s infinite alternate; font-weight: 800; font-size: 9px; }

        @media (max-width: 992px) {
            .map-overlay-panel {
                width: min(280px, calc(100vw - 24px));
                max-height: calc(100dvh - 84px);
                top: 80px;
                right: -320px;
            }
            .map-overlay-panel.show { right: 12px; }
        }

        @media (max-width: 767.98px) {
            .btn-toggle-panel {
                top: calc(var(--mobile-navbar-height) + 12px);
                right: 12px;
            }
            .map-overlay-panel {
                max-height: calc(100dvh - var(--mobile-navbar-height) - 84px);
                top: calc(var(--mobile-navbar-height) + 64px);
            }
        }
    </style>
</head>
<body class="map-page">

<?php include 'sidebar.php'; ?>

<main class="main-content">
    <div id="map"></div>

    <button type="button" class="btn-toggle-panel d-lg-none" id="panelToggle" aria-label="Toggle monitoring unit panel" aria-expanded="false">
        <i class="fas fa-users"></i>
    </button>
    
    <button class="btn-reset-view" onclick="resetMap()" title="Reset View">
        <i class="fas fa-expand-arrows-alt"></i>
    </button>

    <div class="map-overlay-panel choice-list" id="unitPanel">
        <div class="panel-header">
            <span><i class="fas fa-satellite-dish me-2 text-warning"></i> Monitoring Unit</span>
            <span class="badge bg-danger tx-badge-anim" id="tx-indicator" style="display:none;">TX AKTIF</span>
        </div>

        <div class="p-2 bg-light border-bottom">
            <div class="input-group input-group-sm">
                <span class="input-group-text bg-white border-0"><i class="fas fa-search text-muted"></i></span>
                <input type="text" id="unitSearch" class="form-control border-0 shadow-none" placeholder="Cari User..." onkeyup="renderList()">
            </div>
        </div>

        <div id="unitList" class="unit-list">
             </div>

        <div class="p-2 px-3 bg-white border-top d-flex justify-content-between align-items-center">
            <small class="text-muted fw-bold" style="font-size: 10px;"><span id="count-online">0</span> Online</small>
            <small class="text-muted" style="font-size: 9px; font-weight: 700;">am²</small>
        </div>
    </div>
</main>

<script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
    var map = L.map('map', { zoomControl: false, attributionControl: false }).setView([-2.5, 118], 5);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png').addTo(map);

    var markers = {};
    var userCache = [];

    function syncData() {
        $.getJSON('get-users-ajax.php', function(data) {
            if (!data || data.error) return;
            
            userCache = data;
            updateMarkers();
            renderList();
        });
    }

    function updateMarkers() {
        let activeIds = userCache.map(u => u.id.toString());
        let txFound = false;

        userCache.forEach(user => {
            const uid = user.id.toString();
            const lat = parseFloat(user.lat);
            const lng = parseFloat(user.lng);
            
            if (isNaN(lat) || lat === 0) return;

            const isSpeaking = parseInt(user.is_speaking) === 1;
            if(isSpeaking) txFound = true;

            const icon = L.divIcon({
                className: isSpeaking ? 'custom-marker speaking-marker' : 'custom-marker',
                html: `<div class="marker-label">${user.name}</div><div class="pulse-dot"></div>`,
                iconSize: [100, 40],
                iconAnchor: [50, 35]
            });

            if (markers[uid]) {
                markers[uid].setLatLng([lat, lng]);
                
                if (markers[uid]._speakingState !== isSpeaking) {
                    markers[uid].setIcon(icon);
                    markers[uid]._speakingState = isSpeaking;
                }
                
                if(isSpeaking) markers[uid].setZIndexOffset(1000);
                else markers[uid].setZIndexOffset(0);

            } else {
                markers[uid] = L.marker([lat, lng], {icon: icon}).addTo(map);
                markers[uid]._speakingState = isSpeaking;
                markers[uid].bindPopup(`<b>${user.name}</b><br><small>Channel: ${user.channel_name}</small>`);
            }
        });

        Object.keys(markers).forEach(id => {
            if (!activeIds.includes(id)) {
                map.removeLayer(markers[id]);
                delete markers[id];
            }
        });

        if(txFound) $('#tx-indicator').fadeIn(200);
        else $('#tx-indicator').fadeOut(200);

        $('#count-online').text(userCache.length);
    }

    function renderList() {
        const q = $('#unitSearch').val().toLowerCase();
        const container = $('#unitList');
        
        const filtered = userCache.filter(u => u.name.toLowerCase().includes(q) || u.id.toString().includes(q));

        let html = '';
        filtered.forEach(u => {
            const isSpeaking = parseInt(u.is_speaking) === 1;
            html += `
                <div class="unit-item ${isSpeaking ? 'speaking-active' : ''}" data-lat="${u.lat}" data-lng="${u.lng}" data-uid="${String(u.id).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}"
                     onclick="gotoUnit(this.dataset.lat, this.dataset.lng, this.dataset.uid)">
                    <div class="position-relative me-3">
                        <div style="width:12px; height:12px; border-radius:50%; background:${isSpeaking ? 'var(--color-danger)' : 'var(--color-success)'};"></div>
                        ${isSpeaking ? '<div class="spinner-grow text-danger position-absolute" style="width:12px; height:12px; top:0; left:0; opacity:0.4;"></div>' : ''}
                    </div>
                    <div class="flex-grow-1 overflow-hidden">
                        <div class="small fw-bold text-dark text-truncate d-flex justify-content-between">
                            <span>${u.name}</span>
                            ${isSpeaking ? '<span class="badge bg-danger" style="font-size:7px;">TX</span>' : ''}
                        </div>
                        <div class="text-muted d-flex justify-content-between" style="font-size:9px;">
                            <span>#${u.id}</span>
                            <span>${u.channel_name}</span>
                        </div>
                    </div>
                </div>`;
        });
        
        container.html(html || '<div class="p-4 text-center text-muted small">Tidak ada user aktif</div>');
    }

    function gotoUnit(lat, lng, id) {
        if ($(window).width() <= 992) $('#unitPanel').removeClass('show');
        map.flyTo([lat, lng], 17, { duration: 1.2 });
        setTimeout(() => {
            if (markers[id]) markers[id].openPopup();
        }, 1300);
    }

    function resetMap() {
        map.setView([-2.5, 118], 5);
    }

    $(document).ready(function() {
        syncData();
        setInterval(syncData, 2000);

        $('#panelToggle').click(function() {
            $('#unitPanel').toggleClass('show');
            $(this).attr('aria-expanded', $('#unitPanel').hasClass('show') ? 'true' : 'false');
        });
    });
</script>
</body>
</html>
