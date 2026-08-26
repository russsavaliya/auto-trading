# Investigation — Loss Analysis & Profit Improvement Plan

**Date:** 20 August 2026, ~18:10 IST
**Prepared by:** Claude (Senior Dev + Market-behaviour review), Rushabh ke liye
**Scope:** Poore Supabase database (`trades`, `webhook_log`, `app_config`, `position_state`) ka fresh query kar ke, real Upstox market data (jo `src/services/marketData.js` already live Upstox candle API se leta hai) ke against verify kiya. Ye RUNBOOK.md (12-14 Aug) ke baad ka naya data hai — us doc mein 37 trades tak ka analysis tha, ab DB mein **61 trades** hain.

---

## 1. TL;DR — sabse important baat pehle

- **6-14 Aug** (RUNBOOK ka window): 37 trades, **-₹13,060**, 27% win rate. Ye DB se match ho gaya, purana analysis sahi tha.
- **15-20 Aug** (naya data, kisi doc mein abhi tak nahi likha): 16 trades, **+₹3,436**, 37.5% win rate.
- **Poore 53 closed trades ka net: -₹9,624.** Loss abhi bhi hai, lekin 14 Aug ko jo premium-based exit rules (`positionMonitor.js`) live kiye the, unke baad se system **pehli baar net profitable** chal raha hai.
- **Sabse bada single finding:** jab bhi trade **score-based signal exit** (`closed_reason = 'signal'`) se band hua — poore history mein 17 baar — usme se sirf **1 trade profitable** tha. Total **-₹11,395** — yani poore -₹9,624 ke net loss se bhi zyada, matlab baaki sab exits (stop-loss/trailing/time-stop) combined **profitable** hain (+₹1,771). Ye ek hi number RUNBOOK ke conclusion ko confirm karta hai: **score-based exit hi sabse zyada nuksaan de raha hai**, aur ab bhi de raha hai (15 Aug ke baad ke 5 signal-exits, sab ke sab loss, -₹2,977).
- Isका matlab ye **nahi** hai ki entry signal theek ho gaya hai. Isका matlab ye hai ki **risk management (exit rules) apna kaam kar raha hai** — bad entries ka nuksaan bound kar raha hai aur jo trade sahi nikalta hai usse chalne de raha hai. Entry abhi bhi weak hai, bas ab uske aas paas ek accha safety net hai.
- **Abhi real paisa mat lagao.** 16 trades ek bahut chhota sample hai — ye pure luck se bhi profitable dikh sakta hai. Neeche Section 5 mein exact reasoning aur ek concrete test hai jo isko hafto wait kiye bina settle kar sakta hai.

---

## 2. Kya dekha (raw evidence, DB se)

### 2.1 Overall numbers

| Period | Trades | Priced | Win rate | Net P&L | Avg/trade |
|---|---|---|---|---|---|
| 6-14 Aug (RUNBOOK window) | 37 | 37 | 27.0% | **-₹13,060.50** | -₹352.99 |
| 15-20 Aug (naya, is doc mein pehli baar) | 16 | 16 | 37.5% | **+₹3,436.50** | +₹214.78 |
| **All-time (53 closed)** | 53 | 53 | 30.2% | **-₹9,624.00** | -₹181.58 |

Per-day breakdown (15-20 Aug):

| Date (IST) | Trades | Net P&L |
|---|---|---|
| 17 Aug | 1 | +₹3,412.50 |
| 18 Aug | 5 | -₹1,258.50 |
| 19 Aug | 6 | +₹261.00 |
| 20 Aug (aaj) | 4 | +₹1,021.50 |

Operational health bhi check kiya: **15 Aug ke baad ek bhi order fail nahi hua**, koi duplicate-order bug nahi, koi stuck position nahi. Jo 8 `FAILED` trades DB mein hain sab **6-13 Aug ke purane hain** (state-machine ne sahi se dobara-entry reject ki thi — ye bug nahi, ye design ke mutabik kaam hai). Abhi state `FLAT` hai, `trading_enabled=true`, `entries_enabled=true` — system clean chal raha hai.

### 2.2 Exit reason ke hisaab se — ye sabse zaroori table hai

