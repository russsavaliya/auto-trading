//@version=5
indicator("Directional Bias Score (CALL/PUT Lean) with Exit Alerts", overlay=true)

// ===== INPUTS =====
emaFastLen  = input.int(9,  title="Fast EMA")
emaSlowLen  = input.int(21, title="Slow EMA")
rsiLen      = input.int(14, title="RSI Length")
volMaLen    = input.int(20, title="Volume MA Length")
supertrendFactor = input.float(2.0, title="Supertrend Factor")
supertrendATR    = input.int(10,  title="Supertrend ATR Length")
exitThreshold     = input.int(1, title="Exit Threshold (score falls to/below this = exit)", minval=0, maxval=5)

// Webhook order details. instrument_token is intentionally NOT sent from
// here — the bridge auto-resolves the current-cycle ATM contract itself
// from the price sent below, so there's nothing to keep updating manually.
// lot_size for BANKNIFTY is currently 30 (confirmed from Upstox's instrument
// master — verify it hasn't changed before going live).
orderQty          = input.int(30, title="Order Quantity (lot size)")

// ===== 1. TREND (EMA + Supertrend) =====
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

// ===== 3. VOLUME CONFIRMATION =====
volMa = ta.sma(volume, volMaLen)
volSpike = volume > volMa * 1.3
candleBull = close > open

volScore = 0
volScore := volSpike and candleBull     ? volScore + 1 : volScore
volScore := volSpike and not candleBull ? volScore - 1 : volScore

// ===== TOTAL SCORE (-6 to +6) =====
totalScore = trendScore + momScore + volScore

// ===== ENTRY SIGNALS =====
strongCall = totalScore >= 4
strongPut  = totalScore <= -4
weakZone   = totalScore > -4 and totalScore < 4

// ===== POSITION STATE TRACKING =====
var bool inCallPosition = false
var bool inPutPosition  = false

// ===== EXIT CONDITIONS =====
// Computed BEFORE the entry block below mutates inCallPosition/inPutPosition.
// Reason: on a same-bar reversal (score flips straight from strong CALL to
// strong PUT), if the entry block ran first it would set inCallPosition
// false before exitCallSignal is evaluated, so the exit would never fire —
// the bridge would then only see PUT_ENTRY, reject it (still IN_CALL on its
// side since it was never told to exit), and the reversal would be dropped.
// Exit CALL: score falls to/below exitThreshold, OR flips to PUT bias
exitCallSignal = inCallPosition and (totalScore <= exitThreshold or strongPut)
// Exit PUT: score rises to/above -exitThreshold, OR flips to CALL bias
exitPutSignal  = inPutPosition and (totalScore >= -exitThreshold or strongCall)

// Reset state once exit fires
if exitCallSignal
    inCallPosition := false
if exitPutSignal
    inPutPosition := false

// Enter position on fresh signal — runs AFTER the exit reset above so a
// same-bar reversal ends up in the correct new state.
if strongCall and not strongCall[1]
    inCallPosition := true
    inPutPosition  := false
if strongPut and not strongPut[1]
    inPutPosition  := true
    inCallPosition := false

// ===== VISUALS =====
plot(emaFast, color=color.new(color.blue, 0),  title="Fast EMA")
plot(emaSlow, color=color.new(color.red, 0),   title="Slow EMA")
plot(stValue, color=stDir < 0 ? color.green : color.red, title="Supertrend", style=plot.style_linebr)

bgcolor(strongCall ? color.new(color.green, 85) : strongPut ? color.new(color.red, 85) : na)

plotshape(strongCall and not strongCall[1], style=shape.labelup,   location=location.belowbar, color=color.green, text="CALL bias", textcolor=color.white, size=size.small)
plotshape(strongPut  and not strongPut[1],  style=shape.labeldown, location=location.abovebar, color=color.red,   text="PUT bias",  textcolor=color.white, size=size.small)

