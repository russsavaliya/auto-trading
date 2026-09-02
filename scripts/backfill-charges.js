'use strict';
/**
 * Fills trades.charges / trades.charges_breakdown for trades closed before
 * migration 004 existed.
 *
 * Run with:   node scripts/backfill-charges.js --dry
 *             node scripts/backfill-charges.js --commit
 *
 * WHY IT IS NOT AUTOMATIC
 * These figures are RECONSTRUCTED with today's rates, not the rates that
 * applied on the day each trade closed. For trades taken since Oct 2024 that
 * is the same thing; across a rate change it is not. The Report page already
 * computes the same numbers on the fly and labels them "estimated" — running
 * this turns that estimate into a stored value, which makes it indistinguish-
 * able from a recorded fact. That is a deliberate act, so it needs a
 * deliberate command and a dry run first.
 *
 * Nothing here can change a P&L: `pnl` stays gross and is never written.
 */
const config = require('../src/config/env');
const charges = require('../src/services/charges');

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false },
});

const COMMIT = process.argv.includes('--commit');
const money = (n) => (n < 0 ? '-' : '') + 'Rs.' + Math.abs(n).toFixed(2);

async function main() {
  if (!COMMIT && !process.argv.includes('--dry')) {
    console.error('Pass --dry to preview, or --commit to write. Refusing to guess.');
    process.exitCode = 1;
    return;
  }

  const { data, error } = await supabase
    .from('trades')
    .select('id, entry_price, exit_price, quantity, pnl, closed_at, charges')
    .eq('status', 'CLOSED')
    .is('charges', null)
    .order('closed_at', { ascending: true });

  if (error) {
    console.error('Could not read trades:', error.message);
    console.error('If this says "charges does not exist", apply sql/migrations/004 first.');
    process.exitCode = 1;
    return;
  }

  console.log(`${data.length} closed trade(s) without a stored charge.`);
  console.log(`Rates in use: ${JSON.stringify(charges.rateCard())}\n`);

  let totalCharge = 0, totalGross = 0, wrote = 0, skipped = 0;

  for (const t of data) {
    const cost = charges.computeRoundTrip({
      entryPremium: t.entry_price,
      exitPremium: t.exit_price,
      quantity: t.quantity,
    });

    if (!cost) {
      // An unpriced leg. Leave it null — the Report page counts these
      // separately and inventing a cost here would create a loss on a trade
      // that has no recorded result at all.
      skipped += 1;
      continue;
    }

    const gross = t.pnl == null ? null : Number(t.pnl);
    if (gross != null) totalGross += gross;
    totalCharge += cost.total;

    console.log(
      `  trade ${String(t.id).padStart(4)}  gross ${String(gross == null ? '—' : money(gross)).padStart(12)}` +
        `  cost ${money(cost.total).padStart(10)}` +
        `  net ${String(gross == null ? '—' : money(gross - cost.total)).padStart(12)}`
    );

    if (COMMIT) {
      const { error: upErr } = await supabase
        .from('trades')
        .update({ charges: cost.total, charges_breakdown: cost })
        .eq('id', t.id);
      if (upErr) console.error(`    ! failed on trade ${t.id}: ${upErr.message}`);
      else wrote += 1;
    }
  }

  console.log(`\n  gross total   ${money(totalGross)}`);
  console.log(`  charges total ${money(totalCharge)}`);
  console.log(`  NET total     ${money(totalGross - totalCharge)}`);
  console.log(`\n  ${skipped} skipped (unpriced leg)`);
  console.log(COMMIT ? `  ${wrote} row(s) written.` : '  DRY RUN — nothing written. Re-run with --commit.');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
});
