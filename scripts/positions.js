'use strict';

/**
 * Inspect and repair position_state — the table that decides whether the
 * bridge will accept the next signal.
 *
 * A position stuck in IN_CALL/IN_PUT blocks EVERY subsequent entry for that
 * symbol, silently. That is what happened after 12 Aug 2026: trade 37 was
 * opened at 14:35, no exit signal ever arrived, and the state machine stayed
 * IN_CALL indefinitely.
 *
 *   node scripts/positions.js                 # show current state
 *   node scripts/positions.js --close         # close open positions properly
 *                                             #   (places the exit order, prices
 *                                             #    it, computes P&L, writes the
 *                                             #    trade row) — the safe option
 *   node scripts/positions.js --force-flat    # ONLY resets the state flag and
 *                                             #   marks the trade CLOSED with no
 *                                             #   exit order. Use when the
 *                                             #   position does not really exist
 *                                             #   at the broker.
 */

require('dotenv').config();
const supabaseService = require('../src/services/supabaseService');
const tradeExecutor = require('../src/services/tradeExecutor');
const { supabase } = require('../src/services/supabaseService');
const { istString } = require('../src/utils/marketClock');

const CLOSE = process.argv.includes('--close');
const FORCE_FLAT = process.argv.includes('--force-flat');

async function show() {
  const positions = await supabaseService.listPositionStates();
  console.log(`IST now: ${istString()}\n`);
  console.log('symbol'.padEnd(14), 'state'.padEnd(9), 'trade'.padEnd(7), 'updated (IST)');
  for (const p of positions) {
    console.log(
      String(p.symbol).padEnd(14),
      String(p.state).padEnd(9),
      String(p.current_trade_id ?? '—').padEnd(7),
      istString(p.updated_at)
    );
  }

  const open = positions.filter((p) => p.state !== 'FLAT');
  if (!open.length) {
    console.log('\nAll symbols FLAT — nothing is blocking new signals.');
    return [];
  }

  console.log(`\n${open.length} open position(s):`);
  for (const p of open) {
    if (!p.current_trade_id) {
      console.log(`  ${p.symbol}: state ${p.state} but NO linked trade — this is a data-integrity fault.`);
      continue;
    }
    const t = await supabaseService.getTradeById(p.current_trade_id);
    if (!t) {
      console.log(`  ${p.symbol}: trade ${p.current_trade_id} not found.`);
      continue;
    }
    const ageH = ((Date.now() - new Date(t.created_at).getTime()) / 3600000).toFixed(1);
    console.log(
      `  ${p.symbol}: trade ${t.id} ${t.signal_type} ${t.instrument_token} qty ${t.quantity}\n` +
        `      opened ${istString(t.created_at)}  (${ageH} h ago)  status=${t.status}\n` +
        `      entry premium ${t.entry_price ?? 'UNPRICED'}   entry spot ${t.entry_spot ?? '—'}   broker=${t.broker_entry_status ?? '—'}`
    );
  }
  return open;
}

async function main() {
  const open = await show();
  if (!open.length) return;

  if (CLOSE) {
    for (const p of open) {
      console.log(`\nClosing ${p.symbol} properly (placing exit order + pricing it)...`);
      const r = await tradeExecutor.closePosition({ symbol: p.symbol, reason: 'manual_close' });
      console.log(r.ok ? `  closed. trade ${r.tradeId}, pnl ${r.pnl}` : `  FAILED: ${r.reason}`);
    }
    console.log('\nFinal state:');
    await show();
    return;
  }

  if (FORCE_FLAT) {
    for (const p of open) {
      console.log(`\nForcing ${p.symbol} FLAT without an exit order...`);
      if (p.current_trade_id) {
        const { error } = await supabase
          .from('trades')
          .update({
            status: 'CLOSED',
            closed_at: new Date().toISOString(),
            closed_reason: 'force_flat_no_exit_order',
            error_message: 'Position force-cleared by scripts/positions.js --force-flat; no exit order was placed and no P&L is recorded.',
          })
          .eq('id', p.current_trade_id);
        if (error) console.error(`  trade update failed: ${error.message}`);
      }
      const res = await supabaseService.transitionPositionState({
        symbol: p.symbol,
        expectedState: p.state,
        newState: 'FLAT',
        tradeId: null,
      });
      console.log(res.success ? '  state reset to FLAT' : `  state reset failed (state changed to ${res.previousState})`);
    }
    console.log('\nFinal state:');
    await show();
    return;
  }

  console.log('\nNothing changed. Re-run with --close (recommended) or --force-flat.');
}

main().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
