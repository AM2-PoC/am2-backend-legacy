<?php
require_once __DIR__ . '/config.php';

function am2_node_transport(string $url, string $header, ?array $payload): ?string
{
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
        $body = @curl_exec($ch);
        curl_close($ch);
        return is_string($body) ? $body : null;
    }

    $options = ['http' => ['timeout' => 2, 'header' => $header, 'ignore_errors' => true]];
    if ($payload !== null) {
        $options['http']['method'] = 'POST';
        $options['http']['content'] = json_encode($payload);
    }
    $body = @file_get_contents($url, false, stream_context_create($options));
    return is_string($body) ? $body : null;
}

/* Return true only when the relay confirms success within the bounded transport timeout. */
function am2_node_call(string $path, ?array $payload = null): bool
{
    $header = $payload === null
        ? am2_node_auth_header()
        : "Content-type: application/json\r\n" . am2_node_auth_header();

    $body = am2_node_transport(AM2_NODE_BASE . $path, $header, $payload);
    if (!is_string($body) || $body === '') {
        return false;
    }
    $parsed = json_decode($body, true);
    return is_array($parsed) && ($parsed['success'] ?? false) === true;
}

function am2_node_get(string $path): ?array
{
    $body = am2_node_transport(AM2_NODE_BASE . $path, am2_node_auth_header(), null);
    if ($body === null || $body === '') {
        return null;
    }
    $parsed = json_decode($body, true);
    return is_array($parsed) ? $parsed : null;
}

/** Push a user's channel list to their live session. */
function syncUserChannels($userId): bool
{
    return am2_node_call('/api/admin/sync-channels?userId=' . urlencode((string) $userId));
}

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

function notifyForceLogout($userId): bool
{
    return am2_node_call('/api/admin/force-logout', ['userId' => $userId]);
}

/** Re-evaluate every live session belonging to one branch admin. */
function notifyNodeServerToRefresh($adminId): void
{
    am2_node_call('/api/admin/refresh-branch-permissions', ['adminId' => $adminId]);
}
