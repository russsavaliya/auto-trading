'use strict';

/**
 * All trading-time logic lives here, in IST, because every rule that matters
 * (entry cutoff, square-off, "is the market even open") is defined in IST
 * regardless of what timezone the server happens to run in. Render/Railway
 * boxes are almost always UTC, so never compare raw Date parts anywhere else.
 *
 * Deliberately dependency-free: Intl with timeZone 'Asia/Kolkata' is exact and
 * handles the fact that IST has no DST, so a fixed +5:30 offset is also correct
 * — but going through Intl keeps it honest if that ever stops being true.
 */

const IST = 'Asia/Kolkata';

/** "YYYY-MM-DD HH:MM:SS" in IST. sv-SE gives ISO-ish ordering with a space. */
function istString(at = Date.now()) {
  return new Date(at).toLocaleString('sv-SE', { timeZone: IST });
}

function istDate(at = Date.now()) {
  return istString(at).slice(0, 10);
}

/** "HH:MM" in IST — the form every cutoff in config is expressed in. */
function istTime(at = Date.now()) {
  return istString(at).slice(11, 16);
}

/** 0 = Sunday .. 6 = Saturday, evaluated in IST. */
function istDayOfWeek(at = Date.now()) {
  const name = new Date(at).toLocaleDateString('en-US', { timeZone: IST, weekday: 'short' });
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

function isWeekend(at = Date.now()) {
  const d = istDayOfWeek(at);
  return d === 0 || d === 6;
}

/**
 * Weekday + inside 09:15-15:30. This does NOT know about NSE trading holidays
 * — there is no dependable free feed for them and a stale hardcoded list is
 * worse than none. Callers that place orders must therefore tolerate "market
 * looked open but the broker disagreed"; the square-off job additionally
 * requires fresh candle data for today before it will act (see scheduler.js).
 */
function isMarketOpen(at = Date.now(), cfg) {
  if (isWeekend(at)) return false;
  const t = istTime(at);
  return t >= cfg.marketOpenIst && t <= cfg.marketCloseIst;
}

/** true once new entries should stop being accepted for the day. */
function isPastEntryCutoff(at = Date.now(), cfg) {
  return istTime(at) >= cfg.entryCutoffIst;
}

/** true once any position still open must be force-closed. */
function isPastSquareOff(at = Date.now(), cfg) {
  return istTime(at) >= cfg.squareOffIst;
}

/** Epoch ms for a given IST "YYYY-MM-DD" + "HH:MM". IST is UTC+5:30, no DST. */
function istToEpoch(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00+05:30`).getTime();
}

/**
 * Proves the runtime can actually do the IST conversion before anything relies
 * on it.
 *
 * Node builds compiled with small-icu (some slim/Alpine images, custom builds)
 * accept `timeZone: 'Asia/Kolkata'` without complaint and silently return UTC.
 * Every rule in this file would then be 5h30m out: the entry cutoff would fall
 * at 20:15 IST, the square-off would never fire during the session, and
 * nothing would look broken in the logs. Fail loudly at boot instead.
 */
function assertTimezoneSupport() {
  const probe = Date.UTC(2026, 7, 13, 9, 50, 0); // 2026-08-13 15:20 IST
  const rendered = istString(probe);
  const ok = rendered.startsWith('2026-08-13 15:20');

  return {
    ok,
    rendered,
    expected: '2026-08-13 15:20:00',
    detail: ok
      ? null
      : 'This Node build cannot resolve the Asia/Kolkata timezone (small-icu). ' +
        'Every session rule — entry cutoff, square-off, market hours — would be applied at the wrong time. ' +
        'Use an official Node image (full ICU), or run with NODE_ICU_DATA pointing at full-icu data.',
  };
}

module.exports = {
  IST,
  istString,
  istDate,
  istTime,
  istDayOfWeek,
  isWeekend,
  isMarketOpen,
  isPastEntryCutoff,
  isPastSquareOff,
  istToEpoch,
  assertTimezoneSupport,
};
