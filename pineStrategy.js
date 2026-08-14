//@version=5
strategy("Directional Bias Score — BACKTEST",
     overlay              = true,
     initial_capital      = 100000,
     default_qty_type     = strategy.fixed,
     default_qty_value    = 1,
     slippage             = 50,
     process_orders_on_close = true,
     calc_on_every_tick   = false,
     close_entries_rule   = "ANY")

// =============================================================================
// WHAT THIS IS, AND WHY IT EXISTS
//
// This is the same signal as pineScript.js, wrapped so TradingView's Strategy
// Tester can score it. The live indicator only draws and fires alerts — it has
// no idea whether a trade made money. This one simulates the trades itself and
// prints net profit, win rate, drawdown and every individual trade.
//
// The problem it solves: every conclusion so far rests on 37 live trades from
// 6-14 Aug 2026. That is far too few to tell a real edge from luck, and at ~5
// trades a day it would take six months to collect 500. This answers the same
// question against a year of history, in seconds.
//
// -----------------------------------------------------------------------------
// READ THIS BEFORE BELIEVING THE NUMBERS — IT TESTS DIRECTION, NOT OPTIONS
//
// Pine on a BANKNIFTY index chart cannot trade option premiums, so this goes
// long the INDEX where the live system buys a CALL, and short where it buys a
// PUT. What comes out is "does this score predict index direction well enough
// to pay for its costs", which is a NECESSARY condition, not the full picture:
//
//   * Real option P&L is worse than this. A long option also bleeds theta and
//     pays for any IV drop. If the signal cannot make money on clean index
//     direction, it certainly cannot after those.
//   * Therefore: a LOSS here is conclusive — the idea is dead, stop.
//     A PROFIT here is NOT proof the live system profits; it only earns the
//     right to the next test.
//
// The point-based exits below are the premium-percentage rules from the live
// server converted at an observed delta of ~0.6 (measured on trade 51: the
// index moved 89 points while the ATM premium moved 55). Adjust deltaAssumption
// if that stops holding.
// =============================================================================

// ===== SCORE INPUTS (identical to the live indicator) =====
emaFastLen  = input.int(9,  title="Fast EMA",   group="Score")
emaSlowLen  = input.int(21, title="Slow EMA",   group="Score")
rsiLen      = input.int(14, title="RSI Length", group="Score")
supertrendFactor = input.float(2.0, title="Supertrend Factor",     group="Score")
supertrendATR    = input.int(10,    title="Supertrend ATR Length", group="Score")

entryThreshold = input.int(4, title="Entry threshold (|score|)", minval=2, maxval=5, group="Entry / exit")
exitThreshold  = input.int(3, title="Exit threshold",            minval=0, maxval=5, group="Entry / exit")
confirmBars    = input.int(1, title="Bars score must hold",      minval=1, maxval=5, group="Entry / exit")
cooldownBars   = input.int(1, title="Cooldown bars after exit",  minval=0, maxval=10, group="Entry / exit")
useScoreExit   = input.bool(true, title="Also exit when the score decays (the live backstop)", group="Entry / exit")

// ===== RISK RULES — the live server's premium rules, in index points =====
deltaAssumption = input.float(0.6, title="ATM delta (premium move / index move)", minval=0.2, maxval=1.0, step=0.05, group="Risk")
stopLossPct  = input.float(10.0, title="Stop loss (% of option premium)",   minval=1, group="Risk")
trailArmPct  = input.float(3.0,  title="Trail arms at (% profit)",          minval=0, group="Risk")
trailPct     = input.float(5.0,  title="Trail gives back (% from peak)",    minval=0.5, group="Risk")
maxHoldBars  = input.int(6,      title="Time stop (bars, 6 = 30m on 5-min)", minval=0, group="Risk")
assumedPremium = input.float(550, title="Typical ATM premium (to convert % to points)", minval=50, group="Risk")

