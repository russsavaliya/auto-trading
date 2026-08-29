'use strict';
/**
 * Exit-rule checks. Run with `node scripts/test-exit-rules.js`.
 *
 * These exist because the trailing stop is the only piece of this system that
 * can lose money on a trade that was winning, and its arithmetic is not
 * obvious: the arm threshold and the retrace distance interact, and when
 * trailArmPct < trailPct/(1-trailPct) the trail arms a stop whose trigger is
 * already below the entry price. That shipped, and cost 7 trades between 17
 * and 28 Aug 2026 before it was spotted in the data rather than in the code.
 */
const config = require('../src/config/env');
const { evaluate, trailTriggerPrice } = require('../src/services/positionMonitor');

let failed = 0;

function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || (typeof actual === 'number' && Math.abs(actual - expected) < 1e-9);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${expected}, got ${actual}`}`);
  if (!ok) failed++;
}

const COST = config.roundTripCostPoints;
console.log(
  `config: stopLoss ${config.stopLossPct} · trailArm ${config.trailArmPct} · trail ${config.trailPct} · ` +
    `floor ${config.trailBreakevenFloor} · roundTripCost ${COST} pts · maxHold ${config.maxHoldMinutes}m\n`
);

// ---- the floor itself -----------------------------------------------------
console.log('-- trailTriggerPrice ------------------------------------------');

// A peak far above entry: the retrace level is well clear of the floor, so the
// floor must not interfere. This is the shape of every profitable opening
// trade, and it must behave exactly as it did before the floor existed.
check(
  'big winner — floor does not bind',
  trailTriggerPrice(381.35, 473.9),
  473.9 * (1 - config.trailPct)
);

// A peak just past the arm threshold: the raw retrace lands under water, so
// the floor has to lift it to entry + cost.
check('shallow peak — floor lifts trigger to breakeven', trailTriggerPrice(426.25, 441.6), 426.25 + COST);

// The exact boundary: a peak of entry/(1-trailPct) puts the retrace precisely
// at entry, which is still below entry+cost, so the floor still binds.
check('peak at the break-even multiple — floor still binds', trailTriggerPrice(100, 100 / (1 - config.trailPct)), 100 + COST);

check('trigger is never below entry', trailTriggerPrice(200, 201) >= 200, true);

// ---- evaluate() -----------------------------------------------------------
console.log('\n-- evaluate ---------------------------------------------------');

const base = { entry: 400, heldMinutes: 5 };

check('no rule fires while quietly in profit', evaluate({ ...base, current: 410, peak: 412 }), null);

check(
  'hard stop wins over everything',
  evaluate({ ...base, current: 400 * (1 - config.stopLossPct) - 1, peak: 500 }),
  'stop_loss'
);

// Peak +3.5% arms the trail under the old rule; its raw trigger (400*1.035*0.95
// = 393.3) is under water. At 396 the OLD code would have fired and booked a
// loss. With the floor the trigger is 403, so 396 is below it and it still
// fires — but the point is the trigger, not the firing: see the price check.
check('trail fires once price is back at the floor', evaluate({ ...base, current: 402, peak: 414 }), 'trailing_stop');

check(
  'trail does NOT fire while price is above the floor',
  evaluate({ ...base, current: 406, peak: 414 }),
  null
);

check('trail stays disarmed below the arm threshold', evaluate({ ...base, current: 395, peak: 405 }), null);

check(
  'time stop fires when nothing else does',
  evaluate({ ...base, current: 401, peak: 402, heldMinutes: config.maxHoldMinutes }),
  'time_stop'
);

// ---- regression: the exact trades the floor was built for ------------------
console.log('\n-- regression against real trades ------------------------------');

// Every trade entered before 10:00 between 17-28 Aug, with its recorded peak.
// The floor must not bind on any of them — these are the trades that work.
const MORNING = [
  [53, 356.8, 387.15], [64, 381.35, 473.9], [68, 312.4, 405.0], [72, 217.65, 232.65],
  [74, 114.05, 161.35], [76, 930.6, 1049.0], [80, 585.9, 637.0],
];
for (const [id, entry, peak] of MORNING) {
  check(`trade ${id} (morning) — trigger unchanged by the floor`, trailTriggerPrice(entry, peak), peak * (1 - config.trailPct));
}

// The trades whose trail armed under water. The floor must lift every one.
const UNDERWATER = [
  [62, 426.25, 441.6], [66, 396.7, 409.05], [67, 218.2, 225.15],
  [75, 86.5, 90.6], [78, 621.55, 656.4], [79, 609.45, 643.25], [81, 965.85, 996.0],
];
for (const [id, entry, peak] of UNDERWATER) {
  check(`trade ${id} — trigger lifted to breakeven`, trailTriggerPrice(entry, peak), entry + COST);
}

console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILURE(S)'}`);
process.exit(failed === 0 ? 0 : 1);
