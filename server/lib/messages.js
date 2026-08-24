/*
 * Every string the relay puts in front of an operator, in one place.
 *
 * These are not log lines. Each one is a `data.message` the handset displays
 * verbatim -- WebSocketManager reads it straight into a toast, and its own
 * fallback for a missing one is "Permintaan Gagal". So the audience reads
 * Indonesian, and that is the decision until i18n lands.
 *
 * They were literals scattered through protocol.js, and it showed: the same
 * sentence appeared three times, two of them English while the handlers beside
 * them spoke Indonesian, and a contract test demanding English had sat red for
 * weeks without anyone reconciling the two. Naming them makes the set countable
 * -- the contract test pins this object, the protocol tests compare against it
 * instead of guessing at a regex, and i18n has exactly one file to translate.
 *
 * A new operator-facing string belongs here before it belongs in a handler.
 */
module.exports = Object.freeze({
    /** The unit holds no row for the channel it asked to join. */
    NOT_A_CHANNEL_MEMBER: 'Bukan anggota channel ini',

    /** No socket for the target, or the socket has closed. */
    PEER_OFFLINE: 'Personel sedang offline',

    /** The target is already in a private call with somebody else. */
    PEER_BUSY: 'Personel sedang dalam panggilan lain',

    /*
     * Reachable but not callable -- a different tenant, or private calling off
     * on either side. Deliberately says nothing about which: the caller has no
     * business learning another tenant's shape.
     */
    PRIVATE_CALL_UNAVAILABLE_FOR_PEER: 'Panggilan privat tidak tersedia untuk personel ini',
    VIDEO_CALL_UNAVAILABLE_FOR_PEER: 'Panggilan video privat tidak tersedia untuk personel ini',

    /** The invitation could not be created, for a reason that is not busy. */
    PRIVATE_CALL_UNAVAILABLE: 'Panggilan privat tidak tersedia',
    VIDEO_CALL_UNAVAILABLE: 'Panggilan video privat tidak tersedia',

    /** An answer arrived for a call that was never placed, or has expired. */
    NO_PENDING_INVITATION: 'Tidak ada undangan panggilan yang menunggu',
});