| `closed_reason` | Trades | Wins | Net P&L | Avg |
|---|---|---|---|---|
| **signal** (Pine score decay — purana backstop) | 17 | **1** | **-₹11,395.50** | -₹670.32 |
| time_stop (30 min, premium rule) | 4 | 2 | +₹4,747.50 | +₹1,186.88 |
| trailing_stop (premium rule) | 6 | 4 | +₹2,503.50 | +₹417.25 |
| stop_loss (premium rule) | 1 | 0 | -₹837.00 | -₹837.00 |
| null (14 Aug se pehle, purana code) | 24 | 8 | -₹6,094.50 | -₹253.94 |
| manual_close | 1 | 1 | +₹1,452.00 | +₹1,452.00 |

Padho ise dhyan se: **premium-based rules (time_stop + trailing_stop + stop_loss) combined = +₹6,414 profit, 6 wins / 11 trades (54.5%)**. Ye teeno rules 14 Aug ko add kiye gaye the specifically isliye ki score-based exit bahut late fire karta hai (RUNBOOK Section "6. EXITS NO LONGER LIVE HERE" mein wajah likhi hai). Data confirm karta hai ki ye decision sahi tha.

`signal` reason — yani jab premium ka koi rule fire nahi hua tha aur Pine ka apna score-decay exit hi position band kar gaya — **17 mein se 16 baar loss**. Ye pattern 15 Aug ke baad bhi waisa hi hai: trades #57, #59, #60, #61, #66 — sab `signal` se band hue, sab loss (-₹976.50, -₹993, -₹615, -₹202.50, -₹190.50).

**Iska sahi matlab kya hai:** jab entry ke baad na to trailing stop arm hua (matlab 3% profit kabhi aaya hi nahi), na hi 10% stop-loss touch hua, aur score khud hi decay ho gaya — to wo trade **shuru se hi galat entry thi**. Ye exit mechanism ka fault nahi hai, ye confirm karta hai ki us particular entry mein koi real move tha hi nahi. Isliye fix "score-exit ko better banao" nahi hai — fix hai **entry ko better banana**, jo RUNBOOK pehle se keh raha tha.

### 2.3 CALL vs PUT asymmetry — dhyan se dekho, abhi action mat lo

| Side | Trades | Wins | Net P&L |
|---|---|---|---|
| CALL (all-time) | 25 | 8 | +₹1,764 |
| PUT (all-time) | 28 | 8 | **-₹11,388** |
| CALL (15-20 Aug only) | 7 | — | +₹5,745 |
| PUT (15-20 Aug only) | 9 | — | -₹2,308.50 |

All-time wala gap bahut zyada dramatic hai, lekin **isko face value pe mat lo** — RUNBOOK khud bata chuka hai ki 12 Aug se pehle **har PUT trade ka P&L sign inverted tha** (index-vs-premium confusion bug, migration 001 se fix hua). Purana -₹11,388 wala number us bug se contaminated ho sakta hai.

15-20 Aug wala number (CALL +₹5,745 vs PUT -₹2,308.50) zyada trustworthy hai kyunki ye migration ke baad ka clean data hai — lekin **7 aur 9 trades bhi bahut chhote samples hain**. Isi period mein BANKNIFTY spot khud bhi mildly upar gaya (17 Aug ko ~57,214 se 20 Aug ko ~57,448 tak, beech mein chop ke saath) — ho sakta hai ye sirf is hafte ka general uptrend ho, koi structural PUT-side weakness na ho. **Recommendation: log karte raho, 3-4 hafte aur data collect hone do, tab tak koi CALL-only ya PUT-bias wala change mat karo.**

### 2.4 Ek cheez jo turant check karni chahiye: Pine script version mismatch

`strategy/pineScript.js` mein `er` (Efficiency Ratio) field har alert ke saath bhejta hai (line 315 dekho). Lekin DB mein ye field **sirf aaj (20 Aug) se aa raha hai** — 17, 18, 19 Aug ke saare alerts mein `er` field hi missing hai (`undefined`).

Iska matlab: **TradingView chart pe jo script live tha 17-19 Aug ko, wo isse purana version tha** — shayad `er` field add hone se pehle ka. Ho sakta hai baaki sab logic same ho (entry/exit thresholds waghera), lekin ye confirm karna zaroori hai:

