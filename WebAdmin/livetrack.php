<?php
require_once 'auth.php';
require_once 'config.php';

$pageTitle = t('nav.live_track');
$pageLede  = t('track.lede');

include 'partials/head.php';
include 'partials/shell.php';
?>

<!--
    The map breaks out of <main>'s gutter: a tracking view is the page, not a
    card on it. The negative margins undo the shell's padding exactly, which is
    cheaper and less brittle than giving the shell a second layout mode for one
    page.
-->
<!--
    The map is a card like every other page's, sitting in the shell's gutter
    rather than bleeding past it. Full-bleed made this page the only one whose
    content did not line up with the rest, which is what it looked like.
    overflow-hidden is what makes Leaflet respect the rounded corners.
-->
<section class="am2-surface relative h-[calc(100dvh-11rem)] overflow-hidden rounded-card">

    <!-- Leaflet writes into this. The id is the contract. -->
    <div id="map" class="absolute inset-0 z-0"></div>

    <!--
        Map controls. Leaflet's own zoom buttons were switched off and nothing
        replaced them, so the only way to move around was a scroll wheel -- and
        nothing at all on a touch screen except pinching. These are the console's
        own, in the console's tokens.
    -->
    <!--
        Left, under the transmitting badge. They used to sit top-right and step
        aside when the panel collapsed -- straight underneath the handle that
        brings the panel back, which covered the zoom-in button entirely. The
        left edge belongs to nothing else, so nothing can land on top of them.
    -->
    <div class="absolute left-4 top-16 z-30 flex flex-col gap-1.5" id="mapControls">
        <button type="button" id="mapZoomIn" aria-label="<?= e('track.zoom_in') ?>"
                title="<?= e('track.zoom_in') ?>"
                class="grid h-11 w-11 place-items-center rounded-control border border-edge
                       bg-card text-ink-muted shadow-pop transition-colors
                       duration-[var(--duration-micro)] hover:border-brand hover:text-brand">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
                 stroke-linecap="round" class="h-4 w-4" aria-hidden="true">
                <path d="M12 5v14"/><path d="M5 12h14"/></svg>
        </button>
        <button type="button" id="mapZoomOut" aria-label="<?= e('track.zoom_out') ?>"
                title="<?= e('track.zoom_out') ?>"
                class="grid h-11 w-11 place-items-center rounded-control border border-edge
                       bg-card text-ink-muted shadow-pop transition-colors
                       duration-[var(--duration-micro)] hover:border-brand hover:text-brand">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
                 stroke-linecap="round" class="h-4 w-4" aria-hidden="true">
                <path d="M5 12h14"/></svg>
        </button>
        <button type="button" id="mapFit" aria-label="<?= e('track.fit') ?>"
                title="<?= e('track.fit') ?>"
                class="grid h-11 w-11 place-items-center rounded-control border border-edge
                       bg-card text-ink-muted shadow-pop transition-colors
                       duration-[var(--duration-micro)] hover:border-brand hover:text-brand">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
                 stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4" aria-hidden="true">
                <path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/>
                <path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/></svg>
        </button>
    </div>

    <!--
        Legend. The marker colours mean something, and colour alone does not
        carry meaning for everyone looking at this screen.
    -->
    <div class="absolute bottom-4 left-4 z-20 hidden flex-wrap items-center gap-3 rounded-control
                border border-edge bg-card/95 px-3 py-2 font-mono text-[11px] uppercase
                tracking-[0.12em] text-ink-subtle shadow-pop backdrop-blur-sm lg:flex">
        <span class="flex items-center gap-1.5"><span class="legend-shape entity-user" aria-hidden="true"></span><?= e('track.type_user') ?></span>
        <span class="flex items-center gap-1.5"><span class="legend-shape entity-tracker" aria-hidden="true"></span><?= e('track.type_tracker') ?></span>
        <span class="flex items-center gap-1.5"><span class="legend-state freshness-fresh" aria-hidden="true"></span><?= e('track.fresh') ?></span>
        <span class="flex items-center gap-1.5"><span class="legend-state freshness-delayed" aria-hidden="true"></span><?= e('track.delayed') ?></span>
        <span class="flex items-center gap-1.5"><span class="legend-state freshness-stale" aria-hidden="true"></span><?= e('track.stale') ?></span>
        <span class="flex items-center gap-1.5"><span class="am2-live h-2 w-2 rounded-full bg-bad" aria-hidden="true"></span><?= e('track.transmitting') ?></span>
    </div>

    <div id="feed-status" hidden role="status"
         class="absolute left-4 top-4 z-30 rounded-control border border-bad/40 bg-card/95 px-3 py-2
                font-mono text-[11px] uppercase tracking-[0.15em] text-bad shadow-pop">
        <?= e('track.feed_disconnected') ?>
    </div>

    <!-- Transmitting right now. The one pulse in the application. -->
    <div id="tx-indicator" hidden
         class="absolute left-4 top-4 z-20 flex items-center gap-2 rounded-control
                border border-bad/40 bg-card/95 px-3 py-2 font-mono text-[11px]
                uppercase tracking-[0.15em] text-bad shadow-pop backdrop-blur-sm">
        <span class="am2-live h-2 w-2 rounded-full bg-bad" aria-hidden="true"></span>
        <?= e('track.transmitting') ?>
    </div>

    <!-- Brings the panel back on desktop once it has been collapsed. -->
    <button type="button" id="panelRestore" hidden
            class="absolute right-4 top-4 z-30 hidden h-11 items-center gap-2 rounded-control
                   border border-edge bg-card px-3 font-mono text-[11px] uppercase
                   tracking-[0.15em] text-ink shadow-pop lg:flex"
            aria-controls="unitPanel" aria-expanded="false"
            aria-label="<?= e('track.units') ?>">
        <?= am2_icon('users', 'h-4 w-4') ?>
        <span id="panelRestoreCount">0</span>
    </button>

    <!-- Opens the panel below lg, where it is a sheet rather than a column. -->
    <button type="button" id="panelToggle" aria-expanded="false" aria-controls="unitPanel"
            class="absolute bottom-4 right-4 z-30 flex h-12 items-center gap-2 rounded-card
                   border border-edge bg-card px-4 font-mono text-[11px] uppercase
                   tracking-[0.15em] text-ink shadow-panel lg:hidden">
        <?= am2_icon('users', 'h-4 w-4') ?>
        <span><?= e('track.units') ?></span>
        <span id="count-online-badge"
              class="rounded-control bg-brand/15 px-1.5 py-0.5 text-brand">0</span>
    </button>

    <!--
        Unit panel. A floating card from lg up; below that it is a sheet that
        rises from the bottom, because a side panel on a phone leaves the map
        too narrow to be a map.
    -->
    <aside id="unitPanel" aria-label="<?= e('track.units') ?>"
           class="am2-surface absolute inset-x-3 bottom-3 z-20 flex max-h-[70%] translate-y-[110%]
                  flex-col rounded-card transition-transform
                  duration-[var(--duration-drawer)] ease-enter
                  lg:inset-x-auto lg:bottom-4 lg:right-4 lg:top-4 lg:w-[340px]
                  lg:max-h-none lg:translate-y-0">

        <header class="flex items-center justify-between gap-3 border-b border-edge px-4 py-3">
            <h2 class="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">
                <?= e('track.units') ?>
            </h2>
            <span class="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.15em]">
                <span id="count-online" class="text-ink">0</span>
                <span class="text-ink-subtle"><?= e('rail.online') ?></span>
                <span aria-hidden="true" class="text-ink-subtle">·</span>
                <span id="count-fresh" class="text-ok">0</span>
                <span class="text-ink-subtle"><?= e('track.fresh_locations') ?></span>
            </span>
            <!-- Desktop gets the same escape the phone has: the panel covers a
                 third of the map, and sometimes the map is the point. -->
            <button type="button" id="panelCollapse"
                    class="hidden h-8 w-8 place-items-center rounded-control text-ink-subtle
                           transition-colors duration-[var(--duration-micro)]
                           hover:bg-card-muted hover:text-ink lg:grid"
                    aria-controls="unitPanel" aria-expanded="true"
                    aria-label="<?= e('track.collapse') ?>" title="<?= e('track.collapse') ?>">
                <span id="panelCollapseIcon"><?= am2_icon('expand', 'h-4 w-4') ?></span>
            </button>
        </header>

        <div class="border-b border-edge p-3">
            <input id="unitSearch" type="search" autocomplete="off"
                   aria-label="<?= e('track.search') ?>"
                   placeholder="<?= e('track.search') ?>"
                   class="h-11 w-full rounded-control border border-edge bg-card px-3 text-sm
                          text-ink transition-colors duration-[var(--duration-micro)]
                          hover:border-edge-strong focus:border-brand focus:outline-none
                          focus:ring-2 focus:ring-brand/25">
        </div>

        <!-- id is the contract; rows are built as DOM, never as markup. -->
        <div id="unitList" class="flex-1 overflow-y-auto"></div>
    </aside>
