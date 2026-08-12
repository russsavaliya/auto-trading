'use strict';

/**
 * Repairs historical trades whose P&L was computed from the BANK NIFTY INDEX
 * instead of the option premium.
 *
 * Migration 001 moved the old entry_price/exit_price values into
 * entry_spot/exit_spot and blanked the price columns. This script fills them
 * back in with the real option premium at the moment each leg was placed,
 * pulled from Upstox's 1-minute historical candles for the exact contract
 * traded, then recomputes pnl.
 *
 * Fill model matches the live path: the 1-minute candle covering the order
 * timestamp, plus PAPER_SLIPPAGE_POINTS against you on each leg.
 *
 *   node scripts/backfill-premiums.js            # dry run, prints the diff
 *   node scripts/backfill-premiums.js --apply    # writes to Supabase
 */

require('dotenv').config();
const config = require('../config/env');
const { supabase } = require('../services/supabaseService');
const marketData = require('../services/marketData');
const { istString } = require('../utils/marketClock');

const APPLY = process.argv.includes('--apply');

function money(n) {
  if (n === null || n === undefined) return '     —   ';
  return (n < 0 ? '-' : '+') + '₹' + Math.abs(n).toFixed(0).padStart(6);
}

async function main() {
  const { data: trades, error } = await supabase
    .from('trades')
    .select('*')
    .in('status', ['CLOSED', 'FILLED'])
    .order('id', { ascending: true });

  if (error) throw error;
  console.log(`${trades.length} trades to inspect. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Slippage applied per leg: ${config.paperSlippagePoints} premium points\n`);

  let repaired = 0;
  let skipped = 0;
  let oldTotal = 0;
  let newTotal = 0;
  const flips = [];

  for (const t of trades) {
    if (!t.instrument_token || !t.quantity) {
      console.log(`  trade ${t.id}: no instrument/quantity — skipped`);
      skipped++;
      continue;
    }

    const entryAt = new Date(t.created_at).getTime();
    const entryMark = await marketData.getPremiumAt(t.instrument_token, entryAt);
    if (!entryMark) {
      console.log(`  trade ${t.id}: no candle data at entry (${istString(entryAt)}) — skipped`);
      skipped++;
      continue;
    }
    // `open`, not `close`: the covering candle closes up to 60 seconds AFTER
    // the order was placed, so using its close would be look-ahead bias.
    const entryPremium = Number((entryMark.open + config.paperSlippagePoints).toFixed(2));

    const update = {
      entry_price: entryPremium,
      entry_fill_source: 'backfilled_market_mark',
    };

    let exitPremium = null;
    let pnl = null;

    if (t.status === 'CLOSED' && t.closed_at) {
      const exitAt = new Date(t.closed_at).getTime();
      const exitMark = await marketData.getPremiumAt(t.instrument_token, exitAt);
      if (!exitMark) {
        console.log(`  trade ${t.id}: no candle data at exit — entry repaired, pnl left null`);
      } else {
        exitPremium = Number((exitMark.open - config.paperSlippagePoints).toFixed(2));
        pnl = Number(((exitPremium - entryPremium) * Number(t.quantity)).toFixed(2));
        update.exit_price = exitPremium;
        update.exit_fill_source = 'backfilled_market_mark';
        update.pnl = pnl;
      }
    }

    // The pre-migration pnl, for the comparison. Migration 001 nulled `pnl`,
    // so reconstruct what the old formula would have produced from the spot
    // columns it preserved.
    const oldPnl =
      t.entry_spot != null && t.exit_spot != null
        ? (Number(t.exit_spot) - Number(t.entry_spot)) * Number(t.quantity)
        : null;

    if (oldPnl !== null && pnl !== null) {
      oldTotal += oldPnl;
      newTotal += pnl;
      if (Math.sign(oldPnl) !== Math.sign(pnl)) {
        flips.push({ id: t.id, side: t.signal_type, oldPnl, pnl });
      }
    }

    console.log(
      `  trade ${String(t.id).padEnd(4)} ${String(t.signal_type).padEnd(11)} ` +
        `prem ${String(entryPremium).padStart(7)} -> ${String(exitPremium ?? 'open').padStart(7)}   ` +
        `was ${money(oldPnl)}   now ${money(pnl)}` +
        (oldPnl !== null && pnl !== null && Math.sign(oldPnl) !== Math.sign(pnl) ? '   <-- SIGN WAS INVERTED' : '')
    );

    if (APPLY) {
      const { error: upErr } = await supabase.from('trades').update(update).eq('id', t.id);
      if (upErr) {
        console.error(`     write failed: ${upErr.message}`);
        continue;
      }
    }
    repaired++;
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log(`repaired: ${repaired}   skipped: ${skipped}`);
  console.log(`P&L as previously recorded (index-based): ${money(oldTotal)}`);
  console.log(`P&L from real option premiums:           ${money(newTotal)}`);
  console.log(`trades whose recorded sign was inverted: ${flips.length}`);
  flips.forEach((f) => console.log(`   trade ${f.id} ${f.side}: ${money(f.oldPnl)} -> ${money(f.pnl)}`));
  if (!APPLY) console.log('\nDRY RUN — nothing written. Re-run with --apply to persist.');
}

main().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
