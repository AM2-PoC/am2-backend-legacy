<?php
require_once 'auth.php';
date_default_timezone_set('Asia/Jakarta');

require_once 'config.php';
?>
<?php
$pageTitle = t('logs.heading');
$pageLede  = t('logs.lede');

include 'partials/head.php';
include 'partials/shell.php';

/** Page size. 20 rows of 44px fills a screen without needing two scrolls. */
const AM2_LOG_PAGE = 20;
?>

<section class="am2-surface flex flex-col rounded-card">

    <!--
        Filter toolbar. Category first: it narrows the set, and search then
        works within it. The button ids are the contract this page has always
        exposed.
    -->
    <div class="flex flex-wrap items-center gap-3 border-b border-edge px-4 py-3 lg:px-5">
        <div class="flex gap-1.5" role="group" aria-label="<?= e('logs.filter') ?>">
            <?php foreach ([['ALL', 'btn-all', 'logs.all'], ['PTT', 'btn-ptt', 'logs.ptt'],
                            ['ADM', 'btn-adm', 'logs.adm']] as [$cat, $id, $key]): ?>
                <button type="button" id="<?= $id ?>" data-cat="<?= $cat ?>"
                        aria-pressed="<?= $cat === 'ALL' ? 'true' : 'false' ?>"
                        class="am2-cat h-11 rounded-control border px-3 font-mono text-[10px]
                               uppercase tracking-[0.15em] transition-colors
                               duration-[var(--duration-micro)]
                               <?= $cat === 'ALL'
                                   ? 'border-brand bg-brand/10 text-brand'
                                   : 'border-edge text-ink-subtle hover:border-edge-strong hover:text-ink' ?>">
                    <?= e($key) ?>
                </button>
            <?php endforeach; ?>
        </div>

        <div class="relative min-w-0 flex-1 sm:max-w-xs">
            <input id="logSearchInput" type="search" autocomplete="off"
                   class="h-11 w-full rounded-control border border-edge bg-card px-3 text-sm text-ink
                          transition-colors duration-[var(--duration-micro)]
                          hover:border-edge-strong focus:border-brand focus:outline-none
                          focus:ring-2 focus:ring-brand/25"
                   placeholder="<?= e('logs.search') ?>">
        </div>

        <div class="ml-auto flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.15em]">
            <span id="loading-indicator" hidden class="text-brand">•••</span>
            <span id="logStale" hidden class="text-warn"><?= e('rail.stale') ?></span>
            <!-- Live is a state, so it is shown as one. Paused says why. -->
            <span id="logPaused" hidden
                  class="flex items-center gap-1.5 rounded-control bg-warn/10 px-2 py-1 text-warn">
                <span aria-hidden="true">❙❙</span><span id="logPausedWhy"></span>
            </span>
            <span class="text-ink-subtle">
                <?= e('logs.updated') ?> <span id="last-update-time">--:--:--</span>
            </span>
        </div>
    </div>

    <!--
        The wrapper scrolls in both directions, and the header sticks to it.
        An overflow container is what sticky positions against, so a thead
        sticking to the viewport inside an overflow-x wrapper does nothing at
        all -- it scrolls away with the rest of the table, which is what this
        did until it was measured.
    -->
    <div class="max-h-[calc(100dvh-19rem)] overflow-auto">
        <table class="data-table w-full text-sm">
            <thead class="sticky top-0 z-10 bg-card">
                <tr class="border-b border-edge text-left font-mono text-[10px] uppercase
                           tracking-[0.15em] text-ink-subtle">
                    <th scope="col" class="px-4 py-2.5 font-normal lg:px-5"><?= e('logs.time') ?></th>
                    <th scope="col" class="px-4 py-2.5 font-normal"><?= e('logs.event') ?></th>
                    <th scope="col" class="px-4 py-2.5 font-normal"><?= e('logs.detail') ?></th>
                    <th scope="col" class="px-4 py-2.5 font-normal"><?= e('logs.actor') ?></th>
                </tr>
            </thead>
            <!-- id is the contract. -->
            <tbody id="log-table-body" class="divide-y divide-edge"></tbody>
        </table>
    </div>

    <div id="logEmpty" hidden></div>
    <div id="logError" hidden></div>

    <!--
        Footer. It says how many rows exist rather than silently stopping at a
        hundred, and it says "terbaru" because that is all the endpoint sends:
        fetch_logs.php caps each category at 100 server-side, so 200 is the
        whole reachable set. Going deeper would mean changing the endpoint.
    -->
    <div class="flex flex-wrap items-center justify-between gap-3 border-t border-edge px-4 py-3 lg:px-5">
        <p id="logCount" class="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle"></p>
        <nav id="logPager" class="flex items-center gap-1" aria-label="<?= e('logs.pagination') ?>"></nav>
    </div>
