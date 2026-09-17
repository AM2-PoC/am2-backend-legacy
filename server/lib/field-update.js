'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
