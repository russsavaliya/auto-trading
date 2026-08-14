//@version=5
indicator("Directional Bias Score (CALL/PUT Lean) with Exit Alerts", overlay=true)

// =============================================================================
// CHANGES vs the version that ran 6-12 Aug 2026, and why. Read this before
// tuning anything — several defaults changed meaning.
//
// 1. DEAD BAND CLOSED. Entry used to fire on a fresh cross (strongCall and not
//    strongCall[1]) while the position flag stayed true. With entry at |4| and
//    exit at |1| there was a band (|score| 2-3, 36% of all bars) where the
//    position was still held but the entry trigger had already reset — so a dip
//    back to |4| re-fired an ENTRY alert for a position the bridge already had.
//    Seven alerts were rejected as "already IN_CALL/IN_PUT" over six days. The
//    chart showed a fresh signal while the bot silently sat in an older, worse
//    position. Entry is now gated on actually being flat.
//
// 2. exitThreshold default 1 -> 3, so the entry and exit bands meet and no
//    dead band can exist for the default settings.
//
// 3. VOLUME COMPONENT DEFAULT OFF. On an index chart TradingView's `volume` is
//    a synthetic aggregate of constituents, and it cast the deciding vote on 7
//    of 24 entries (trend+momentum was only +/-3 on those; several had MACD
//    pointing the OTHER way and RSI in the neutral 45-55 band). Those seven
//    trades lost money. Turn it back on only if you have a reason to trust it.
//
// 4. SESSION DISCIPLINE. No entries at/after 14:45 IST, and everything is
//    force-exited at 15:15 IST. Previously the 15:25-15:30 bar could open a
//    brand-new position whose alert lands at ~15:31, after the session closed —
//    it happened twice, once carrying a position across a whole weekend.
//    The bridge enforces this server-side too (at 15:20, as a safety net for
//    when this script does not fire); this is the primary control.
//
// 5. CONFIRMATION + COOLDOWN. Optional consecutive-bar confirmation, and a
//    cooldown after an exit so the score oscillating across the threshold
//    cannot churn in and out. At ~Rs.90 per round trip that churn is expensive.
//
// 6. EXITS NO LONGER LIVE HERE (14 Aug 2026). The score cannot book a profit:
//    it is built from lagging index measures, so the option premium peaks and
//    fully round-trips before the score decays enough to fire. Over 13-14 Aug,
//    10 of 12 trades were in profit at some point and Rs.11,064 was handed back
//    waiting for a score exit — trade 51 was +Rs.1,656 at 12 minutes and closed
//    at -Rs.18 at 60. The bridge now runs stop-loss / trailing-stop / time-stop
//    against the PREMIUM (services/positionMonitor.js). The exit alerts below
//    still fire and act as a backstop; whichever triggers first wins.
//
// 7. EFFICIENCY RATIO is now reported with every alert (`er` in the payload) so
//    the chop-vs-trend regime each signal fired in gets recorded. The filter
//    itself is OFF by default — see the note on minEfficiencyRatio.
//
// STILL UNSOLVED — READ THIS. None of the above gives the strategy an edge.
//
// The entry signal is anti-predictive, and two independent samples now say so.
// 6-12 Aug: the index moved in the signalled direction 29% of the time five
// minutes on, and 8 of 24 trades were the right way round. 13-14 Aug, running
// THIS version of the script: 3 of 12 at five minutes, 2 of 12 at fifteen,
// averaging 18-36 index points AGAINST the signal. The cause is structural —
// the score only reaches |4| once a move is already visible on the chart, which
// is where these swings exhaust.
//
// Inverting the signal is not the fix either. Over all 37 trades from 6-14 Aug
// the flipped version returns +Rs.1,882 at a 54% hit rate — indistinguishable
// from zero, and the entire profit comes from two days (13-14 Aug: +Rs.5,382)
// while the first five days lose Rs.3,500.
//
// So: these changes make the system HONEST, SAFE and BOUNDED, not profitable.
// Keep running it to collect `er`-tagged signals, and treat the real work as
// replacing the entry — not tuning this one.
// =============================================================================

