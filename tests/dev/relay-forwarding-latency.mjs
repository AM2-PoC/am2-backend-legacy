/**
 * How much delay does the relay itself add to speech?
 *
 * Every latency number so far came from a handset: held, instrumented, read
 * back, and impossible to compare across two devices because their monotonic
 * clocks share no origin. So the relay's own contribution has never been
 * measured -- it was assumed, argued about, and worked around.
 *
 * Two clients in *one process* remove that problem entirely. The send timestamp
 * and the arrival timestamp come from the same `process.hrtime`, so subtracting
 * them is legitimate. What it measures is exactly the relay: socket in, switch,
 * fan-out, socket out. Nothing else is in the path when CT_NODE_URL points at
 * the node directly.
 *
 * It also answers the question that matters more than the median: does the
 * delay *grow* while the key is held? A queue that builds shows up as a rising
 * line even when the median looks fine, and that is the shape the field reports.
 *
 * Run:  node tests/dev/relay-forwarding-latency.mjs [frames]
 * Needs infra/scripts/ptt-harness-fixtures.sh to have run.
 */
import { createRequire } from 'node:module';
import { env, NODE_URL } from '../contract/helpers.mjs';

const require = createRequire(process.env.CT_SERVER_JS || '/var/www/am2/staging/current/server/server.js');
const WebSocket = require('ws');

const WS_URL = (process.env.CT_NODE_URL || NODE_URL).replace(/^http/, 'ws');
const CHANNEL = 'ct_channel_a';
const FRAME_INTERVAL_MS = 20;
const FRAME_BYTES = 45;          // one 16 kHz Opus frame, near enough
const TIMEOUT = 8000;
const FRAMES = Number(process.argv[2]) || 250;   // 5 seconds of speech

function connect(label) {
    const ws = new WebSocket(WS_URL);
    ws.inbox = [];
    ws.label = label;
    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            const buffer = Buffer.from(data);
            if (ws.onAudio) ws.onAudio(buffer, process.hrtime.bigint());
            return;
        }
        try { ws.inbox.push(JSON.parse(data.toString())); } catch { /* never happens */ }
    });
    return new Promise((resolve, reject) => {
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
        setTimeout(() => reject(new Error(`${label}: connect timed out`)), TIMEOUT);
    });
}

const send = (ws, type, data = {}) => ws.send(JSON.stringify({ type, data }));

async function waitFor(ws, type, ms = TIMEOUT) {
    const deadline = Date.now() + ms;
    for (;;) {
        const hit = ws.inbox.find((m) => m.type === type);
        if (hit) return hit;
        if (Date.now() > deadline) {
            throw new Error(`${ws.label}: no ${type} within ${ms}ms; saw [${ws.inbox.map((m) => m.type).join(', ')}]`);
        }
        await new Promise((r) => setTimeout(r, 20));
    }
}

async function signIn(ws, username) {
    send(ws, 'app_login', {
        username,
        password: env.CT_PTT_PASS,
        current_device_id: `latency-${username}-${Date.now()}`,
        client_version_code: 999999,
        client_version_name: 'relay-latency-probe',
    });
    return waitFor(ws, 'login_success');
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

async function main() {
    if (!env.CT_PTT_PASS) throw new Error('run infra/scripts/ptt-harness-fixtures.sh first');

    const speaker = await connect('speaker');
    const listener = await connect('listener');
    try {
        await signIn(speaker, 'CT_A1');
        await signIn(listener, 'CT_A2');
        for (const ws of [speaker, listener]) {
            send(ws, 'join_channel', { new_channel_slug: CHANNEL });
            await waitFor(ws, 'join_channel_success');
        }

        // The sequence number rides in the frame so an arrival can be matched to
        // its send without assuming nothing was dropped -- and drops are exactly
        // what this is looking for.
        const sentAt = new Map();
        const samples = [];
        listener.onAudio = (buffer, arrivedAt) => {
            if (buffer.length < 5 || buffer[0] !== 1) return;
            const sequence = buffer.readUInt32BE(1);
            const departed = sentAt.get(sequence);
            if (departed === undefined) return;
            samples.push({ sequence, ms: Number(arrivedAt - departed) / 1e6 });
        };

        send(speaker, 'ptt_audio_start', { trace_id: 990001 });
        await waitFor(listener, 'ptt_active_status');

        for (let sequence = 0; sequence < FRAMES; sequence += 1) {
            const frame = Buffer.alloc(FRAME_BYTES);
            frame[0] = 1;
            frame.writeUInt32BE(sequence, 1);
            sentAt.set(sequence, process.hrtime.bigint());
            speaker.send(frame, { binary: true });
            await new Promise((r) => setTimeout(r, FRAME_INTERVAL_MS));
        }
        await new Promise((r) => setTimeout(r, 500));   // let the tail arrive
        send(speaker, 'ptt_audio_end', {});

        if (!samples.length) {
            console.log('NO FRAMES ARRIVED -- the relay forwarded nothing');
            return;
        }

        const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
        const first = samples.slice(0, Math.floor(samples.length / 4));
        const last = samples.slice(-Math.floor(samples.length / 4));
        const mean = (rows) => rows.reduce((total, row) => total + row.ms, 0) / rows.length;

        console.log(`frames_sent=${FRAMES} frames_arrived=${samples.length} lost=${FRAMES - samples.length}`);
        console.log(`relay_ms p50=${percentile(sorted, 0.5).toFixed(2)}`
            + ` p95=${percentile(sorted, 0.95).toFixed(2)}`
            + ` max=${sorted[sorted.length - 1].toFixed(2)}`);
        // Growth is the tell. A queue that builds while the key is held shows up
        // here even when the median looks healthy.
        console.log(`first_quarter_mean=${mean(first).toFixed(2)}ms`
            + ` last_quarter_mean=${mean(last).toFixed(2)}ms`
            + ` growth=${(mean(last) - mean(first)).toFixed(2)}ms`);
    } finally {
        for (const ws of [speaker, listener]) {
            if (ws && ws.readyState === WebSocket.OPEN) ws.close();
        }
    }
}

main().then(
    () => process.exit(0),
    (error) => { console.error(error.message); process.exit(1); },
);
