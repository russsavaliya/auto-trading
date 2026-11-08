'use strict';

const supabaseService = require('./supabaseService');
const { PAPER } = require('../config/modes');

const ENTRY_TARGET_STATE = { CALL_ENTRY: 'IN_CALL', PUT_ENTRY: 'IN_PUT' };
const EXIT_SOURCE_STATE = { CALL_EXIT: 'IN_CALL', PUT_EXIT: 'IN_PUT' };

/**
 * State machine is intentionally simple and strict: FLAT <-> IN_CALL,
 * FLAT <-> IN_PUT. There is no direct IN_CALL -> IN_PUT transition — a
 * reversal must exit first, which is exactly what protects against ever
 * holding two opposing positions from a signal ordering glitch.
 *
 * The pattern used throughout this module is "reserve before you act":
 * the state transition happens BEFORE the Upstox order is placed, using an
 * atomic compare-and-swap (see set_position_state in sql/schema.sql). This
 * means the state flip itself is what prevents a second concurrent/duplicate
 * signal from also passing the check — not a prior read that could go stale
 * between the check and the order call. If the broker call then fails, the
 * caller rolls the state back (rollbackEntry/rollbackExit below) so the
 * bridge doesn't get stuck believing it holds a position it never actually
 * entered (or believing it's flat when it never actually exited).
 */

function targetStateForEntry(signalType) {
  return ENTRY_TARGET_STATE[signalType];
}

function sourceStateForExit(signalType) {
  return EXIT_SOURCE_STATE[signalType];
}

async function getState(symbol, mode = PAPER) {
  return supabaseService.getPositionState(symbol, mode);
}

/**
 * Reserves IN_CALL/IN_PUT for an entry signal. Fails (success=false) if the
 * symbol isn't currently FLAT — i.e. we're already in a position, so this
 * entry signal is rejected rather than stacking a second position.
 */
async function reserveEntry({ symbol, signalType, tradeId, mode = PAPER }) {
  const newState = targetStateForEntry(signalType);
  return supabaseService.transitionPositionState({
    symbol,
    expectedState: 'FLAT',
    newState,
    tradeId,
    mode,
  });
}

/** Reverts a reserved entry back to FLAT after an order placement failure. */
async function rollbackEntry({ symbol, signalType, mode = PAPER }) {
  const reservedState = targetStateForEntry(signalType);
  return supabaseService.transitionPositionState({
    symbol,
    expectedState: reservedState,
    newState: 'FLAT',
    tradeId: null,
    mode,
  });
}

/**
 * Reserves FLAT for an exit signal. Fails (success=false) if the symbol
 * isn't currently in the matching side (e.g. a CALL_EXIT arriving while
 * FLAT or IN_PUT) — that's an orphan/invalid signal and must not place an
 * exit order against a position that doesn't exist.
 */
async function reserveExit({ symbol, signalType, mode = PAPER }) {
  const expectedState = sourceStateForExit(signalType);
  return supabaseService.transitionPositionState({
    symbol,
    expectedState,
    newState: 'FLAT',
    tradeId: null,
    mode,
  });
}

/** Reverts a reserved exit back to its prior side after an order placement failure. */
async function rollbackExit({ symbol, signalType, tradeId, mode = PAPER }) {
  const priorState = sourceStateForExit(signalType);
  return supabaseService.transitionPositionState({
    symbol,
    expectedState: 'FLAT',
    newState: priorState,
    tradeId,
    mode,
  });
}

module.exports = {
  getState,
  reserveEntry,
  rollbackEntry,
  reserveExit,
  rollbackExit,
};