// ===== INPUTS =====
emaFastLen  = input.int(9,  title="Fast EMA",   group="Score inputs")
emaSlowLen  = input.int(21, title="Slow EMA",   group="Score inputs")
rsiLen      = input.int(14, title="RSI Length", group="Score inputs")
volMaLen    = input.int(20, title="Volume MA Length", group="Score inputs")
supertrendFactor = input.float(2.0, title="Supertrend Factor",     group="Score inputs")
supertrendATR    = input.int(10,    title="Supertrend ATR Length", group="Score inputs")

// Off by default — see note 3 above.
useVolume = input.bool(false, title="Include volume component (index volume is synthetic)", group="Score inputs")

entryThreshold = input.int(4, title="Entry threshold (|score| at/above this = enter)", minval=2, maxval=6, group="Entry / exit")
// Must be < entryThreshold. At entryThreshold-1 there is no dead band at all.
exitThreshold  = input.int(3, title="Exit threshold (score falls to/below this = exit)", minval=0, maxval=5, group="Entry / exit")
confirmBars    = input.int(1, title="Bars score must hold before entering", minval=1, maxval=5, group="Entry / exit")
// 1 = wait one bar after any exit. This also blocks same-bar reversals, which
// were consistently the worst trades in the sample.
cooldownBars   = input.int(1, title="Cooldown bars after an exit", minval=0, maxval=10, group="Entry / exit")

// The bridge now closes positions on its own, against the option PREMIUM
// (stop-loss / trailing / time stop in services/positionMonitor.js). This
// script cannot see that happen — it has no idea what the premium did — so
// after a server-side exit its inCallPosition/inPutPosition would stay true and
// it would emit NO further entry until its own score-based exit finally fired.
// Every setup in that window would be silently skipped.
//
// The repair is to re-send the entry periodically while the bias still holds.
// The bridge keeps the authoritative state machine and accepts the re-assert
// only when it is genuinely FLAT; if the position is still open it is rejected
// as "already IN_CALL/IN_PUT", which costs nothing but a log line. That makes
// the two sides self-healing instead of dependent on staying in lockstep.
reassertEntries = input.bool(true, title="Re-send entry while bias holds (stays in step after a server-side exit)", group="Entry / exit")
reassertBars    = input.int(3, title="Re-send every N bars", minval=1, maxval=20, group="Entry / exit")

// ===== REGIME FILTER (measurement first — see note below) =====
// Kaufman Efficiency Ratio: net move over the last N bars divided by the total
// path travelled to get there. 1.0 is a straight line (clean trend); near 0
// means price wandered a long way and ended up nowhere (chop).
//
// This matters because the score is a TREND-FOLLOWING measure, and a trend
// system in a range does exactly what this one has been doing: buying every
// swing high and selling every swing low. Across 6-14 Aug the median ER at
// entry was 0.263 — more than half of all signals fired in chop — and those
// signals were 3/15 correct at the 15-minute mark, averaging -27 index points.
// Signals in the 0.30-0.50 band were 6/9 correct, averaging +19.7.
//
// THAT SPLIT IS A HYPOTHESIS, NOT A RESULT. Nine signals in the good bucket is
// far too few to act on, and the >0.50 bucket was 0/2, which argues against the
// simple "more trend is better" story. So minEfficiencyRatio DEFAULTS TO 0 —
// the filter is off and changes nothing. What IS on is `er` in the alert
// payload, so every future signal records the regime it fired in and the
// question can be settled with real data in a few weeks instead of guessed at
// now. Raise this only once that data says to.
erLength = input.int(10, title="Efficiency Ratio lookback (bars)", minval=3, group="Regime filter")
minEfficiencyRatio = input.float(0.0, title="Minimum ER to allow entry (0 = filter OFF)", minval=0.0, maxval=1.0, step=0.05, group="Regime filter")

erNet  = math.abs(close - close[erLength])
erPath = math.sum(math.abs(close - close[1]), erLength)
efficiencyRatio = erPath > 0 ? erNet / erPath : 0.0
regimeOk = efficiencyRatio >= minEfficiencyRatio