**Action:** Ab TradingView Pine editor khol ke check karo ki jo script chart pe "Added to chart" hai wo **hu-ba-hu** `strategy/pineScript.js` (is repo ka latest version) ke saath match karta hai. Agar nahi, to Save + Add to chart dobara karo (RUNBOOK Step 4 jaisa). Chhota sa cheez hai lekin agar production mein aisa hua to purane parameters silently chalte rahenge bina pata chale.

---

## 3. Kyu ho raha hai — root cause (RUNBOOK se confirm/extend)

Pine script khud is repo mein (comments lines 50-67) apna structural problem likh chuka hai, aur ab tak ka naya data usi ko support karta hai:

1. **Entry score lagging hai.** EMA cross, close-vs-EMA, Supertrend direction — teeno almost same cheez teen baar count ho rahi hai (trend already established hone ke baad hi score |4| tak pahunchta hai). RSI/MACD bhi similarly lagging. Jab tak score confirm karta hai ki move ho raha hai, option premium ka acha hissa already move ho chuka hota hai — bacha hua move capture karne ke liye kaafi kam reward, itna risk lene ke liye.
2. **Isi wajah se `signal`-exit trades itni consistently haarte hain** (Section 2.2) — jin trades mein premium kabhi meaningfully move hi nahi hua (na profit ki taraf, na stop-loss ki taraf), unme entry hi weak thi.
3. **Risk management (14 Aug se) ne is problem ko "bound" kar diya hai, "fix" nahi kiya.** Jab entry sahi nikalti hai, trailing stop use profit lock karne deta hai (jaise trade #63: +₹2,467.50, ya #52: +₹3,412.50). Jab entry galat nikalti hai, stop-loss/time-stop use jaldi seemit nuksaan pe band kar deta hai. Ye classic "cut losses short, let winners run" pattern hai — aur ye pattern hi hai jisne 15 Aug ke baad numbers ko positive kiya.

**Seedhi baat:** system ab "safe" hai (RUNBOOK ka wahi conclusion), aur naya data pehli baar ye bhi keh raha hai ki ho sakta hai ye ab "marginally profitable" bhi ho — lekin abhi ye claim karne layak evidence nahi hai. 16 trades se koi statistically meaningful edge prove nahi hota.

---

## 4. Market kab trap karta hai — is specific system ke liye

Tumne market-trap experience ke baare mein poocha, to seedha is data se jo dikh raha hai:

- **Chop/range mein ye system sabse zyada phasta hai.** Trend-following score (EMA+Supertrend+MACD) range-bound market mein har swing high pe CALL aur har swing low pe PUT le leta hai — jabki range mein price wapas aa jaata hai. Yehi wo trades hain jo `signal`-reason se, bina kabhi trail-arm hue, loss mein band hote hain (Section 2.2).
- **Efficiency Ratio (`er`) exactly isi cheez ko measure karta hai** — kitna clean trend hai vs kitna wandering/chop hai. Filter is repo mein already bana hua hai (`minEfficiencyRatio` input) lekin **deliberately OFF hai** kyunki purane sample (Aug 6-14) mein sirf 9 "good regime" signals the — bahut kam. Aaj se `er` field record hona shuru hua hai (Section 2.4 dekho), to ab is hypothesis ko test karne layak data collect hona shuru hoga. **Abhi turant filter mat on karo — pehle 3-4 hafte ka `er`-tagged data jama hone do.**
- **News/event-driven spikes** — is data mein directly nahi dikhte (koi specific outlier candle flag nahi mila), lekin trend-following score ka structural weakness hai ki wo **V-shaped reversal ko sabse der se pakadta hai** — jab market ek news spike ke baad turant wapas trap hoke ulta jaata hai, score tab tak same direction bata raha hota hai jab tak reversal already ho chuka hota hai. Isi wajah se "signal" exits itni consistently der se aur loss mein aate hain.

---

## 5. Profit rate badhane ke liye — concrete, prioritized action plan

### Priority 1 — Backtest tool jo already ban chuka hai, use hi nahi hua abhi tak

`strategy/pineStrategy.js` exactly isi sawaal ke liye bana hai: "kya ye score 6-12 mahine ke real history pe paisa banata hai" — bina hafto wait kiye seconds mein pata chal sakta hai. File ke apne comments (lines 20-24) kehte hain ki ye 37 live trades ka sample bahut chhota hai.

**Action:** TradingView Strategy Tester mein `strategy/pineStrategy.js` ko BANKNIFTY 5-min chart pe kam se kam **1 saal** ke history pe chalao. Dekho:
- Net profit/loss kya hai (options premium approximation ke saath, jo file mein already built hai)
- `minEfficiencyRatio` ko 0 / 0.15 / 0.25 / 0.35 pe sweep karke dekho — regime filter helpful hai ya nahi (ye khud file ka comment bhi bolta hai: "the whole reason this backtest exists")
- Agar ek saal ke data pe bhi ye net loss deta hai — to RUNBOOK ka apna rule follow karo: **"a LOSS here is conclusive — the idea is dead, stop"**. Fir naya entry logic banane ka kaam priority ban jaata hai, na ki isी ko tune karte rehna.

Ye sabse fast aur sabse zyada information-dense step hai — baaki sab steps hafto lenge, ye ghante mein ho sakta hai.

### Priority 2 — Script version confirm karo (Section 2.4)

TradingView pe live chart ka Pine script `strategy/pineScript.js` (is repo) se match karta hai ya nahi, ye aaj hi verify karo. Agar mismatch mila, to sync karo aur RUNBOOK Step 4 dobara follow karo.

### Priority 3 — Paper trading jaari rakho, kam se kam 3-4 hafte aur

16 trades — chahe profitable dikhe — statistically luck aur edge mein फर्क nahi kar sakte. Standard rule of thumb: kam se kam **60-100 priced trades** chahiye, wo bhi consistent script version ke saath (Priority 2 fix hone ke baad), taaki win rate aur avg P&L ka confidence interval kaafi tight ho. Har hafte ye report jaisा ek chhota review karo:
- Win rate, net P&L, avg win vs avg loss
- `closed_reason` ka breakdown (signal vs time_stop vs trailing_stop vs stop_loss) — agar `signal` phir se sabse bada loss-source rehta hai, entry hi problem hai, exit nahi
- CALL vs PUT split, `er` vs outcome correlation

### Priority 4 — Real paisa lagane se pehle checklist

Jab Priority 1 (backtest) positive aaye AUR Priority 3 (naya paper sample) bhi consistent profit dikhaye, tabhi:
- Chhoti position size se shuru karo (1 lot)
- Kill switch (`app_config.trading_enabled` / `entries_enabled`) hamesha haath mein rakho
- `UPSTOX_SANDBOX_ACCESS_TOKEN` ki jagah live token + live base URL — is switch ko bahut carefully, ek alag `.env` change ke roop mein karo, sandbox se accidentally live mat ho jaye
- `projectGoal.md` ka "pannding pase 2" item (3 PM ke baad order na lena, same-din square-off) — **ye already implemented hai** (`services/scheduler.js` + `entryCutoffIst=14:45` / `squareOffIst=15:20` in `src/config/env.js`, verified running in `server.js`). Ye doc mein purana pending note ab stale hai, chaho to `projectGoal.md` update kar sakte ho.

### Priority 5 (low urgency) — Regime filter aur exit-tuning

`er` field ka data 3-4 hafte jama hone do, phir `minEfficiencyRatio` on karne ka faisla lo real numbers se, guess se nahi (jaisa file ka comment khud kehta hai). Isi tarah CALL/PUT asymmetry — abhi action mat lo, sirf track karo.

---

## 6. Bottom line

- System **safe** hai (no bugs, clean state, kill switches kaam kar rahe hain).
- System **15 Aug se net profitable** dikh raha hai — lekin ye **proof nahi**, sirf ek **encouraging signal** hai jiska sample bahut chhota hai.
- Root cause wahi hai jo RUNBOOK mein already likha tha: **entry signal lagging hai**, aur exit rules (jo already ban chuke hain) is weakness ko bound kar rahe hain, fix nahi kar rahe.
- Sabse zyada leverage wala agla kadam **code likhna nahi hai — jo backtest tool already bana hua hai (`strategy/pineStrategy.js`) usse turant chalana hai.** Ye sabse tez tareeka hai ye pata karne ka ki edge real hai ya nahi, real paisa risk kiye bina.