</section>

<?php include 'partials/shell_end.php'; ?>

<script>
(() => {
    'use strict';

    const PAGE = <?= AM2_LOG_PAGE ?>;
    const LABEL = {
        login:  <?= json_encode(t('logs.badge_login')) ?>,
        logout: <?= json_encode(t('logs.badge_logout')) ?>,
        empty:  <?= json_encode(t('logs.empty')) ?>,
        noMatch:<?= json_encode(t('logs.no_match')) ?>,
        count:  <?= json_encode(t('logs.count')) ?>,
        pausedBrowsing: <?= json_encode(t('logs.paused_browsing')) ?>,
    };
    const ADM = <?= json_encode([
        'CREATE_USER'    => t('logs.badge_create'),
        'UPDATE_USER'    => t('logs.badge_update'),
        'DELETE_USER'    => t('logs.badge_delete'),
        'UPDATE_FEATURE' => t('logs.badge_feature'),
        'UPDATE_ACCESS'  => t('logs.badge_access'),
        'CREATE'         => t('logs.badge_create'),
        'UPDATE'         => t('logs.badge_update'),
        'DELETE'         => t('logs.badge_delete'),
    ]) ?>;
    const LOCALE = <?= json_encode(am2_locale() === 'id' ? 'id-ID' : 'en-GB') ?>;

    const $ = (id) => document.getElementById(id);
    const body = $('log-table-body');
    const pager = $('logPager');

    let rows = [], category = 'ALL', query = '', page = 1;

    const visible = () => {
        const q = query.trim().toLowerCase();
        return rows.filter((r) => {
            if (category !== 'ALL' && r.kategori !== category) return false;
            if (!q) return true;
            // Searches the fields, not the rendered text: matching on innerText
            // meant a change of column count silently changed what a search found.
            return [r.target, r.pelaksana, r.pelaksana_id, r.aksi]
                .some((v) => String(v ?? '').toLowerCase().includes(q));
        });
    };

    function badge(row) {
        const t = String(row.aksi ?? '').toUpperCase();
        if (['PUSH', 'PUSH_PRIVATE'].includes(t)) return 'bg-bad/10 text-bad';
        if (t === 'LOGIN') return 'bg-ok/10 text-ok';
        if (t === 'FORCE_LOGOUT') return 'bg-warn/10 text-warn';
        if (row.kategori === 'ADM') return 'bg-accent/10 text-accent';
        return 'bg-card-muted text-ink-subtle';
    }

    function label(row) {
        const t = String(row.aksi ?? '').toUpperCase();
        if (['PUSH', 'PUSH_PRIVATE'].includes(t)) return 'TX';
        if (['RELEASE', 'RELEASE_PRIVATE'].includes(t)) return 'RX';
        if (t === 'LOGIN') return LABEL.login;
        if (t === 'LOGOUT' || t === 'FORCE_LOGOUT') return LABEL.logout;
        // Admin actions have long names. Truncating them produced
        // "UPDATE_FEATU", which reads as a rendering fault rather than a label.
        return ADM[t] ?? t.slice(0, 10);
    }

    /** textContent throughout: keterangan is free text an admin typed. */
    function cell(label, cls) {
        const td = document.createElement('td');
        td.setAttribute('data-label', label);   // drives the mobile card transform
        td.className = cls;
        return td;
    }

    const HEAD = [...document.querySelectorAll('thead th')].map((th) => th.textContent.trim());

    function render() {
        const set = visible();
        const pages = Math.max(1, Math.ceil(set.length / PAGE));
        if (page > pages) page = pages;
        const slice = set.slice((page - 1) * PAGE, page * PAGE);

        body.textContent = '';
        for (const r of slice) {
            const tr = document.createElement('tr');
            tr.className = 'transition-colors duration-[var(--duration-micro)] hover:bg-card-muted';

            const time = cell(HEAD[0], 'px-4 py-2 align-top lg:px-5');
            const jam = document.createElement('span');
            jam.className = 'block font-mono text-xs tabular-nums';
            jam.textContent = r.jam ?? '';
            const tgl = document.createElement('span');
            tgl.className = 'block font-mono text-[10px] text-ink-subtle';
            tgl.textContent = r.tanggal ?? '';
            time.append(jam, tgl);

            const ev = cell(HEAD[1], 'px-4 py-2 align-top');
            const b = document.createElement('span');
            b.className = 'inline-block rounded-control px-1.5 py-0.5 font-mono text-[9px] '
                        + 'uppercase tracking-[0.1em] ' + badge(r);
            b.textContent = label(r);
            ev.append(b);

            const detail = cell(HEAD[2], 'px-4 py-2 align-top');
            detail.textContent = r.target ?? '';

            const actor = cell(HEAD[3], 'px-4 py-2 align-top');
            const who = document.createElement('span');
            who.className = 'block truncate';
            who.textContent = r.pelaksana ?? '';
            const wid = document.createElement('span');
            wid.className = 'block font-mono text-[10px] text-ink-subtle';
            wid.textContent = r.pelaksana_id ?? '';
            actor.append(who, wid);

            tr.append(time, ev, detail, actor);
            body.appendChild(tr);
        }

        $('logEmpty').hidden = set.length > 0;
        if (!set.length) {
            $('logEmpty').textContent = '';
            const p = document.createElement('p');
            p.className = 'px-5 py-10 text-center text-sm text-ink-muted';
            p.textContent = query ? LABEL.noMatch : LABEL.empty;
            $('logEmpty').appendChild(p);
        }

        const from = set.length ? (page - 1) * PAGE + 1 : 0;
        $('logCount').textContent = LABEL.count
            .replace(':from', from).replace(':to', (page - 1) * PAGE + slice.length)
            .replace(':total', set.length);

        renderPager(pages);
        // Polling is only honest on page one; anywhere else the numbering moves
        // under the reader. Say so rather than quietly stopping.
        const browsing = page > 1;
        $('logPaused').hidden = !browsing;
        $('logPausedWhy').textContent = browsing ? LABEL.pausedBrowsing : '';
    }

    /** Preline pagination markup: https://preline.co/docs/pagination.html */
    function renderPager(pages) {
        pager.textContent = '';
        if (pages <= 1) return;
        const mk = (text, target, opts = {}) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = text;
            b.disabled = !!opts.disabled;
            b.className = 'grid h-11 min-w-11 place-items-center rounded-control border px-2 '
                + 'font-mono text-[11px] transition-colors duration-[var(--duration-micro)] '
                + 'disabled:opacity-40 '
                + (opts.current
                    ? 'border-brand bg-brand/10 text-brand'
                    : 'border-edge text-ink-subtle hover:border-edge-strong hover:text-ink');
            if (opts.current) b.setAttribute('aria-current', 'page');
            if (opts.label) b.setAttribute('aria-label', opts.label);
            b.addEventListener('click', () => { page = target; render(); });
            return b;
        };
        pager.appendChild(mk('‹', page - 1, { disabled: page === 1, label: 'prev' }));
        // A window around the current page: 200 rows at 20 a page is ten
        // buttons, which is already more than anyone counts.
        const start = Math.max(1, Math.min(page - 2, pages - 4));
        for (let i = start; i <= Math.min(pages, start + 4); i++) {
            pager.appendChild(mk(String(i), i, { current: i === page }));
        }
        pager.appendChild(mk('›', page + 1, { disabled: page === pages, label: 'next' }));
    }

    async function tick() {
        $('loading-indicator').hidden = false;
        try {
            const res = await fetch('fetch_logs.php', { headers: { Accept: 'application/json' } });
            if (!res.ok) throw new Error(res.status);
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            rows = [...(data.ptt ?? []), ...(data.adm ?? [])]
                .sort((a, b) => String(b.raw_time).localeCompare(String(a.raw_time)));
            $('last-update-time').textContent = new Date().toLocaleTimeString(LOCALE,
                { hour12: false, timeZone: 'Asia/Jakarta' });
            $('logStale').hidden = true;
            $('logError').hidden = true;
            render();
        } catch {
            // Keep the rows on screen but say they are no longer current.
            $('logStale').hidden = false;
        } finally {
            $('loading-indicator').hidden = true;
        }
    }

    document.querySelectorAll('.am2-cat').forEach((btn) => {
        btn.addEventListener('click', () => {
            category = btn.dataset.cat;
            page = 1;
            document.querySelectorAll('.am2-cat').forEach((b) => {
                const on = b === btn;
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
                b.classList.toggle('border-brand', on);
                b.classList.toggle('bg-brand/10', on);
                b.classList.toggle('text-brand', on);
                b.classList.toggle('border-edge', !on);
                b.classList.toggle('text-ink-subtle', !on);
            });
            window.AM2?.filtered(body);
            render();
        });
    });

    $('logSearchInput').addEventListener('input', (e) => {
        query = e.target.value;
        page = 1;
        window.AM2?.filtered(body);
        render();
    });

    tick();
    // Four seconds, as before: a dispatch log is read while it moves. It only
    // refreshes on page one -- see render().
    setInterval(() => { if (page === 1) tick(); }, 4000);
})();
</script>
</body>
</html>
