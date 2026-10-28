'use strict';

// One function that does too much on purpose: its cyclomatic complexity is
// above 20, its cognitive complexity above 15 and it is longer than 50 lines.
function shippingCost(parcel, destination, options) {
  let cost = 0;
  if (!parcel || !destination) {
    return null;
  }
  if (parcel.weight <= 0) {
    return 0;
  }
  if (destination.country === 'DE') {
    if (parcel.weight < 1) {
      cost = 3.9;
    } else if (parcel.weight < 5) {
      cost = 5.9;
    } else if (parcel.weight < 10) {
      cost = 7.9;
    } else {
      cost = 12.9;
    }
  } else if (destination.country === 'AT' || destination.country === 'CH') {
    if (parcel.weight < 1) {
      cost = 8.9;
    } else if (parcel.weight < 5) {
      cost = 11.9;
    } else {
      cost = 18.9;
    }
  } else if (destination.zone === 'EU') {
    cost = parcel.weight < 5 ? 14.9 : 24.9;
  } else {
    for (const surcharge of destination.surcharges || []) {
      if (surcharge.active && surcharge.amount > 0) {
        if (surcharge.perKilo) {
          cost += surcharge.amount * parcel.weight;
        } else {
          cost += surcharge.amount;
        }
      }
    }
    cost += 39;
  }
  if (options) {
    if (options.express && destination.country === 'DE') {
      cost += 6;
    } else if (options.express) {
      cost += 15;
    }
    if (options.insured && parcel.value > 500) {
      cost += parcel.value * 0.01;
    }
    if (options.fragile || options.oversized) {
      cost += options.oversized ? 20 : 4;
    }
    while (options.coupons && options.coupons.length > 0 && cost > 0) {
      const coupon = options.coupons.pop();
      cost = Math.max(0, cost - coupon);
    }
  }
  return Math.round(cost * 100) / 100;
}

module.exports = { shippingCost };
