'use strict';

const crypto = require('node:crypto');

const OPENER = /<!--/;
const label = process.env.LABEL ?? 'none';

module.exports.fingerprint = (value) => crypto.createHash('md5').update(OPENER.source + label + String(value)).digest('hex');
