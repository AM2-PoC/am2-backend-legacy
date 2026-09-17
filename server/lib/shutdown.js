'use strict';

const { markCloseCause } = require('./disconnect-observability');

/* Stop accepting, let active transmissions finish, then close sockets cleanly. */

const CLOSE_GOING_AWAY = 1001;
const CLOSE_REASON = 'server restarting';

/* Map keys persist for channels; only Set members represent active transmissions. */
function transmitting(activeSpeakers) {
    let count = 0;
    for (const speakers of activeSpeakers.values()) {
        count += speakers ? speakers.size : 0;
    }
    return count;
}

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

    let closed = 0;
    for (const client of wss.clients) {
        markCloseCause(client, 'server_shutdown');
        client.close(CLOSE_GOING_AWAY, CLOSE_REASON);
        closed += 1;
    }
    log(`shutdown: closed ${closed} connection(s)`);
}

function installShutdown(options) {
    const {
        exit = (code) => process.exit(code),
        on = (signal, handler) => process.on(signal, handler),
        hardMs = 8000,
        log = console.log,
    } = options;

    let started = false;

    const handler = async (signal) => {
        // A second signal must not reset the bounded drain.
        if (started) {
            log(`shutdown: already draining, ignoring ${signal}`);
            return;
        }
        started = true;
        log(`shutdown: ${signal} received`);

        // A hung close must terminate before systemd escalates to SIGKILL.
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
