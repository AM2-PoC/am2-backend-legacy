'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * What the field channel may advertise, decided in one place.
 *
 * The channel is a manifest and the APK it names. When the panel and this relay
 * stopped reading a stale database table and started reading that manifest,
 * production began answering `success: true` for build 1 -- a manifest written
 * in May naming an APK that has never been in the directory. Before the change
 * it answered "No version info found", which was at least true.
 *
 * A handset told about a build it cannot download gets a failed fetch and no
 * explanation. The admin channel has refused this since its validator landed:
 * the published URL has to resolve to a real regular file directly below the
 * update directory. This is the same rule for the other channel.
 *
 * Deliberately not a digest check. The admin validator hashes the APK because
 * it decides what to *publish*; this decides what to *answer*, on every
 * request, and hashing a twenty-megabyte file per call would trade a real cost
 * for a check the handset already performs against the same manifest.
 * publish-field-update.sh does the hashing once, where it belongs.
 */
function fieldUpdate(updateDir) {
    const refuse = (reason) => ({ valid: false, reason, manifest: null });

    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(updateDir, 'version.json'), 'utf8'));
    } catch (err) {
        return refuse('no readable manifest has been published');
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        return refuse('the manifest is not an object');
    }
    if (!Number.isInteger(manifest.version_code) || manifest.version_code <= 0) {
        return refuse('the manifest names no build');
    }

    const url = String(manifest.update_url || manifest.download_url || '');
    if (url === '') {
        return refuse('the manifest names no download');
    }

    // basename only, then resolved and checked to be *directly* below the
    // update directory: the name comes out of a file on disk, so a path in it
    // is a path this would otherwise follow.
    const name = path.basename(url);
    const apk = path.resolve(updateDir, name);
    if (path.dirname(apk) !== path.resolve(updateDir) || !name.endsWith('.apk')) {
        return refuse('the download URL does not name an APK in the update directory');
    }
    let stat;
    try {
        stat = fs.lstatSync(apk);
    } catch {
        return refuse(`the published APK is not there: ${name}`);
    }
    if (!stat.isFile()) {
        return refuse(`the published APK is not a regular file: ${name}`);
    }

    return { valid: true, reason: '', manifest };
}

module.exports = { fieldUpdate };
