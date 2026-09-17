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

const AM2_LOG_PAGE = 20;
?>

<section class="am2-surface flex flex-col rounded-card">

    <div class="flex flex-wrap items-center gap-3 border-b border-edge px-4 py-3 lg:px-5">
        <div class="flex gap-1.5" role="group" aria-label="<?= e('logs.filter') ?>">
            <?php foreach ([['ALL', 'btn-all', 'logs.all'], ['PTT', 'btn-ptt', 'logs.ptt'],
                            ['ADM', 'btn-adm', 'logs.adm']] as [$cat, $id, $key]): ?>
                <button type="button" id="<?= $id ?>" data-cat="<?= $cat ?>"
                        aria-pressed="<?= $cat === 'ALL' ? 'true' : 'false' ?>"
                        class="am2-cat h-11 rounded-control border px-3 font-mono text-[11px]
                               uppercase tracking-[0.15em] transition-colors
                               duration-[var(--duration-micro)]
                               <?= $cat === 'ALL'
                                   ? 'border-brand bg-brand/10 text-brand'
                                   : 'border-edge text-ink-subtle hover:border-brand hover:text-brand' ?>">
                    <?= e($key) ?>
                </button>
            <?php endforeach; ?>
        </div>

        <div id="logSearch" data-log-search
             class="group relative min-w-0 flex-1 sm:max-w-xs
                    max-[602px]:flex-none max-[602px]:data-[expanded=true]:flex-[1_0_100%]">
            <button type="button" id="logSearchToggle"
                    aria-label="<?= e('logs.search') ?>" title="<?= e('logs.search') ?>"
                    aria-expanded="false" aria-controls="logSearchInput"
                    class="hidden h-11 w-11 place-items-center rounded-control border border-edge
                           text-ink-subtle transition-colors duration-[var(--duration-micro)]
                           hover:border-brand hover:text-brand focus:outline-none
                           focus-visible:ring-2 focus-visible:ring-brand/60
                           max-[602px]:grid max-[602px]:group-data-[expanded=true]:hidden">
                <?= am2_icon('search', 'h-4 w-4') ?>
            </button>
            <input id="logSearchInput" type="search" autocomplete="off"
                   aria-label="<?= e('logs.search') ?>"
                   class="h-11 w-full rounded-control border border-edge bg-card px-3 text-sm text-ink
                          transition-colors duration-[var(--duration-micro)]
                          hover:border-edge-strong focus:border-brand focus:outline-none
                          focus:ring-2 focus:ring-brand/25
                          max-[602px]:hidden max-[602px]:group-data-[expanded=true]:block"
                   placeholder="<?= e('logs.search') ?>">
        </div>

        <div class="ml-auto flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.15em]">
            <span id="loading-indicator" hidden class="text-brand">•••</span>
            <span id="logStale" hidden class="text-warn"><?= e('rail.stale') ?></span>

            <span id="logPaused" hidden
                  class="flex items-center gap-1.5 rounded-control bg-warn/10 px-2 py-1 text-warn">
                <span aria-hidden="true">❙❙</span><span id="logPausedWhy"></span>
            </span>
            <span class="text-ink-subtle">
                <?= e('logs.updated') ?> <span id="last-update-time">--:--:--</span>
            </span>
        </div>
    </div>

    <div class="max-h-[calc(100dvh-19rem)] overflow-auto">
        <table class="data-table am2-roster am2-roster-log w-full text-sm lg:min-w-[48rem]">
            <thead class="sticky top-0 z-10 bg-card">
                <tr class="border-b border-edge text-left font-mono text-[11px] uppercase
                           tracking-[0.15em] text-ink-subtle">
                    <th scope="col" class="px-4 py-2.5 font-normal lg:px-5"><?= e('logs.time') ?></th>
                    <th scope="col" class="px-4 py-2.5 font-normal"><?= e('logs.event') ?></th>
                    <th scope="col" class="px-4 py-2.5 font-normal"><?= e('logs.detail') ?></th>
                    <th scope="col" class="px-4 py-2.5 font-normal"><?= e('logs.actor') ?></th>
                </tr>
            </thead>

            <tbody id="log-table-body" class="divide-y divide-edge"></tbody>
        </table>
    </div>

    <div id="logEmpty" hidden></div>
    <div id="logError" hidden></div>

    <div class="flex flex-wrap items-center justify-between gap-3 border-t border-edge px-4 py-3 lg:px-5">
        <p id="logCount" class="font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle"></p>
        <div class="flex items-center gap-3">

            <button type="button" id="logMore" hidden
                    class="am2-chip inline-flex items-center border-edge text-ink-muted
                           hover:text-brand">
                <?= e('logs.load_older') ?>
            </button>
            <nav id="logPager" class="flex items-center gap-1" aria-label="<?= e('logs.pagination') ?>"></nav>
        </div>
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

        return ADM[t] ?? t.slice(0, 10);
    }

    function cell(name, cls) {
        const td = document.createElement('td');
        td.setAttribute('data-cell', name);
        td.className = cls;
        return td;
    }

    function summaryCell(r) {
        const td = cell('unit', 'hidden');

        const head = document.createElement('span');
        head.className = 'flex items-center gap-2';
        const b = document.createElement('span');
        b.className = 'shrink-0 rounded-control px-1.5 py-0.5 font-mono text-[11px] '
                    + 'uppercase tracking-[0.1em] ' + badge(r);
        b.textContent = label(r);
        const when = document.createElement('span');
        when.className = 'font-mono text-[11px] tabular-nums text-ink';
        when.textContent = r.jam ?? '';
        const day = document.createElement('span');
        day.className = 'font-mono text-[11px] text-ink-subtle';
        day.textContent = r.tanggal ?? '';
        head.append(b, when, day);

        const what = document.createElement('span');
        what.className = 'mt-1 block break-words text-sm text-ink';
        what.textContent = r.target ?? '';

        const by = document.createElement('span');
        by.className = 'mt-0.5 block break-words font-mono text-[11px] text-ink-subtle';
        by.textContent = [r.pelaksana, r.pelaksana_id].filter(Boolean).join(' · ');

        td.append(head, what, by);
        return td;
    }

    function render() {
        const set = visible();
        const pages = Math.max(1, Math.ceil(set.length / PAGE));
        if (page > pages) page = pages;
        const slice = set.slice((page - 1) * PAGE, page * PAGE);

        body.textContent = '';
        for (const r of slice) {
            const tr = document.createElement('tr');
            tr.className = 'transition-colors duration-[var(--duration-micro)] hover:bg-card-muted';

            const time = cell('time', 'px-4 py-2 align-top lg:px-5');
            const jam = document.createElement('span');
            jam.className = 'block font-mono text-xs tabular-nums';
            jam.textContent = r.jam ?? '';
            const tgl = document.createElement('span');
            tgl.className = 'block font-mono text-[11px] text-ink-subtle';
            tgl.textContent = r.tanggal ?? '';
            time.append(jam, tgl);

            const ev = cell('event', 'px-4 py-2 align-top');
            const b = document.createElement('span');
            b.className = 'inline-block rounded-control px-1.5 py-0.5 font-mono text-[11px] '
                        + 'uppercase tracking-[0.1em] ' + badge(r);
            b.textContent = label(r);
            ev.append(b);

            const detail = cell('detail', 'px-4 py-2 align-top');
            detail.textContent = r.target ?? '';

            const actor = cell('actor', 'px-4 py-2 align-top');
            const who = document.createElement('span');
            who.className = 'block truncate';
            who.textContent = r.pelaksana ?? '';
            const wid = document.createElement('span');
            wid.className = 'block font-mono text-[11px] text-ink-subtle';
            wid.textContent = r.pelaksana_id ?? '';
            actor.append(who, wid);

            tr.append(summaryCell(r), time, ev, detail, actor);
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

        $('logMore').hidden = exhausted() || page < pages;

        const browsing = page > 1;
        $('logPaused').hidden = !browsing;
        $('logPausedWhy').textContent = browsing ? LABEL.pausedBrowsing : '';
    }

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
                    : 'border-edge text-ink-subtle hover:border-brand hover:text-brand');
            if (opts.current) b.setAttribute('aria-current', 'page');
            if (opts.label) b.setAttribute('aria-label', opts.label);
            b.addEventListener('click', () => { page = target; render(); });
            return b;
        };
        pager.appendChild(mk('‹', page - 1, { disabled: page === 1, label: 'prev' }));

        const start = Math.max(1, Math.min(page - 2, pages - 4));
        for (let i = start; i <= Math.min(pages, start + 4); i++) {
            pager.appendChild(mk(String(i), i, { current: i === page }));
        }
        pager.appendChild(mk('›', page + 1, { disabled: page === pages, label: 'next' }));
    }

    const cursor = {
        ptt: { newest: '', oldest: '', more: true },
        adm: { newest: '', oldest: '', more: true },
    };
    let loadingOlder = false;

    const exhausted = () => !cursor.ptt.more && !cursor.adm.more;

    const byTimeDesc = (a, b) => (String(a.raw_time) < String(b.raw_time) ? 1 : -1);

    function absorb(data, { append = false, polling = false } = {}) {
        const incoming = [...(data.ptt ?? []), ...(data.adm ?? [])];

        const key = (r) => `${r.kategori}:${r.id}`;
        const seen = new Set(rows.map(key));
        const fresh = incoming.filter((r) => !seen.has(key(r)));
        rows = [...rows, ...fresh].sort(byTimeDesc);

        for (const cat of ['ptt', 'adm']) {
            const b = data.cursor?.[cat];
            if (!b) continue;
            if (b.newest) cursor[cat].newest = b.newest;

            if (!polling) {
                if (b.oldest) cursor[cat].oldest = b.oldest;
                cursor[cat].more = !!b.more;
            }
        }
        return fresh.length;
    }

    async function tick() {
        $('loading-indicator').hidden = false;
        try {

            const polling = !!(cursor.ptt.newest || cursor.adm.newest);
            const qs = polling
                ? '?since_ptt=' + encodeURIComponent(cursor.ptt.newest)
                  + '&since_adm=' + encodeURIComponent(cursor.adm.newest)
                : '';
            const res = await fetch('fetch_logs.php' + qs, { headers: { Accept: 'application/json' } });
            if (res.status === 204) {

                $('logStale').hidden = true;
                $('logError').hidden = true;
                stamp();
                slower();
                return;
            }
            if (!res.ok) throw new Error(res.status);
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            const added = absorb(data, { polling });
            stamp();
            $('logStale').hidden = true;
            $('logError').hidden = true;
            if (added) { faster(); render(); } else { slower(); }

            if (polling && (data.cursor?.ptt?.more || data.cursor?.adm?.more)) {
                setTimeout(tick, 250);
            }
        } catch {

            $('logStale').hidden = false;
        } finally {
            $('loading-indicator').hidden = true;
        }
    }

    function stamp() {
        $('last-update-time').textContent = new Date().toLocaleTimeString(LOCALE,
            { hour12: false, timeZone: 'Asia/Jakarta' });
    }

    async function loadOlder() {
        if (loadingOlder || exhausted()) return;
        if (!cursor.ptt.oldest && !cursor.adm.oldest) return;
        loadingOlder = true;
        $('loading-indicator').hidden = false;
        try {

            const qs = new URLSearchParams();
            if (cursor.ptt.more && cursor.ptt.oldest) qs.set('before_ptt', cursor.ptt.oldest);
            if (cursor.adm.more && cursor.adm.oldest) qs.set('before_adm', cursor.adm.oldest);
            if (![...qs.keys()].length) return;

            const res = await fetch('fetch_logs.php?' + qs.toString(),
                                    { headers: { Accept: 'application/json' } });
            if (res.status === 204) { cursor.ptt.more = cursor.adm.more = false; return; }
            if (!res.ok) throw new Error(res.status);
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            if (!absorb(data, { append: true })) {
                cursor.ptt.more = cursor.adm.more = false;
            }
            render();
        } catch {
            $('logStale').hidden = false;
        } finally {
            loadingOlder = false;
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

    const searchBox = $('logSearch');
    const searchToggle = $('logSearchToggle');
    const searchInput = $('logSearchInput');

    function openSearch() {
        searchBox.dataset.expanded = 'true';
        searchToggle.setAttribute('aria-expanded', 'true');
        searchInput.focus();
    }

    function closeSearch() {
        if (searchInput.value !== '') return;
        delete searchBox.dataset.expanded;
        searchToggle.setAttribute('aria-expanded', 'false');
    }

    searchToggle.addEventListener('click', openSearch);
    searchInput.addEventListener('blur', closeSearch);
    searchInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        searchInput.value = '';
        query = '';
        page = 1;
        window.AM2?.filtered(body);
        render();
        closeSearch();
        searchToggle.focus();
    });

    const MIN_EVERY = 4000;
    const MAX_EVERY = 30000;
    let every = MIN_EVERY, timer = null;

    const faster = () => { every = MIN_EVERY; };
    const slower = () => { every = Math.min(MAX_EVERY, Math.round(every * 1.5)); };

    function schedule() {
        clearTimeout(timer);

        timer = setTimeout(async () => {

            if (page === 1 && !document.hidden) await tick();
            schedule();
        }, every);
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) { clearTimeout(timer); return; }
        faster();
        if (page === 1) tick();
        schedule();
    });

    $('logMore')?.addEventListener('click', loadOlder);

    tick();
    schedule();
})();
</script>
</body>
</html>
