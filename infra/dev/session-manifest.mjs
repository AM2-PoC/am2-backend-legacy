/**
 * Validation for a development session manifest.
 *
 * This module decides what a session is allowed to delete, and it is the only
 * thing standing between an automated cleanup and a canonical checkout. It
 * deliberately contains no deletion of any kind: it answers questions, and a
 * handler that acts on the answers is a separate concern that must not be able
 * to reach a resource this file has not approved.
 *
 * Every rule refuses rather than guesses. A manifest that is merely odd — an
 * unrecognised field, a path it cannot resolve, a resource with no proof of
 * ownership — is rejected, because the failure mode of guessing is deleting
 * something that was not the session's.
 */
import { resolve, sep } from 'node:path';

/** Resource kinds a session may record. Anything else is not understood well enough to remove. */
const RESOURCE_TYPES = new Set([
    'temp_dir', 'temp_file', 'git_worktree', 'docker_container', 'docker_image',
    'docker_volume', 'docker_network', 'process', 'emulator_avd', 'build_cache',
]);

/** The only class a cleanup handler may destroy. */
const DISPOSABLE = 'disposable';
const RETENTION_CLASSES = new Set([DISPOSABLE, 'release', 'source', 'evidence', 'shared']);

/**
 * Types whose id is a filesystem path and must therefore live inside the
 * session root. Exported so callers and tests ask this module which kinds are
 * paths instead of keeping their own copy of the answer, which is how the two
 * drift apart.
 */
export const PATH_TYPES = new Set(['temp_dir', 'temp_file', 'git_worktree', 'build_cache']);

const SESSION_ID = /^[a-z0-9]{8,64}$/;
const SESSION_ROOT = /^\/tmp\/am2-session-[a-z0-9]{8,64}$/;

/**
 * Checkouts that are the source of truth. These are never session scratch, no
 * matter what a manifest claims, and naming one is treated as a manifest bug
 * rather than an instruction.
 */
const CANONICAL_REPOS = [
    '/home/am2deploy/am2-main',
    '/home/am2deploy/am2-android-client',
    '/home/am2deploy/am2-android-admin',
];

/** Paths that are the machine rather than anything a session created. */
const HOST_PATHS = [
    '/', '/home', '/home/am2deploy', '/var', '/var/www', '/etc', '/opt', '/usr',
    '/tmp', '/root', '/boot', '/srv',
];

/** Runtime names that outlive any session. Docker's built-in networks are included because removing one breaks every container on the host. */
const SHARED_RUNTIME = /^(bridge|host|none|am2-api|am2[-_](relay|webadmin|db|redis)|mailcow)/i;

/** Field names that have no business in a manifest and may carry a credential. */
const SECRET_FIELDS = /^(password|passwd|secret|token|api_?key|credential|private_?key|authorization)$/i;

/** Values shaped like a credential, wherever they appear. */
const SECRET_VALUES = [
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    /\beyJ[A-Za-z0-9_-]{10,}\./,
    /\$2[aby]\$[0-9]{2}\$[A-Za-z0-9./]{20,}/,
];

const MANIFEST_FIELDS = new Set(['session_id', 'session_root', 'created_at', 'resources']);
const RESOURCE_FIELDS = new Set(['type', 'id', 'owner_session', 'ownership_proof', 'retention']);

/** True when `candidate` is strictly inside `root`, by resolved path rather than by prefix. */
function containedIn(root, candidate) {
    const base = resolve(root);
    const target = resolve(candidate);
    return target !== base && target.startsWith(base + sep);
}

function looksSecret(value) {
    return typeof value === 'string' && SECRET_VALUES.some((pattern) => pattern.test(value));
}

/**
 * Checks a manifest against every boundary.
 *
 * @returns {{ok: boolean, errors: string[]}} `ok` only when nothing was wrong;
 * the errors are all of them, not the first, so a broken manifest is fixed in
 * one pass rather than one refusal at a time.
 */
export function validateManifest(manifest) {
    const errors = [];
    const refuse = (message) => errors.push(message);

    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
        return { ok: false, errors: ['manifest is not an object'] };
    }

    for (const field of Object.keys(manifest)) {
        if (!MANIFEST_FIELDS.has(field)) refuse(`unknown manifest field: ${field}`);
        if (SECRET_FIELDS.test(field)) refuse(`manifest field may carry a credential: ${field}`);
    }

    const { session_id: sessionId, session_root: sessionRoot, resources } = manifest;

    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
        refuse('session_id is missing or malformed; ownership cannot be established');
    }
    if (typeof sessionRoot !== 'string' || !SESSION_ROOT.test(sessionRoot)) {
        refuse('session_root is missing or is not a session-owned directory');
    }
    if (!Array.isArray(resources)) {
        refuse('resources is missing');
        return { ok: false, errors };
    }

    resources.forEach((resource, index) => {
        const at = `resources[${index}]`;
        if (resource === null || typeof resource !== 'object' || Array.isArray(resource)) {
            refuse(`${at} is not an object`);
            return;
        }

        for (const [field, value] of Object.entries(resource)) {
            if (!RESOURCE_FIELDS.has(field)) refuse(`${at} has unknown field: ${field}`);
            if (SECRET_FIELDS.test(field)) refuse(`${at} field may carry a credential: ${field}`);
            if (looksSecret(value)) refuse(`${at}.${field} looks like a credential`);
        }

        const { type, id, owner_session: owner, ownership_proof: proof, retention } = resource;

        if (!RESOURCE_TYPES.has(type)) refuse(`${at} has unknown type: ${type}`);
        if (typeof id !== 'string' || id.length === 0) refuse(`${at} has no id`);
        if (!RETENTION_CLASSES.has(retention)) refuse(`${at} has unknown retention: ${retention}`);
        if (owner !== sessionId) refuse(`${at} is owned by another session: ${owner}`);
        if (typeof proof !== 'string' || proof.length === 0) {
            refuse(`${at} has no ownership proof; refusing rather than deleting on assumption`);
        }

        if (typeof id !== 'string') return;

        if (CANONICAL_REPOS.some((repo) => resolve(id) === resolve(repo))) {
            refuse(`${at} names a canonical repository: ${id}`);
        }
        if (HOST_PATHS.some((path) => resolve(id) === resolve(path))) {
            refuse(`${at} names the host itself: ${id}`);
        }
        if (SHARED_RUNTIME.test(id)) {
            refuse(`${at} names a shared runtime resource: ${id}`);
        }
        if (PATH_TYPES.has(type) && typeof sessionRoot === 'string' && !containedIn(sessionRoot, id)) {
            refuse(`${at} is outside the session root: ${id}`);
        }
    });

    return { ok: errors.length === 0, errors };
}

/**
 * The resources a cleanup handler may act on.
 *
 * Returns nothing at all for a manifest that did not validate, and nothing for
 * any resource that is not disposable. A caller cannot reach a protected
 * resource by ignoring a return value it did not check.
 */
export function cleanupTargets(manifest) {
    if (!validateManifest(manifest).ok) return [];
    return manifest.resources.filter((resource) => resource.retention === DISPOSABLE);
}