// A percentage of premium becomes index points via the premium size and delta:
//   premium points = pct% x assumedPremium ;  index points = premium points / delta
pctToIndexPoints(_pct) => (_pct / 100.0 * assumedPremium) / deltaAssumption
stopLossPoints = pctToIndexPoints(stopLossPct)
trailArmPoints = pctToIndexPoints(trailArmPct)
trailPoints    = pctToIndexPoints(trailPct)

// ===== SESSION (IST) =====
useSession      = input.bool(true, title="Enforce intraday session rules", group="Session (IST)")
entryCutoffHour = input.int(14, title="No new entries at/after — hour",   group="Session (IST)")
entryCutoffMin  = input.int(45, title="No new entries at/after — minute", group="Session (IST)")
squareOffHour   = input.int(15, title="Force exit at — hour",             group="Session (IST)")
squareOffMin    = input.int(15, title="Force exit at — minute",           group="Session (IST)")

// ===== REGIME FILTER =====
erLength = input.int(10, title="Efficiency Ratio lookback", minval=3, group="Regime filter")
// The whole reason this backtest exists is to settle whether this filter helps.
// Sweep it 0 / 0.15 / 0.25 / 0.35 and compare the Strategy Tester results.
minEfficiencyRatio = input.float(0.0, title="Minimum ER to allow entry (0 = off)", minval=0.0, maxval=1.0, step=0.05, group="Regime filter")

// ===== SCORE =====
emaFast = ta.ema(close, emaFastLen)
emaSlow = ta.ema(close, emaSlowLen)
[stValue, stDir] = ta.supertrend(supertrendFactor, supertrendATR)

trendScore = 0
trendScore := emaFast > emaSlow ? trendScore + 1 : trendScore - 1
trendScore := close > emaSlow   ? trendScore + 1 : trendScore - 1
trendScore := stDir < 0         ? trendScore + 1 : trendScore - 1

rsiVal = ta.rsi(close, rsiLen)
[macdLine, signalLine, _] = ta.macd(close, 12, 26, 9)
momScore = 0
momScore := rsiVal > 55 ? momScore + 1 : rsiVal < 45 ? momScore - 1 : momScore
momScore := macdLine > signalLine ? momScore + 1 : momScore - 1

// Volume is deliberately excluded — on an index chart it is a synthetic
// aggregate, and it cast the deciding vote on 7 of 24 losing entries.
totalScore = trendScore + momScore

// ===== REGIME =====
erNet  = math.abs(close - close[erLength])
erPath = math.sum(math.abs(close - close[1]), erLength)
efficiencyRatio = erPath > 0 ? erNet / erPath : 0.0
regimeOk = efficiencyRatio >= minEfficiencyRatio

// ===== SESSION CLOCK =====
// From `time` (bar open) plus the bar length, never `time_close`: in live
// running a na time_close silently disabled this filter twice, and in Pine any
// comparison against na is false, so the failure leaves no trace.
istHour = hour(time, "Asia/Kolkata")
istMin  = minute(time, "Asia/Kolkata")
barMinutes  = timeframe.in_seconds() / 60
barCloseMin = istHour * 60 + istMin + barMinutes
pastEntryCutoff = useSession and barCloseMin >= entryCutoffHour * 60 + entryCutoffMin
mustSquareOff   = useSession and barCloseMin >= squareOffHour * 60 + squareOffMin

// ===== SIGNALS =====
strongCall = totalScore >= entryThreshold
strongPut  = totalScore <= -entryThreshold

var int callStreak = 0
var int putStreak  = 0
callStreak := strongCall ? callStreak + 1 : 0
putStreak  := strongPut  ? putStreak  + 1 : 0

var int lastExitBar = na
flat = strategy.position_size == 0
cooledDown = na(lastExitBar) or (bar_index - lastExitBar) >= cooldownBars
canEnter = flat and cooledDown and not pastEntryCutoff and not mustSquareOff and regimeOk

