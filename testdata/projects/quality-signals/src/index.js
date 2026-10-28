'use strict';

const { alpha } = require('./cycle-a');
const { invoiceTotal } = require('./invoice');
const { orderTotal } = require('./order');
const { shippingCost } = require('./shipping');

module.exports = { alpha, invoiceTotal, orderTotal, shippingCost };
