'use strict';

const crypto = require('node:crypto');

module.exports.digest = (value) => crypto.createHash('md5').update(String(value)).digest('hex');
