'use strict';

const crypto = require('node:crypto');
module.exports.shortId = (value) => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 6);