enterLong  = canEnter and callStreak >= confirmBars
enterShort = canEnter and putStreak  >= confirmBars and not enterLong

// ===== ENTRIES =====
// Long the index stands in for buying a CALL; short stands in for buying a PUT.
var int   entryBar   = na
var float peakSince  = na
var float troughSince = na

if enterLong
    strategy.entry("Long", strategy.long)
if enterShort
    strategy.entry("Short", strategy.short)

if enterLong or enterShort
    entryBar    := bar_index
    peakSince   := high
    troughSince := low

// Track the extreme in our favour since entry — this is what the trail hangs off.
if strategy.position_size > 0
    peakSince := na(peakSince) ? high : math.max(peakSince, high)
if strategy.position_size < 0
    troughSince := na(troughSince) ? low : math.min(troughSince, low)

// ===== EXITS =====
avg = strategy.position_avg_price

if strategy.position_size > 0
    hardStop  = avg - stopLossPoints
    armed     = peakSince >= avg + trailArmPoints
    trailStop = peakSince - trailPoints
    strategy.exit("L-risk", from_entry="Long", stop = armed ? math.max(hardStop, trailStop) : hardStop)

if strategy.position_size < 0
    hardStop  = avg + stopLossPoints
    armed     = troughSince <= avg - trailArmPoints
    trailStop = troughSince + trailPoints
    strategy.exit("S-risk", from_entry="Short", stop = armed ? math.min(hardStop, trailStop) : hardStop)

// Time stop — the live server gives up on a position going nowhere.
if strategy.position_size != 0 and maxHoldBars > 0 and not na(entryBar) and (bar_index - entryBar) >= maxHoldBars
    strategy.close_all(comment="time")

// Score-decay exit, the original (and still the live) backstop.
scoreExitLong  = useScoreExit and strategy.position_size > 0 and (totalScore <= exitThreshold  or strongPut)
scoreExitShort = useScoreExit and strategy.position_size < 0 and (totalScore >= -exitThreshold or strongCall)
if scoreExitLong or scoreExitShort
    strategy.close_all(comment="score")

// Intraday square-off — nothing is ever carried overnight.
if mustSquareOff and strategy.position_size != 0
    strategy.close_all(comment="EOD")

if strategy.position_size == 0 and not na(entryBar) and (strategy.position_size[1] != 0)
    lastExitBar := bar_index
    peakSince   := na
    troughSince := na
    entryBar    := na

// ===== VISUALS =====
plot(emaFast, color=color.new(color.blue, 0), title="Fast EMA")
plot(emaSlow, color=color.new(color.red, 0),  title="Slow EMA")
bgcolor(strongCall ? color.new(color.green, 90) : strongPut ? color.new(color.red, 90) : na)
bgcolor(pastEntryCutoff ? color.new(color.gray, 93) : na)

var table t = table.new(position.top_right, 2, 5, border_width=1)
if barstate.islast
    table.cell(t, 0, 0, "Score",      bgcolor=color.gray, text_color=color.white)
    table.cell(t, 1, 0, str.tostring(totalScore), bgcolor=strongCall ? color.green : strongPut ? color.red : color.gray, text_color=color.white)
    table.cell(t, 0, 1, "Efficiency")
    table.cell(t, 1, 1, str.tostring(efficiencyRatio, "#.##"))
    table.cell(t, 0, 2, "Stop (pts)")
    table.cell(t, 1, 2, str.tostring(stopLossPoints, "#"))
    table.cell(t, 0, 3, "Trail (pts)")
    table.cell(t, 1, 3, str.tostring(trailPoints, "#") + " after " + str.tostring(trailArmPoints, "#"))
    table.cell(t, 0, 4, "Position")
    table.cell(t, 1, 4, strategy.position_size > 0 ? "LONG" : strategy.position_size < 0 ? "SHORT" : "FLAT")
