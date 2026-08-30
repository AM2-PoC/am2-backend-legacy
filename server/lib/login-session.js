'use strict';

const { newToken, hashToken } = require('./device-tokens');

const LoginSessionError = Object.freeze({
    AUTH_STATE_CHANGED: 'AUTH_STATE_CHANGED',
});

function authStateChanged() {
    const error = new Error('login authorization state changed');
    error.code = LoginSessionError.AUTH_STATE_CHANGED;
    return error;
}

/**
 * Publish session state and rotate the device token under the users-row lock.
 * Force logout takes the same lock, so one complete transition wins and the
 * later transition observes and revokes the token produced by the earlier one.
 */
async function commitLoginSession(pool, {
    userId,
    deviceId,
    expectedForceLogout = false,
    expectedCurrentDeviceId = null,
    expectedPasswordHash = null,
    sourceTokenHash = null,
    sourceDeviceId = null,
    beforeIssue = null,
} = {}) {
    const uid = String(userId);
    const token = newToken();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const locked = await client.query(
            'SELECT current_device_id, force_logout, password FROM public.users WHERE id = $1 FOR UPDATE',
            [uid],
        );
        if (locked.rows.length !== 1) throw authStateChanged();
        const row = locked.rows[0];
        const lockedDeviceId = row.current_device_id ?? null;
        const expectedDeviceId = expectedCurrentDeviceId ?? null;
        if (Boolean(row.force_logout) !== Boolean(expectedForceLogout)
            || lockedDeviceId !== expectedDeviceId
            || (expectedPasswordHash !== null && row.password !== expectedPasswordHash)) {
            throw authStateChanged();
        }
        if (sourceTokenHash) {
            const source = await client.query(
                'SELECT user_id, device_id FROM public.device_tokens WHERE token_hash = $1 FOR UPDATE',
                [sourceTokenHash],
            );
            if (source.rows.length !== 1
                || String(source.rows[0].user_id) !== uid
                || (source.rows[0].device_id ?? null) !== (sourceDeviceId ?? null)) {
                throw authStateChanged();
            }
        }
        if (beforeIssue) await beforeIssue();
        if (sourceTokenHash) {
            await client.query(
                'DELETE FROM public.device_tokens WHERE token_hash = $1',
                [sourceTokenHash],
            );
        }
        await client.query(
            'DELETE FROM public.device_tokens WHERE user_id = $1 AND device_id IS NOT DISTINCT FROM $2',
            [uid, deviceId || null],
        );
        await client.query(
            `INSERT INTO public.device_tokens (token_hash, user_id, device_id, last_used_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
            [hashToken(token), uid, deviceId || null],
        );
        await client.query(
            "UPDATE public.users SET force_logout = FALSE, status = 'online', updated_at = CURRENT_TIMESTAMP, current_device_id = $1, is_speaking = false WHERE id = $2",
            [deviceId || null, uid],
        );
        await client.query('COMMIT');
        return token;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('❌ Login session rollback error:', rollbackError.message);
        }
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { commitLoginSession, LoginSessionError };