useSession      = input.bool(true, title="Enforce intraday session rules", group="Session (IST)")
entryCutoffHour = input.int(14, title="No new entries at/after — hour",   minval=9, maxval=15, group="Session (IST)")
entryCutoffMin  = input.int(45, title="No new entries at/after — minute", minval=0, maxval=59, group="Session (IST)")
squareOffHour   = input.int(15, title="Force exit at — hour",   minval=9, maxval=15, group="Session (IST)")
squareOffMin    = input.int(15, title="Force exit at — minute", minval=0, maxval=59, group="Session (IST)")

// Webhook order details. instrument_token is intentionally NOT sent from here —
// the bridge auto-resolves the current-cycle ATM contract itself from the price
// below. lot_size for BANKNIFTY is 30 (confirmed against Upstox's instrument
// master on 12 Aug 2026 — re-verify before going live).
orderQty = input.int(30, title="Order Quantity (lot size)", group="Order")

// ===== 1. TREND (EMA + Supertrend) =====
// NOTE: these three are largely the same lagging measurement counted three
// times, which is why the score only reaches |4| once a move is already
// extended. That is the root of the 29% hit rate, and it is a design problem
// no threshold change fixes.
emaFast = ta.ema(close, emaFastLen)
emaSlow = ta.ema(close, emaSlowLen)
[stValue, stDir] = ta.supertrend(supertrendFactor, supertrendATR)

trendScore = 0
trendScore := emaFast > emaSlow ? trendScore + 1 : trendScore - 1
trendScore := close > emaSlow   ? trendScore + 1 : trendScore - 1
trendScore := stDir < 0         ? trendScore + 1 : trendScore - 1  // supertrend green

// ===== 2. MOMENTUM (RSI + MACD) =====
rsiVal = ta.rsi(close, rsiLen)
[macdLine, signalLine, _] = ta.macd(close, 12, 26, 9)

momScore = 0
momScore := rsiVal > 55 ? momScore + 1 : rsiVal < 45 ? momScore - 1 : momScore
momScore := macdLine > signalLine ? momScore + 1 : momScore - 1

// ===== 3. VOLUME CONFIRMATION (optional) =====
volMa = ta.sma(volume, volMaLen)
volSpike = volume > volMa * 1.3
candleBull = close > open

volScore = 0
volScore := volSpike and candleBull     ? volScore + 1 : volScore
volScore := volSpike and not candleBull ? volScore - 1 : volScore
volContribution = useVolume ? volScore : 0

// ===== TOTAL SCORE =====
// Range is -5..+5 with volume off, -6..+6 with it on.
totalScore = trendScore + momScore + volContribution

// ===== SESSION CLOCK (IST — NSE trades in Asia/Kolkata) =====
// time_close is used, not time: the alert fires when the bar CLOSES, so the
// close time is what the cutoffs must be compared against. A 15:25-15:30 bar
// has time_close 15:30, which is correctly past both cutoffs.
istHour = hour(time_close, "Asia/Kolkata")
istMin  = minute(time_close, "Asia/Kolkata")
barCloseMin  = istHour * 60 + istMin
entryCutoff  = entryCutoffHour * 60 + entryCutoffMin
squareOffAt  = squareOffHour * 60 + squareOffMin

pastEntryCutoff = useSession and barCloseMin >= entryCutoff
mustSquareOff   = useSession and barCloseMin >= squareOffAt

// ===== RAW BIAS =====
strongCall = totalScore >= entryThreshold
strongPut  = totalScore <= -entryThreshold

// Consecutive-bar confirmation.
var int callStreak = 0
var int putStreak  = 0
callStreak := strongCall ? callStreak + 1 : 0
putStreak  := strongPut  ? putStreak  + 1 : 0
callConfirmed = callStreak >= confirmBars
putConfirmed  = putStreak  >= confirmBars

