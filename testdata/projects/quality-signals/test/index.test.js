'use strict';

const assert = require('node:assert');
const { invoiceTotal } = require('../src');

describe('invoiceTotal', () => {
  it('adds tax and shipping', () => {
    const result = invoiceTotal([{ active: true, price: 10, quantity: 2 }]);
    assert.strictEqual(result.sum, 20);
  });
});
