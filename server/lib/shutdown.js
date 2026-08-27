'use strict';

/**
 * Ending a restart, rather than severing one.
 *
 * The unit sends SIGINT and nothing here handled it, so Node exited on the
 * spot. Every WebSocket died at the TCP layer with no close frame: a handset
 * did not learn it was disconnected until its socket timed out, and whoever was
 * mid-sentence was cut mid-word. `TimeoutStopSec=30` was granted by the unit
 * file and never used by anything.
 *
 * A WebSocket lives inside one process and cannot survive that process ending;
 * that part is inherent and no amount of care removes it. What is not inherent
 * is severing it without warning. So: stop accepting, let the transmissions
 * already in the air finish, then close every socket with 1001 "going away".
 *
 * The field client reconnects on any close code once its session is authorized
 * and its first retry has no delay, so a clean close is a sub-second gap
 * between transmissions rather than a cut inside one.
 *
 * Deliberately not done: refusing new transmissions during the drain. It would
 * need a flag threaded through the transmit path for a window measured in
 * seconds, and a press that lands inside it is cut exactly as it is today --
 * no worse, and rare enough not to be worth the surface.
 */

const CLOSE_GOING_AWAY = 1001;
const CLOSE_REASON = 'server restarting';

/**
 * How many people are actually talking.
 *
 * activeSpeakers is keyed by channel, and its values are Sets of speakers. A
 * channel gets its key the moment somebody joins and never loses it -- only the
 * members of its Set come and go -- so the Map's own size counts every channel
 * anybody has joined since boot, which on a live relay is permanently non-zero.
 *
 * Reading that size made the drain wait its entire grace on every shutdown and
 * then report "2 transmission(s) still open" on a relay whose database said
 * nobody was connected at all. The number to wait on is the members, not the
 * keys.
 */
function transmitting(activeSpeakers) {
    let count = 0;
    for (const speakers of activeSpeakers.values()) {
        count += speakers ? speakers.size : 0;
    }
    return count;
}

/**
 * Stop accepting, wait out what is in the air, then close.
 *
 * Every collaborator is a parameter -- the clock included -- because the only
 * honest test of a timeout is one that can move time.
 */
async function drain({
    server,
    wss,
    activeSpeakers,
    graceMs = 3000,
    pollMs = 100,
    now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = console.log,
}) {
    // First, and before anything is closed: a connection accepted after the
    // decision to stop is a connection that will be closed a moment later.
    server.close();
    log('shutdown: no longer accepting connections');

    const deadline = now() + graceMs;
    let waited = false;
    while (transmitting(activeSpeakers) > 0 && now() < deadline) {
        waited = true;
        await wait(pollMs);
    }
    if (waited) {
        const open = transmitting(activeSpeakers);
        log(open > 0
            ? `shutdown: ${open} transmission(s) still open at the deadline`
            : 'shutdown: transmissions finished');
    }

    // close(), never terminate(): the difference is a close frame the handset
    // acts on immediately against a socket that simply stops answering.
    let closed = 0;
    for (const client of wss.clients) {
        client.close(CLOSE_GOING_AWAY, CLOSE_REASON);
        closed += 1;
    }
    log(`shutdown: closed ${closed} connection(s)`);
}

/**
 * Wire the drain to the signals the unit actually sends.
 *
 * SIGINT because that is this service's KillSignal, SIGTERM because it is what
 * everything else sends and a relay that ignores it dies the old way.
 */
function installShutdown(options) {
    const {
        exit = (code) => process.exit(code),
        on = (signal, handler) => process.on(signal, handler),
        hardMs = 8000,
        log = console.log,
    } = options;

    let started = false;

    const handler = async (signal) => {
        // systemd sends SIGINT and then SIGKILL; an operator who is impatient
        // sends the first one twice. Restarting the drain would reset the
        // grace period and make the second signal slower than the first.
        if (started) {
            log(`shutdown: already draining, ignoring ${signal}`);
            return;
        }
        started = true;
        log(`shutdown: ${signal} received`);

        // The drain is bounded by its own grace, but a hung close or a socket
        // that never settles must not hold the unit until TimeoutStopSec turns
        // this into a SIGKILL -- which is the ungraceful exit being fixed.
        const hard = setTimeout(() => {
            log('shutdown: deadline reached, exiting anyway');
            exit(0);
        }, hardMs);
        if (hard.unref) hard.unref();

        try {
            await drain(options);
        } catch (err) {
            log(`shutdown: drain failed: ${err && err.message}`);
        } finally {
            clearTimeout(hard);
            exit(0);
        }
    };

    for (const signal of ['SIGTERM', 'SIGINT']) {
        on(signal, () => handler(signal));
    }
}

module.exports = { drain, installShutdown, transmitting, CLOSE_GOING_AWAY, CLOSE_REASON };