// ===== POSITION STATE TRACKING =====
var bool inCallPosition = false
var bool inPutPosition  = false
var int  lastExitBar    = na
var int  lastEntryBar   = na

// ===== EXIT CONDITIONS =====
// Computed BEFORE the entry block below mutates the position flags. On a
// same-bar reversal the exit must be evaluated first, otherwise the flag would
// already be false and the exit would never fire — the bridge would then see
// only the entry, reject it for not being FLAT, and drop the reversal.
exitCallSignal = inCallPosition and (totalScore <= exitThreshold  or strongPut  or mustSquareOff)
exitPutSignal  = inPutPosition  and (totalScore >= -exitThreshold or strongCall or mustSquareOff)

if exitCallSignal
    inCallPosition := false
    lastExitBar := bar_index
if exitPutSignal
    inPutPosition := false
    lastExitBar := bar_index

// ===== ENTRIES =====
// Gated on being genuinely flat rather than on a fresh threshold cross — this
// is what closes the dead band. Runs after the exit resets above so a reversal
// still lands in the correct new state (subject to the cooldown).
flatNow    = not inCallPosition and not inPutPosition
cooledDown = na(lastExitBar) or (bar_index - lastExitBar) >= cooldownBars
canEnterNow = flatNow and cooledDown and not pastEntryCutoff and not mustSquareOff and regimeOk

enterCall = canEnterNow and callConfirmed
enterPut  = canEnterNow and putConfirmed and not enterCall

if enterCall
    inCallPosition := true
    inPutPosition  := false
    lastEntryBar   := bar_index
if enterPut
    inPutPosition  := true
    inCallPosition := false
    lastEntryBar   := bar_index

// ===== RE-ASSERT (keeps this script in step with the server) =====
// See the note beside the reassertEntries input above for why this exists.
barsSinceEntry = na(lastEntryBar) ? na : bar_index - lastEntryBar
canReassert = reassertEntries and not na(barsSinceEntry) and barsSinceEntry > 0 and barsSinceEntry % reassertBars == 0 and not pastEntryCutoff and not mustSquareOff and regimeOk

reassertCall = canReassert and inCallPosition and strongCall and not exitCallSignal
reassertPut  = canReassert and inPutPosition  and strongPut  and not exitPutSignal

// ===== VISUALS =====
plot(emaFast, color=color.new(color.blue, 0),  title="Fast EMA")
plot(emaSlow, color=color.new(color.red, 0),   title="Slow EMA")
plot(stValue, color=stDir < 0 ? color.green : color.red, title="Supertrend", style=plot.style_linebr)

bgcolor(strongCall ? color.new(color.green, 88) : strongPut ? color.new(color.red, 88) : na)
// Shade the part of the day where new entries are refused.
bgcolor(pastEntryCutoff ? color.new(color.gray, 92) : na)

plotshape(enterCall, style=shape.labelup,   location=location.belowbar, color=color.green, text="CALL", textcolor=color.white, size=size.small)
plotshape(enterPut,  style=shape.labeldown, location=location.abovebar, color=color.red,   text="PUT",  textcolor=color.white, size=size.small)
plotshape(exitCallSignal, style=shape.xcross, location=location.abovebar, color=color.orange, text="EXIT", textcolor=color.white, size=size.tiny)
plotshape(exitPutSignal,  style=shape.xcross, location=location.belowbar, color=color.orange, text="EXIT", textcolor=color.white, size=size.tiny)

