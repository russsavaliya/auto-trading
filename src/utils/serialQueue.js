'use strict';

/**
 * Runs tasks one-at-a-time per key, in the order they were submitted.
 *
 * WHY: on a same-bar reversal the Pine script emits CALL_EXIT before
 * PUT_ENTRY, but the route acknowledges each webhook immediately and processes
 * it in a detached task — so the two ran concurrently with no ordering
 * guarantee. The webhook log from the 6-12 Aug run shows the entry arriving
 * first twice (rows 32/33 and 34/35). Both happened to resolve correctly, but
 * if the entry wins that race it is rejected for not being FLAT and the
 * reversal is silently dropped, leaving Pine and the bridge disagreeing about
 * what is held.
 *
 * Chaining per symbol fixes the ordering without serialising unrelated
 * symbols against each other. A rejected task never breaks the chain — the
 * next one still runs.
 */

const chains = new Map();

function enqueue(key, task) {
  const previous = chains.get(key) || Promise.resolve();

  // The chain advances on settle, not on success, so one failure cannot wedge
  // every later signal for this symbol.
  const next = previous.then(task, task);

  // Swallow rejections on the stored tail only. `next` is still returned to
  // the caller unmodified, so the caller keeps the real result/error.
  chains.set(
    key,
    next.then(
      () => undefined,
      () => undefined
    )
  );

  // Drop the entry once this is the last task, so the map cannot grow forever.
  const settled = chains.get(key);
  settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });

  return next;
}

/** Test/diagnostic helper — how many symbols currently have work queued. */
function pendingKeys() {
  return [...chains.keys()];
}

module.exports = { enqueue, pendingKeys };
