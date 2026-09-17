'use strict';

const crypto = require('node:crypto');

const TOKEN_BYTES = 32;

function newToken() {
    return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = { newToken, hashToken, TOKEN_BYTES };