// ===== SCORE TABLE (top-right) =====
var table t = table.new(position.top_right, 2, 8, border_width=1)
if barstate.islast
    table.cell(t, 0, 0, "Component", bgcolor=color.gray, text_color=color.white)
    table.cell(t, 1, 0, "Score",     bgcolor=color.gray, text_color=color.white)
    table.cell(t, 0, 1, "Trend")
    table.cell(t, 1, 1, str.tostring(trendScore), text_color=trendScore > 0 ? color.green : trendScore < 0 ? color.red : color.gray)
    table.cell(t, 0, 2, "Momentum")
    table.cell(t, 1, 2, str.tostring(momScore), text_color=momScore > 0 ? color.green : momScore < 0 ? color.red : color.gray)
    table.cell(t, 0, 3, useVolume ? "Volume" : "Volume (off)")
    table.cell(t, 1, 3, str.tostring(volContribution), text_color=color.gray)
    table.cell(t, 0, 4, "TOTAL")
    table.cell(t, 1, 4, str.tostring(totalScore), bgcolor=strongCall ? color.green : strongPut ? color.red : color.gray, text_color=color.white)
    table.cell(t, 0, 5, "Position")
    table.cell(t, 1, 5, inCallPosition ? "IN CALL" : inPutPosition ? "IN PUT" : "FLAT", text_color=color.white, bgcolor=inCallPosition ? color.green : inPutPosition ? color.red : color.gray)
    table.cell(t, 0, 6, "Session")
    table.cell(t, 1, 6, mustSquareOff ? "SQUARE OFF" : pastEntryCutoff ? "NO NEW ENTRY" : "OPEN", text_color=color.white, bgcolor=mustSquareOff ? color.red : pastEntryCutoff ? color.orange : color.green)
    table.cell(t, 0, 7, "Efficiency")
    table.cell(t, 1, 7, str.tostring(efficiencyRatio, "#.##") + (minEfficiencyRatio > 0 ? (regimeOk ? " ok" : " BLOCKED") : " (log only)"), text_color=color.white, bgcolor=efficiencyRatio >= 0.30 ? color.green : efficiencyRatio >= 0.15 ? color.orange : color.red)

// ===== ALERTS (static — for manual watching, unrelated to the webhook) =====
alertcondition(enterCall, title="CALL Bias Alert", message="Strong CALL-side bias detected")
alertcondition(enterPut,  title="PUT Bias Alert",  message="Strong PUT-side bias detected")
alertcondition(exitCallSignal, title="EXIT CALL Alert", message="Exit CALL — book profit/cut loss")
alertcondition(exitPutSignal,  title="EXIT PUT Alert",  message="Exit PUT — book profit/cut loss")

// ===== WEBHOOK ALERTS (bridge-compatible JSON — this is what drives the bot) =====
// Payload shape is unchanged; the bridge's validator expects exactly these
// fields. alert_id = bar time + signal_type, so the same bar re-firing the same
// signal produces the same id (the bridge dedupes it) while a genuinely new
// bar always gets a fresh one.
buildAlertMsg(_signalType) =>
    '{"signal_type":"' + _signalType + '","symbol":"' + syminfo.ticker +
     '","price":' + str.tostring(close) +
     ',"score":' + str.tostring(totalScore) +
     ',"timestamp":"' + str.tostring(time) + '"' +
     ',"alert_id":"' + str.tostring(time) + '-' + _signalType + '"' +
     ',"er":' + str.tostring(math.round(efficiencyRatio * 1000) / 1000) +
     ',"quantity":' + str.tostring(orderQty) + '}'

// Exits are emitted before entries so that on a same-bar reversal TradingView
// dispatches the exit first. The bridge also queues per symbol now, so its
// ordering no longer depends on this — but keeping it costs nothing.
if exitCallSignal
    alert(buildAlertMsg("CALL_EXIT"), alert.freq_once_per_bar_close)
if exitPutSignal
    alert(buildAlertMsg("PUT_EXIT"), alert.freq_once_per_bar_close)
if enterCall
    alert(buildAlertMsg("CALL_ENTRY"), alert.freq_once_per_bar_close)
if enterPut
    alert(buildAlertMsg("PUT_ENTRY"), alert.freq_once_per_bar_close)

// Re-assertions carry the identical payload shape, so the bridge treats them
// as ordinary entries and its state machine decides. alert_id embeds bar time,
// so each re-send is a distinct id and is not swallowed as a duplicate.
if reassertCall
    alert(buildAlertMsg("CALL_ENTRY"), alert.freq_once_per_bar_close)
if reassertPut
    alert(buildAlertMsg("PUT_ENTRY"), alert.freq_once_per_bar_close)
