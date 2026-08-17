import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('every accepted location write stamps the dedicated sample time', () => {
    // WebAdmin/update_location.php was the second writer and is gone: it took a
    // user_id from the request and placed that unit anywhere, for any caller
    // holding a panel session, with no check that they owned it. Nothing called
    // it -- the handset reports position over the WebSocket -- so the relay is
    // now the only path a coordinate can arrive by.
    for (const file of ['server/lib/broadcast.js']) {
        const src = read(file);
        assert.match(src, /location_updated_at\s*=\s*(?:CURRENT_TIMESTAMP|NOW\(\))/i,
            `${file} stores coordinates without a location timestamp`);
    }
});

test('login and account edits never make a location fresh', () => {
    for (const file of ['server/lib/protocol.js', 'server/lib/routes.js', 'WebAdmin/user_rules.php']) {
        const src = read(file);
        assert.doesNotMatch(src, /location_updated_at\s*=/i,
            `${file} makes non-location activity look like a fresh GPS sample`);
    }
});

test('live-track API exposes identity validity age and three freshness states', () => {
    const src = read('WebAdmin/get-users-ajax.php');
    for (const field of [
        'entity_type', 'location_updated_at', 'location_age_seconds',
        'has_location', 'freshness', 'accuracy'
    ]) {
        assert.match(src, new RegExp(field), `API contract is missing ${field}`);
    }
    assert.match(src, /\$age\s*<\s*60[\s\S]*fresh/i);
    assert.match(src, /\$age\s*<=\s*300[\s\S]*delayed/i);
    assert.match(src, /stale/i);
    assert.match(src, /BETWEEN\s+-90\s+AND\s+90/i);
    assert.match(src, /BETWEEN\s+-180\s+AND\s+180/i);
});

test('legacy is_stale remains an alias for Admin Native compatibility', () => {
    const src = read('WebAdmin/get-users-ajax.php');
    assert.match(src, /['"]is_stale['"]\s*=>\s*\$freshness\s*===\s*['"]stale['"]/i);
});

test('live-track rendering keeps identity freshness TX and accuracy independent', () => {
    const src = read('WebAdmin/livetrack.php');
    for (const hook of [
        'entity-user', 'entity-tracker', 'freshness-fresh',
        'freshness-delayed', 'freshness-stale', 'speaking-marker'
    ]) assert.match(src, new RegExp(hook), `rendering contract is missing ${hook}`);
    assert.match(src, /const\s+locationCircles\s*=\s*\{\}/);
    assert.match(src, /L\.circle\s*\(/);
    assert.match(src, /setRadius\s*\(/);
    assert.match(src, /setPopupContent\s*\(/);
    assert.match(src, /class=\\?"sr-only\\?"/,
        'marker identity/freshness is visual-only and unavailable to assistive technology');
    assert.match(src, /iconAnchor:\s*showLabel\s*\?\s*\[50,\s*32\]/,
        'labelled marker dot is not anchored on its coordinate');
    const css = read('WebAdmin/asset/css/tailwind.src.css');
    assert.match(css, /\.custom-marker\s+\.pulse-dot[\s\S]*left:\s*50%[\s\S]*bottom:\s*0/,
        'the 16px dot is not centred inside the 100px labelled marker icon');
    for (const field of ['entity_type', 'freshness', 'accuracy', 'location_age_seconds']) {
        assert.match(src, new RegExp(field), `rendering does not consume ${field}`);
    }
    const model = read('WebAdmin/asset/js/src/livetrack-model.js');
    assert.match(model, /has_location/, 'coordinate validation ignores the API has_location decision');
});

test('live-track reports polling failure without deleting last known positions', () => {
    const src = read('WebAdmin/livetrack.php');
    assert.match(src, /id=["']feed-status["']/);
    assert.match(src, /FEED_DISCONNECTED/);
    assert.match(src, /feedFailures\s*>=\s*2/);
    assert.match(src, /setInterval\s*\(syncData,\s*3000\s*\)/);
});

test('live-track polling cannot overlap and has a bounded timeout', () => {
    const src = read('WebAdmin/livetrack.php');
    assert.match(src, /if\s*\(syncInFlight\)\s*return/,
        'a slow request can overlap the next polling interval');
    assert.match(src, /new AbortController\s*\(\)/,
        'a hung request can leave the feed permanently looking connected');
    assert.match(src, /signal:\s*controller\.signal/);
    assert.match(src, /clearTimeout\s*\(timeout\)/);
    assert.match(src, /finally\s*\{[\s\S]*syncInFlight\s*=\s*false/,
        'the in-flight guard must be released on success and failure');
});

test('browser module import is relative and every operator label is translated', () => {
    const src = read('WebAdmin/livetrack.php');
    assert.match(src, /am2_asset_url\(['"]\.\/asset\/js\/src\/livetrack-model\.js['"]\)/,
        'a bare module specifier fails in browsers');
    for (const file of ['WebAdmin/lang/id.php', 'WebAdmin/lang/en.php']) {
        const locale = read(file);
        for (const key of [
            'track.type_user', 'track.type_tracker', 'track.fresh', 'track.delayed',
            'track.stale', 'track.fresh_locations', 'track.last_location',
            'track.accuracy', 'track.no_location', 'track.feed_disconnected'
        ]) assert.match(locale, new RegExp(`['"]${key.replace('.', '\\.')}['"]`), `${file} missing ${key}`);
    }
});
