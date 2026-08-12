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
// STILL UNSOLVED — READ THIS. None of the above gives the strategy an edge.
// Measured over 6-12 Aug, five minutes after a fresh signal BANKNIFTY had moved
// in the signalled direction only 29% of the time (a coin flip is ~49%), and
// the direction was right on just 8 of 24 real trades. Every parameter
// combination tested still lost money, and so did taking the opposite side of
// every signal. These changes make the system HONEST and SAFE, not profitable.
// Treat further live running as data collection, not as trading.
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
canEnterNow = flatNow and cooledDown and not pastEntryCutoff and not mustSquareOff

enterCall = canEnterNow and callConfirmed
enterPut  = canEnterNow and putConfirmed and not enterCall

if enterCall
    inCallPosition := true
    inPutPosition  := false
if enterPut
    inPutPosition  := true
    inCallPosition := false

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
var table t = table.new(position.top_right, 2, 7, border_width=1)
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
