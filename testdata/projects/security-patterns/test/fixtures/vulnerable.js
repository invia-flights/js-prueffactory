'use strict';

// Test data: a deliberately vulnerable sample for a scanner's own tests.
module.exports = (req) => eval(req.query.code);
