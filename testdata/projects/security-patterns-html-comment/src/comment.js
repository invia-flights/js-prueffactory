'use strict';

const crypto = require('node:crypto');
const OPENER = /<!--/;
const label = process.env.LABEL ?? 'none';
crypto.createHash('sha1').update(OPENER.source + label); <!-- a real comment: Node ignores the rest of this line
