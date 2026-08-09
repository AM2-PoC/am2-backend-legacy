<?php
/**
 * The panel's client for the node relay.
 *
 * These four calls used to be copy-pasted into eight files — syncUserChannels
 * six times, notifyForceLogout and notifyPermissionUpdate twice each — and the
 * copies had drifted:
 *
 *   - three of the six syncUserChannels copies never sent the API key, so they
 *     would have started failing silently the moment AM2_API_AUTH_MODE was set
 *     to enforce. The response is discarded, so nothing would have surfaced.
 *   - the two notifyPermissionUpdate copies disagreed on the duplex fallback,
 *     one defaulting to FULL and the other to HALF.
 *
 * Every call is fire-and-forget with a two second timeout: the panel must not
 * block on the relay, and it already ignores the response.
 */

require_once __DIR__ . '/config.php';

/**
 * Send a request to the relay. Returns nothing — callers never read the body.
 */
function am2_node_call(string $path, ?array $payload = null): void
{
    $url = AM2_NODE_BASE . $path;

    if ($payload === null) {
        $header = am2_node_auth_header();
        $options = ['http' => ['timeout' => 2, 'header' => $header]];
    } else {
        $header = "Content-type: application/json\r\n" . am2_node_auth_header();
        $options = ['http' => [
            'header'  => $header,
            'method'  => 'POST',
            'content' => json_encode($payload),
            'timeout' => 2,
        ]];
    }

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 2);
        curl_setopt($ch, CURLOPT_HTTPHEADER, array_values(array_filter(
            array_map('trim', explode("\r\n", $header))
        )));
        if ($payload !== null) {
            curl_setopt($ch, CURLOPT_POST, true);
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
        }
        @curl_exec($ch);
        curl_close($ch);
        return;
    }

    @file_get_contents($url, false, stream_context_create($options));
}

/** Push a user's channel list to their live session. */
function syncUserChannels($userId): void
{
    am2_node_call('/api/admin/sync-channels?userId=' . urlencode((string) $userId));
}

/**
 * Push a permission change to a live session.
 *
 * The fallback is HALF DUPLEX, matching the column default and the stricter of
 * the two values the old copies disagreed on. Both call sites pass an explicit
 * value, so the fallback is a guard rather than a behaviour.
 */
function notifyPermissionUpdate($userId, $maps, $p2p, $video, $duplex = 'HALF DUPLEX'): void
{
    am2_node_call('/api/admin/update-permissions', [
        'userId'           => $userId,
        'enable_maps'      => (bool) $maps,
        'enable_p2p'       => (bool) $p2p,
        'enable_ptt_video' => (bool) $video,
        'duplex_mode'      => $duplex,
    ]);
}

/** Disconnect a user from the relay. */
function notifyForceLogout($userId): void
{
    am2_node_call('/api/admin/force-logout', ['userId' => $userId]);
}

/** Re-evaluate every live session belonging to one branch admin. */
function notifyNodeServerToRefresh($adminId): void
{
    am2_node_call('/api/admin/refresh-branch-permissions', ['adminId' => $adminId]);
}
