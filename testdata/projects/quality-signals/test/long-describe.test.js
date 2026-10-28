'use strict';

const assert = require('node:assert');

// A describe callback of more than 50 lines in Test code. It is not a function
// of Source code, so quality.metrics must not count it as a long function.
describe('catalogue of shipping zones', () => {
  const alpha = { handling: 10 };
  const bravo = { handling: 20 };
  const charlie = { handling: 30 };
  const delta = { handling: 40 };
  const echo = { handling: 50 };
  const foxtrot = { handling: 60 };
  const golf = { handling: 70 };
  const hotel = { handling: 80 };
  const india = { handling: 90 };
  const juliet = { handling: 100 };
  const kilo = { handling: 110 };
  const lima = { handling: 120 };
  const mike = { handling: 130 };
  const november = { handling: 140 };
  const oscar = { handling: 150 };
  const papa = { handling: 160 };
  const quebec = { handling: 170 };
  const romeo = { handling: 180 };
  const sierra = { handling: 190 };
  const tango = { handling: 200 };
  const uniform = { handling: 210 };
  const victor = { handling: 220 };
  const whiskey = { handling: 230 };
  const xray = { handling: 240 };
  const yankee = { handling: 250 };
  const zulu = { handling: 260 };
  const amber = { handling: 270 };
  const birch = { handling: 280 };
  const cedar = { handling: 290 };
  const dune = { handling: 300 };
  const elm = { handling: 310 };
  const fern = { handling: 320 };
  const grove = { handling: 330 };
  const heath = { handling: 340 };
  const iris = { handling: 350 };
  const juniper = { handling: 360 };
  const plants = [amber, birch, cedar, dune, elm, fern, grove, heath, iris, juniper];
  const zones = [alpha, bravo, charlie, delta, echo, foxtrot, golf, hotel, india];
  const more = [juliet, kilo, lima, mike, november, oscar, papa, quebec, romeo];
  const last = [sierra, tango, uniform, victor, whiskey, xray, yankee, zulu];

  it('has a positive handling time in the first group', () => {
    assert.ok(zones.every((zone) => zone.handling > 0));
  });

  it('has a positive handling time in the second group', () => {
    assert.ok(more.every((zone) => zone.handling > 0));
  });

  it('has a positive handling time in the last group', () => {
    assert.ok(last.every((zone) => zone.handling > 0));
  });

  it('has a positive handling time in the plant group', () => {
    assert.ok(plants.every((zone) => zone.handling > 0));
  });
});
