'use strict';

function bundledTotal(items) {
  let sum = 0;
  for (const item of items) {
    if (item.active) {
      sum += item.price * item.quantity;
    }
  }
  const tax = sum * 0.19;
  const shipping = sum > 100 ? 0 : 5.5;
  return { sum, tax, shipping, total: sum + tax + shipping };
}

module.exports = { bundledTotal };
