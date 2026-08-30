'use strict';

/**
 * End the current device session and revoke exactly the credential that resumed it.
 *
 * The row is locked while current_device_id is read so login cannot rotate the
 * device identity between token deletion and the session-state update. A null
 * device id is matched with IS NOT DISTINCT FROM for legacy token rows.
 */
async function forceLogoutUser(pool, userId) {
    const uid = String(userId);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const locked = await client.query(
            'SELECT current_device_id FROM public.users WHERE id = $1 FOR UPDATE',
            [uid],
        );
        const deviceId = locked.rows[0]?.current_device_id ?? null;
        const tokenResult = await client.query(
            `DELETE FROM public.device_tokens
             WHERE user_id = $1 AND device_id IS NOT DISTINCT FROM $2`,
            [uid, deviceId],
        );
        const userResult = await client.query(
            `UPDATE public.users
             SET force_logout = TRUE, status = 'offline', current_device_id = NULL, is_speaking = false
             WHERE id = $1`,
            [uid],
        );
        await client.query('COMMIT');
        return {
            usersUpdated: userResult.rowCount || 0,
            tokensRevoked: tokenResult.rowCount || 0,
            deviceId,
        };
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('❌ Force logout rollback error:', rollbackError.message);
        }
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { forceLogoutUser };
