/* Operator-facing protocol messages remain centralized and Indonesian. */
module.exports = Object.freeze({
    /* The credential changed while login was in flight. */
    AUTH_STATE_CHANGED: 'Status login berubah. Silakan masuk lagi.',

    NOT_A_CHANNEL_MEMBER: 'Bukan anggota channel ini',

    PEER_OFFLINE: 'Personel sedang offline',

    PEER_BUSY: 'Personel sedang dalam panggilan lain',

    /*
     * Reachable but not callable -- a different tenant, or private calling off
     * on either side. Deliberately says nothing about which: the caller has no
     * business learning another tenant's shape.
     */
    PRIVATE_CALL_UNAVAILABLE_FOR_PEER: 'Panggilan privat tidak tersedia untuk personel ini',
    VIDEO_CALL_UNAVAILABLE_FOR_PEER: 'Panggilan video privat tidak tersedia untuk personel ini',

    PRIVATE_CALL_UNAVAILABLE: 'Panggilan privat tidak tersedia',
    VIDEO_CALL_UNAVAILABLE: 'Panggilan video privat tidak tersedia',

    NO_PENDING_INVITATION: 'Tidak ada undangan panggilan yang menunggu',
});