// Exit markers
plotshape(exitCallSignal, style=shape.xcross, location=location.abovebar, color=color.orange, text="EXIT CALL", textcolor=color.white, size=size.small)
plotshape(exitPutSignal,  style=shape.xcross, location=location.belowbar, color=color.orange, text="EXIT PUT",  textcolor=color.white, size=size.small)

// ===== SCORE TABLE (top-right) =====
var table t = table.new(position.top_right, 2, 6, border_width=1)
if barstate.islast
    table.cell(t, 0, 0, "Component", bgcolor=color.gray, text_color=color.white)
    table.cell(t, 1, 0, "Score",     bgcolor=color.gray, text_color=color.white)
    table.cell(t, 0, 1, "Trend")
    table.cell(t, 1, 1, str.tostring(trendScore), text_color=trendScore > 0 ? color.green : trendScore < 0 ? color.red : color.gray)
    table.cell(t, 0, 2, "Momentum")
    table.cell(t, 1, 2, str.tostring(momScore), text_color=momScore > 0 ? color.green : momScore < 0 ? color.red : color.gray)
    table.cell(t, 0, 3, "Volume")
    table.cell(t, 1, 3, str.tostring(volScore), text_color=volScore > 0 ? color.green : volScore < 0 ? color.red : color.gray)
    table.cell(t, 0, 4, "TOTAL")
    table.cell(t, 1, 4, str.tostring(totalScore), bgcolor=strongCall ? color.green : strongPut ? color.red : color.gray, text_color=color.white)
    table.cell(t, 0, 5, "Position")
    table.cell(t, 1, 5, inCallPosition ? "IN CALL" : inPutPosition ? "IN PUT" : "FLAT", text_color=color.white, bgcolor=inCallPosition ? color.green : inPutPosition ? color.red : color.gray)

// ===== ALERTS (static — kept for reference/manual watching, unrelated to the webhook) =====
alertcondition(strongCall and not strongCall[1], title="CALL Bias Alert", message="Strong CALL-side bias detected")
alertcondition(strongPut  and not strongPut[1],  title="PUT Bias Alert",  message="Strong PUT-side bias detected")
alertcondition(exitCallSignal, title="EXIT CALL Alert", message="Exit CALL — book profit/cut loss")
alertcondition(exitPutSignal,  title="EXIT PUT Alert",  message="Exit PUT — book profit/cut loss")

// ===== WEBHOOK ALERTS (bridge-compatible JSON — this is what drives the bot) =====
// alert_id = bar time + signal_type: the same bar re-firing the same signal
// produces the same alert_id (bridge dedupes it); a genuinely new bar/signal
// always gets a new one.
// instrument_token is deliberately omitted — the bridge auto-resolves the
// ATM contract from "price" on entries, and exits use the instrument_token
// stored against the original entry trade, not anything sent here.
buildAlertMsg(_signalType) =>
    '{"signal_type":"' + _signalType + '","symbol":"' + syminfo.ticker +
     '","price":' + str.tostring(close) +
     ',"score":' + str.tostring(totalScore) +
     ',"timestamp":"' + str.tostring(time) + '"' +
     ',"alert_id":"' + str.tostring(time) + '-' + _signalType + '"' +
     ',"quantity":' + str.tostring(orderQty) + '}'

// Exits are emitted before entries so that on a same-bar reversal, TradingView
// dispatches the exit webhook first — the bridge requires state to be FLAT
// before it will accept a new entry, so the exit must land first.
if exitCallSignal
    alert(buildAlertMsg("CALL_EXIT"), alert.freq_once_per_bar_close)
if exitPutSignal
    alert(buildAlertMsg("PUT_EXIT"), alert.freq_once_per_bar_close)
if strongCall and not strongCall[1]
    alert(buildAlertMsg("CALL_ENTRY"), alert.freq_once_per_bar_close)
if strongPut and not strongPut[1]
    alert(buildAlertMsg("PUT_ENTRY"), alert.freq_once_per_bar_close)