</section>

<?php include 'partials/shell_end.php'; ?>

<script src="<?= am2_asset('asset/vendor/leaflet/leaflet.js') ?>"></script>
<script type="module">
import {
    accuracyQuality, classifyUnit, formatAccuracy, formatAge, hasValidLocation, summarizeUnits,
} from <?= json_encode(am2_asset_url('./asset/js/src/livetrack-model.js')) ?>;
// Stable class hook produced by classifyUnit(): speaking-marker.

(() => {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const EMPTY = <?= json_encode(t('track.empty')) ?>;
    const CHANNEL = <?= json_encode(t('track.channel')) ?>;
    const TYPE = <?= json_encode(t('usr.entity_type')) ?>;
    const TYPES = {
        user: <?= json_encode(t('track.type_user')) ?>,
        tracker: <?= json_encode(t('track.type_tracker')) ?>,
    };
    const FRESHNESS_LABELS = {
        fresh: <?= json_encode(t('track.fresh')) ?>,
        delayed: <?= json_encode(t('track.delayed')) ?>,
        stale: <?= json_encode(t('track.stale')) ?>,
    };
    const LAST_LOCATION = <?= json_encode(t('track.last_location')) ?>;
    const ACCURACY = <?= json_encode(t('track.accuracy')) ?>;
    const NO_LOCATION = <?= json_encode(t('track.no_location')) ?>;
    const FEED_DISCONNECTED = <?= json_encode(t('track.feed_disconnected')) ?>;

    const map = L.map('map', { zoomControl: false, attributionControl: true })
                 .setView([-2.5, 118], 5);

    // Attribution was switched off. CARTO and OpenStreetMap both require it,
    // so this is a licence term rather than a design choice -- it is small and
    // in the corner, but it is there.
    map.attributionControl.setPrefix('');

    /*
     * The basemap follows the theme. It was Voyager -- a light street map --
     * in both, which under the dark theme put a white continent behind dark
     * chrome and made the markers hard to pick out. CARTO's Positron and Dark
     * Matter share a structure, so switching between them changes the palette
     * and nothing else.
     */
    const BASEMAP = {
        light: 'https://{s}.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}{r}.png',
        dark: 'https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png',
    };
    const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> '
               + '&copy; <a href="https://carto.com/attributions">CARTO</a>';

    let tiles = null;
    function paintBasemap() {
        const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        if (tiles) map.removeLayer(tiles);
        tiles = L.tileLayer(BASEMAP[theme], { attribution: ATTR }).addTo(map);
    }
    paintBasemap();

    // The theme toggle lives in the shell and only writes the attribute, so
    // the map watches the attribute rather than the button.
    new MutationObserver(paintBasemap).observe(document.documentElement,
        { attributes: true, attributeFilter: ['data-theme'] });

    const markers = {};
    const locationCircles = {};
    let userCache = [];
    let feedFailures = 0;
    let syncInFlight = false;
    const FETCH_TIMEOUT_MS = 2500;

    /** Zoom at which unit names stop colliding. */
    const LABEL_ZOOM = 9;

    /** Leaflet's divIcon takes a string, so the one place markup is built from
     *  a unit's name escapes it. The name is admin-entered free text. */
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    async function syncData() {
        if (syncInFlight) return;
        syncInFlight = true;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch('get-users-ajax.php', {
                headers: { Accept: 'application/json' },
                signal: controller.signal,
            });
            if (!res.ok) throw new Error(res.status);
            const data = await res.json();
            if (!Array.isArray(data)) throw new Error(data?.error || 'invalid response');
            feedFailures = 0;
            $('feed-status').hidden = true;
            userCache = data;
            updateMarkers();
            renderList();
        } catch {
            // The last known positions stay on the map rather than vanishing.
            feedFailures += 1;
            if (feedFailures >= 2) {
                $('feed-status').textContent = FEED_DISCONNECTED;
                $('feed-status').hidden = false;
            }
        } finally {
            clearTimeout(timeout);
            syncInFlight = false;
        }
    }

    function updateMarkers() {
        const activeIds = userCache.filter(hasValidLocation).map((u) => String(u.id));
        let txFound = false;

        userCache.forEach((user) => {
            const uid = String(user.id);
            if (!hasValidLocation(user)) {
                if (markers[uid]) { map.removeLayer(markers[uid]); delete markers[uid]; }
                if (locationCircles[uid]) { map.removeLayer(locationCircles[uid]); delete locationCircles[uid]; }
                return;
            }
            const lat = Number(user.lat);
            const lng = Number(user.lng);
            const state = classifyUnit(user);
            const isSpeaking = state.speaking;
            if (isSpeaking) txFound = true;

            // Class names are the contract am2-ui.css styles the markers with.
            // Below zoom 9 the labels collide into an unreadable stack -- a
            // dozen units over Java is one smear of overlapping names. The dot
            // still says where each unit is, and the name is a click or a
            // glance at the panel away.
            const showLabel = map.getZoom() >= LABEL_ZOOM;
            const markerDescription = `${TYPES[state.entityType]}, ${FRESHNESS_LABELS[state.freshness]}`;
            const icon = L.divIcon({
                className: state.markerClass + (showLabel ? '' : ' custom-marker-bare'),
                html: `<span class="sr-only">${esc(markerDescription)}</span>`
                    + (showLabel ? `<div class="marker-label">${esc(user.name)}</div>` : '')
                    + '<div class="pulse-dot" aria-hidden="true"></div>',
                iconSize: showLabel ? [100, 40] : [16, 16],
                // Dot centre is y=32: 40px icon minus 8px radius.
                iconAnchor: showLabel ? [50, 32] : [8, 8],
            });

            if (markers[uid]) {
                markers[uid].setLatLng([lat, lng]);
                if (markers[uid]._renderState !== `${state.markerClass}:${showLabel}`) {
                    markers[uid].setIcon(icon);
                    markers[uid]._renderState = `${state.markerClass}:${showLabel}`;
                }
                markers[uid].setZIndexOffset(isSpeaking ? 1000 : 0);
            } else {
                markers[uid] = L.marker([lat, lng], { icon }).addTo(map);
                markers[uid]._renderState = `${state.markerClass}:${showLabel}`;
                markers[uid].bindPopup('');
            }
            const popup = `<b>${esc(user.name)}</b><br><small>`
                + `${esc(TYPE)}: ${esc(TYPES[state.entityType])}<br>`
                + `${esc(CHANNEL)}: ${esc(user.channel_name)}<br>`
                + `${esc(LAST_LOCATION)}: ${esc(formatAge(user.location_age_seconds))} (${esc(FRESHNESS_LABELS[state.freshness])})<br>`
                + `${esc(ACCURACY)}: ${esc(formatAccuracy(user.accuracy))}</small>`;
            markers[uid].setPopupContent(popup);

            const acc = Number(user.accuracy);
            if (Number.isFinite(acc) && acc > 0) {
                if (!locationCircles[uid]) {
                    locationCircles[uid] = L.circle([lat, lng], { interactive: false, weight: 1, fillOpacity: 0.08 }).addTo(map);
                }
                locationCircles[uid].setLatLng([lat, lng]).setRadius(acc).setStyle({
                    color: accuracyQuality(acc) === 'poor' ? '#f59e0b' : '#22c55e',
                    dashArray: accuracyQuality(acc) === 'poor' ? '6 5' : null,
                });
            } else if (locationCircles[uid]) {
                map.removeLayer(locationCircles[uid]);
                delete locationCircles[uid];
            }
        });

        Object.keys(markers).forEach((id) => {
            if (!activeIds.includes(id)) {
                map.removeLayer(markers[id]);
                delete markers[id];
            }
        });
        Object.keys(locationCircles).forEach((id) => {
            if (!activeIds.includes(id)) {
                map.removeLayer(locationCircles[id]);
                delete locationCircles[id];
            }
        });

        $('tx-indicator').hidden = !txFound;
        const summary = summarizeUnits(userCache);
        window.AM2?.countTo($('count-online'), summary.online);
        window.AM2?.countTo($('count-fresh'), summary.fresh);
        $('count-online-badge').textContent = String(summary.online);
        $('panelRestoreCount').textContent = String(summary.online);
    }

    function renderList() {
        const q = $('unitSearch').value.toLowerCase();
        const list = $('unitList');
        const filtered = userCache.filter((u) => {
            const state = classifyUnit(u);
            return String(u.name).toLowerCase().includes(q)
                || String(u.id).toLowerCase().includes(q)
                || TYPES[state.entityType].toLowerCase().includes(q);
        });

        list.textContent = '';

        if (!filtered.length) {
            const p = document.createElement('p');
            p.className = 'px-4 py-8 text-center text-sm text-ink-muted';
            p.textContent = EMPTY;
            list.appendChild(p);
            return;
        }

        for (const u of filtered) {
            const state = classifyUnit(u);
            const speaking = state.speaking;

            // A button, so it is reachable by keyboard. The old rows were divs
            // with an inline onclick and could only be used with a mouse.
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'unit-item flex w-full items-center gap-3 border-b border-edge px-4 '
                + 'py-2.5 text-left transition-colors duration-[var(--duration-micro)] '
                + 'hover:bg-card-muted' + (speaking ? ' speaking-active' : '');
            row.dataset.uid = String(u.id);
            if (hasValidLocation(u)) {
                row.addEventListener('click', () => gotoUnit(u.lat, u.lng, String(u.id)));
            } else {
                row.disabled = true;
            }

            const dot = document.createElement('span');
            dot.className = 'h-2.5 w-2.5 shrink-0 rounded-full '
                + (speaking ? 'bg-bad am2-live' : 'bg-ok');
            dot.setAttribute('aria-hidden', 'true');

            const body = document.createElement('span');
            body.className = 'min-w-0 flex-1';

            const top = document.createElement('span');
            top.className = 'flex items-center justify-between gap-2';
            const name = document.createElement('span');
            name.className = 'truncate text-sm font-semibold text-ink';
            name.textContent = u.name ?? '';
            top.appendChild(name);
            const type = document.createElement('span');
            type.className = 'shrink-0 rounded-control bg-card-muted px-1.5 font-mono text-[10px] uppercase text-ink-subtle';
            type.textContent = TYPES[state.entityType];
            top.appendChild(type);
            if (speaking) {
                const tx = document.createElement('span');
                tx.className = 'shrink-0 rounded-control bg-bad/10 px-1.5 font-mono text-[11px] text-bad';
                tx.textContent = 'TX';
                top.appendChild(tx);
            }

            const meta = document.createElement('span');
            meta.className = 'mt-0.5 flex items-center justify-between gap-2 font-mono '
                + 'text-[11px] text-ink-subtle';
            const idEl = document.createElement('span');
            idEl.textContent = '#' + String(u.id);
            const chEl = document.createElement('span');
            chEl.className = 'truncate';
            chEl.textContent = u.channel_name ?? '';
            meta.append(idEl, chEl);

            const locationMeta = document.createElement('span');
            locationMeta.className = 'mt-1 block font-mono text-[11px] text-ink-subtle';
            locationMeta.textContent = hasValidLocation(u)
                ? `${LAST_LOCATION}: ${formatAge(u.location_age_seconds)} · ${formatAccuracy(u.accuracy)} · ${FRESHNESS_LABELS[state.freshness]}`
                : NO_LOCATION;

            body.append(top, meta, locationMeta);
            row.append(dot, body);
            list.appendChild(row);
        }
    }

    function gotoUnit(lat, lng, id) {
        // Below lg the panel covers the map, so it gets out of the way.
        if (window.innerWidth <= 992) closePanel();
        map.flyTo([lat, lng], 17, { duration: 1.2 });
        setTimeout(() => { if (markers[id]) markers[id].openPopup(); }, 1300);
    }

    const panel = $('unitPanel');
    const toggle = $('panelToggle');
    const openPanel = () => {
        panel.classList.remove('translate-y-[110%]');
        toggle.setAttribute('aria-expanded', 'true');
    };
    const closePanel = () => {
        panel.classList.add('translate-y-[110%]');
        toggle.setAttribute('aria-expanded', 'false');
    };
    toggle.addEventListener('click', () => {
        panel.classList.contains('translate-y-[110%]') ? openPanel() : closePanel();
    });

    // Redraw the markers when crossing the label threshold.
    let lastLabelState = null;
    map.on('zoomend', () => {
        const now = map.getZoom() >= LABEL_ZOOM;
        if (now !== lastLabelState) {
            lastLabelState = now;
            updateMarkers();
        }
    });

    $('mapZoomIn').addEventListener('click', () => map.zoomIn());
    $('mapZoomOut').addEventListener('click', () => map.zoomOut());
    $('mapFit').addEventListener('click', () => {
        // Every unit on screen at once, which is the question this page is
        // usually opened to answer.
        const pts = Object.values(markers).map((m) => m.getLatLng());
        if (!pts.length) return;
        map.flyToBounds(L.latLngBounds(pts).pad(0.25), { duration: 0.8 });
    });

    // Desktop collapse. Translating rather than hiding keeps Motion's job and
    // Preline's separate -- this panel is not an overlay, so nothing else owns
    // its visibility.
    const collapse = $('panelCollapse');
    const restore = $('panelRestore');
    const setCollapsed = (on) => {
        panel.classList.toggle('lg:translate-x-[calc(100%+1.5rem)]', on);
        collapse.setAttribute('aria-expanded', on ? 'false' : 'true');
        restore.hidden = !on;
        restore.setAttribute('aria-expanded', on ? 'false' : 'true');
    };
    collapse.addEventListener('click', () => setCollapsed(
        !panel.classList.contains('lg:translate-x-[calc(100%+1.5rem)]')));
    restore.addEventListener('click', () => setCollapsed(false));

    $('unitSearch').addEventListener('input', renderList);

    syncData();
    setInterval(syncData, 3000);
})();
</script>
</body>
</html>
