# Live Trading — Go-Live Checklist

**Likha gaya: 2 Sep 2026.** Sab kuch Upstox ke live docs aur live instrument
master se verify kiya gaya hai — guess kuch nahi hai. Jahan doc pages aapas
mein disagree karte hain, wahan saaf likha hai ki khud confirm karna hai.

Ye document sirf "sandbox se live" ke liye hai. Strategy ki performance ka
sawaal alag hai aur sabse neeche [Expectation](#expectation-set-kar-lo) mein
hai — **wo section skip mat karna.**

---

## Order of operations

Ye kramm se karna. 2 aur 3 ke bina 4 ka koi matlab nahi.

| # | Kaam | Blocker? |
|---|---|---|
| 1 | Static IP arrange karo aur Upstox mein register karo | 🚫 Haan |
| 2 | Daily token refresh pipeline banao | 🚫 Haan |
| 3 | Code changes (neeche list) | 🚫 Haan |
| 4 | Config values badlo | — |
| 5 | `TRADING_ENABLED=false` pe 1-2 hafte infra chalao | — |
| 6 | Cap 1/day pe switch on | — |

---

## 1. 🚫 Static IP — sabse pehla blocker

SEBI ka static-IP mandate **1 April 2026 se enforce** ho raha hai. Har API
order call ek registered static IP se aana chahiye.

Upstox ke circular se:

> All the API orders must originate from a registered Static IP... any order
> requests from unregistered IPs will be rejected.

**Abhi bridge Render pe hai, jahan dynamic IP hai. Live jaate hi har order
reject hoga.** Ye code ka problem nahi, infrastructure ka hai.

Do constraints jo planning badal dete hain:

- Primary + secondary — do IP register kar sakte ho (My Apps mein, ya Update
  Static IPs API se)
- **IP hafte mein sirf ek baar update ho sakta hai**, aur update karte hi
  saare access tokens invalid ho jaate hain

Restriction sirf write APIs pe hai — place / modify / cancel / multi-order /
GTT / exit positions. Read-only APIs pe nahi.

### Options

| Option | Baat |
|---|---|
| Static IP wala VPS | Sabse seedha. Render se migrate karna padega. |
| Static-IP proxy (QuotaGuard type) | Render pe rehne deta hai, par ek aur failure point |
| Render + reserved IP | Check karo ki plan support karta hai ya nahi |

> Agar aapka algo **10 orders/second se zyada** karta to SEBI registration aur
> exchange se Algo ID chahiye hota. Aap 2 trades/**din** karte ho — us category
> mein nahi aate, exchange approval nahi chahiye.

---

## 2. 🚫 Daily token — sabse bada operational change

|  | Sandbox (abhi) | Live |
|---|---|---|
| Validity | **30 din** (3 Aug → 2 Sep chala) | **Har din 3:30 AM IST pe expire** |

Live token *jab bhi* banao, **agli subah 3:30 baje mar jaata hai**. Mangal raat
8 baje banaya → Budh 3:30 AM khatam. Budh 2:30 AM banaya → usi Budh 3:30 AM
khatam.

**2 Sep 2026 ko jo hua wo live mein har din ho sakta hai.** Us din token 3:30
pe expire hua, pehla signal 9:25 pe aaya, aur 6 ghante tak har order `401` —
bina kisi alert ke. Poora din chala gaya.

### Jo abhi missing hai

Codebase mein sirf ek ready-made token `.env` mein padta hai. Daily refresh ke
liye OAuth flow chahiye jo abhi hai hi nahi:

- API key + API secret
- Redirect URI
- Login complete karne ka tareeka (user interaction / TOTP)

**Ye design karke test karna hai, warna live jaana bekaar hai.**

---

## 3. 🚫 Code changes

### 3.1 Do alag hosts

Live mein order placement aur order details **alag hosts** pe hain:

| Kaam | Live host |
|---|---|
| Order place | `https://api-hft.upstox.com/v2/order/place` |
| Order details | `https://api.upstox.com/v2/order/details` |

[`upstoxService.js:9`](../src/services/upstoxService.js#L9) ek hi `baseURL`
dono ke liye use karta hai — **ye tootega.**

> ⚠️ Ye do alag doc pages se aaya hai jo aapas mein consistent nahi hain
> (place-order page `api-hft` dikhata hai, overview page nahi). Go-live se
> pehle apne account pe confirm kar lena.

### 3.2 Token module load pe bake hota hai

[`upstoxService.js:9-16`](../src/services/upstoxService.js#L9-L16) mein axios
client module load pe banta hai aur token headers mein baked ho jaata hai.

Daily rotation ke saath iska matlab: **roz server restart**, ya per-request
token read karne ke liye refactor. Sandbox mein ye 30 din mein ek baar ki baat
thi — ab roz ki hai. **Ab ye cosmetic nahi, critical hai.**

### 3.3 Fill race — live mein galat price record hogi

[`tradeExecutor.js:33-49`](../src/services/tradeExecutor.js#L33-L49) mein
`getOrderFill` order place karne ke **turant baad** call hota hai, bina retry
ke.

Sandbox mein ye kabhi fill nahi hota tha, toh hamesha paper mark use hota tha —
by design. Live mein MARKET order fill hone mein kuch sau ms lagte hain. Us
waqt `isFilled` false hoga aur code **paper mark record kar lega, asli fill
nahi.**

Chhota poll chahiye (thodi der, kuch attempts) fill ka intezaar karne ke liye.

### 3.4 `X-Algo-Name` header

Algo App se order dene pe required. Abhi bheja nahi jaata.

### 3.5 Chhoti cheezein

| Kya | Kahan |
|---|---|
| `sandbox_mode: true` hardcoded | [`health.controller.js:23`](../src/controllers/health.controller.js#L23) |
| `lot_size` resolve hota hai par use nahi hota | [`instrumentResolver.js:89`](../src/services/instrumentResolver.js#L89) |
| Env var ka naam `UPSTOX_SANDBOX_ACCESS_TOKEN` | [`env.js:14`](../src/config/env.js#L14) — kaam karega, par naam galat lagega |

---

## 4. Config values

| Variable | Abhi | Live |
|---|---|---|
| `UPSTOX_API_BASE_URL` | `https://api-sandbox.upstox.com/v2` | `https://api.upstox.com/v2` |
| `UPSTOX_SANDBOX_ACCESS_TOKEN` | 30-din token | daily token |
| `DEFAULT_PRODUCT` | `I` | `I` — same |
| `DEFAULT_ORDER_TYPE` | `MARKET` | `MARKET` — same |
| `PAPER_SLIPPAGE_POINTS` | `1.5` | **useless** — real fills aayenge |
| `TRADING_ENABLED` | `true` | **`false` se shuru karo** |

### Naye, jo abhi hain hi nahi

- `UPSTOX_API_KEY` + `UPSTOX_API_SECRET` + redirect URI — daily token ke liye
- `X-Algo-Name` ki value

---

## 5. Verified facts

Ye maine khud check kiya, doc padh ke nahi:

**Lot size — ✅ theek hai.** Live instrument master
(`assets.upstox.com/.../NSE.json.gz`) se: BANKNIFTY ke **saare 880 option
contracts pe `lot_size = 30`**. Pine `orderQty = 30` bhejta hai = exactly 1 lot.
Valid. Freeze quantity 600, toh wo bhi constraint nahi.

Par [`instrumentResolver.js:89`](../src/services/instrumentResolver.js#L89)
`lotSize` return to karta hai, use nahi karta — agar exchange kabhi lot size
badle to quantity chup-chaap invalid ho jayegi aur order reject hone lagenge.

**Rate limits — ✅ koi issue nahi.**

| Category | Per second | Per minute | Per 30 min |
|---|---|---|---|
| Order placement | 10 | 500 | 2,000 |
| Baaki (historical candles, positions, funds) | 50 | 500 | 2,000 |

Aap 2 trades/**din** karte ho. Bahut door hain limit se.

---

## 6. Capital

Options **buy** kar rahe ho, toh full premium chahiye — margin nahi.

```
~₹500 premium × 30 qty  =  ~₹15,000 per position
ek time pe ek position
buffer ke saath           =  ~₹30,000–40,000
```

---

## Expectation set kar lo

**Ye section sabse important hai.**

2 Sep 2026 tak ke **71 real closed trades** pe, real premium exits aur real
charges ke saath:

```
Gross P&L      −₹3,690
Charges        −₹7,036
─────────────────────────
NET           −₹10,726
```

Charges gross loss se **dugne** hain. Break-even ke liye premium ko 0.65%
chahiye = **~6.6 index points** — jo sirf **30% signals** dete hain.

### Jo entry filters test kiye, sab fail hue

| Filter | Test | Result |
|---|---|---|
| Efficiency Ratio | null test, real P&L | **p = 0.51** — random drop utna hi achha |
| `\|score\| == 5` | leave-one-day-out + date split | regime artifact, filter nahi |
| ORB / morning breakout | 12-month null test | random entries **zyada** kamate hain |
| Signal inversion | pehle se documented | zero se alag nahi |

### Daily cap ka sach

| Cap | Trades | Net |
|---|---|---|
| **1/day** | 19 | **+₹7,210** |
| 2/day (abhi) | 37 | +₹2,273 |
| 3/day | 48 | −₹4,164 |
| No cap | 71 | −₹10,726 |

Monotone hai, aur cap-1 leave-one-day-out bhi survive karta hai. **Par** null
test (p = 0.079) kehta hai ki ye "behtar trade chunna" nahi hai — sirf **"kam
trade karna"** hai. Negative-expectancy signal pe ye pure arithmetic hai, edge
nahi. Aur sample sirf 19 trades ka hai.

### Seedhi baat

Sandbox mein ye ₹10,726 kaalpanik tha. **Live mein ye asli paisa hoga.**

Agar phir bhi live jaana hai:

1. `TRADING_ENABLED=false` se shuru karo
2. Static IP + daily token pipeline **1–2 hafte** chalake dekho ki infra
   reliable hai — token roz refresh ho raha hai, orders reject nahi ho rahe
3. Tab jaake switch on karo, aur **cap 1/day pe**

---

## Sources

- [Place Order](http://upstox.com/developer/api-documentation/place-order/)
- [Get Order Details](http://upstox.com/developer/api-documentation/get-order-details/)
- [Rate Limits](http://upstox.com/developer/api-documentation/rate-limiting/)
- [Algo Trading Circular](https://upstox.com/developer/api-documentation/announcements/algo-trading-circular/)
- [API Overview](http://upstox.com/developer/api-documentation/api-overview/)
