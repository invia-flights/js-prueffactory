'use strict';

const { save } = require('../src/orders');

describe('orders', () => {
  it('saves without waiting for the promise', () => {
    save(1);
  });
});
