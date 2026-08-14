# Runbook

## 14 Aug 2026 — profit booking (do this first)

**Step A.** Supabase SQL Editor mein `sql/migrations/002_position_monitor.sql`
chalao. Ye `trades.peak_premium` column add karta hai.

**Step B.** Naya code deploy karo. Restart pe log mein dikhna chahiye:

```
Schema check passed
Square-off scheduler started
Premium exit monitor started   {stopLossPct: 0.1, trailArmPct: 0.03, trailPct: 0.05, maxHoldMinutes: 30}
```

Agar `SCHEMA OUT OF DATE` aaye to Step A nahi chali.

**Pine script badalne ki zarurat nahi.** Exit rules server pe chalte hain aur
premium dekhte hain, index score nahi. Pine ka exit signal backstop ke taur pe
kaam karta rahega — jo pehle fire kare wahi jeetega.

### Kya badla

| Rule | Default | Kya karta hai |
|---|---|---|
| `STOP_LOSS_PCT` | 10% | Premium entry se 10% neeche gaya to turant exit |
| `TRAIL_ARM_PCT` | 3% | Trailing stop tab tak band jab tak 3% profit na ho |
| `TRAIL_PCT` | 5% | Arm hone ke baad, peak se 5% wapas aaya to exit |
| `MAX_HOLD_MINUTES` | 30 | 30 min me kuch nahi hua to nikal jao |

Trade 51 pe ye rule **+₹720 book** karta, −₹18 ki jagah.

### Expectation set kar lo

37 trades (6-14 Aug) pe conservative backtest: **−₹13,061 → −₹7,612**.
Behtar hai, **par abhi bhi loss hai**. Ye rules nuksan ko **bound** karte hain,
edge nahi dete. Entry signal ka problem alag hai — details neeche
"Ab kya expect karna hai" section mein.

---

# Runbook — 12 Aug 2026 fixes

Ye doc batata hai ki **tumhe manually kya karna hai**. Code side ka kaam ho
chuka hai; neeche wale steps sirf tum kar sakte ho (Supabase SQL editor,
TradingView, deploy).

Order matter karta hai. Step 1 sabse pehle, warna server naye signals reject
karega.

---

## Step 1 — Supabase migration chalao (ZAROORI, sabse pehle)

Supabase dashboard → SQL Editor → naya query → poori file paste karo:

```
sql/migrations/001_premium_accounting.sql
```

Ye kya karta hai:

- `trades` mein naye columns: `entry_spot`, `exit_spot`, `entry_fill_source`,
  `exit_fill_source`, `broker_entry_status`, `broker_exit_status`,
  `closed_reason`
- Purane `entry_price` / `exit_price` (jo asal mein **index level** the) ko
  `entry_spot` / `exit_spot` mein move karta hai, aur price columns khaali kar
  deta hai — taaki koi bhi index level ko premium samajh ke na padhe
- `app_config.entries_enabled` add karta hai (naya, narrow kill switch)

Safe hai re-run karna.

**Verify:** server restart karo aur log mein ye dikhna chahiye:

```
Schema check passed — premium-accounting columns present
Square-off scheduler started
```

Agar migration nahi chali to server clear error dega aur square-off scheduler
start nahi hoga (jaan bujh kar — jo close hi na ho sake use force-close karna
galat hai).

---

## Step 2 — Purana P&L theek karo (backfill)

Pehle dry run — kuch likhta nahi, sirf dikhata hai:

```bash
node scripts/backfill-premiums.js
```

Har trade ka asli option premium Upstox ke 1-minute candles se nikal ke naya
P&L dikhayega, aur purane (index-based) number se compare karega. Jin trades ka
sign ulta tha unpe `<-- SIGN WAS INVERTED` likha aayega.

Theek lage to apply karo:

```bash
node scripts/backfill-premiums.js --apply
```

Expected result: dashboard ka `+₹1,533` badal ke lagbhag **−₹6,100** ho jayega.
Ye naya number sahi hai — purana galat tha.

---

## Step 3 — Atki hui position clear karo

Abhi `BANKNIFTY` state `IN_CALL` pe atki hai (trade 37, 12 Aug 14:35 se khuli).
Jab tak ye FLAT nahi hoti, **koi naya signal accept nahi hoga**.

Pehle dekho:

```bash
node scripts/positions.js
```

Phir do options:

```bash
# Recommended: proper exit order place karke, premium se P&L nikaal ke band karo
node scripts/positions.js --close

# Sirf tab jab position broker pe hai hi nahi — state flag reset, koi order nahi
node scripts/positions.js --force-flat
```

**Kaunsa use karein:** Upstox sandbox ne kabhi koi order fill nahi kiya (sab
`open pending` hain), matlab broker pe koi asli position hai hi nahi. Lekin
`--close` phir bhi behtar hai — wo exit order place karega, market premium se
price karega, aur trade row properly band karega. `--force-flat` P&L record
nahi karta, isliye sirf emergency mein.

> Market band hone ke baad `--close` chalaoge to exit order Upstox reject kar
> sakta hai. Tab ya to market hours ka wait karo, ya `--force-flat` use karo.

---

## Step 4 — Pine script TradingView pe update karo

`pineScript.js` ki poori file copy karke TradingView Pine editor mein purani
script replace kar do, phir **Save** aur **Add to chart**.

Naye inputs (defaults already set hain, chhedne ki zarurat nahi):

| Input | Default | Kyu |
|---|---|---|
| Include volume component | **off** | Index ka volume synthetic hai; 7/24 entries iske bharose fire hui aur sab loss mein gayi |
| Exit threshold | **3** (pehle 1) | Entry (4) aur exit (3) ab mil jaate hain — dead band khatam |
| Bars score must hold | 1 | 2 karke dekh sakte ho — kam entries, zyada confirmation |
| Cooldown bars after exit | 1 | Exit ke turant baad dobara ghusne se rokta hai |
| Enforce intraday session | on | 14:45 ke baad koi entry nahi, 15:15 pe force exit |

**Alert dobara banani padegi ya nahi?** Nahi — agar tumhari alert "Any alert()
function call" pe set hai to script update karne se wahi alert naya code use
karegi. Bas confirm kar lena ki alert ka **Expiration** khatam na ho gaya ho
(TradingView free plan pe alerts expire hoti hain).

Webhook URL aur payload format bilkul same hai, kuch badalna nahi hai.

---

## Step 5 — TradingView data feed check karo (important)

6 aur 7 August ko saare 21 alerts **15 minute late** aaye. Wajah: NSE real-time
data subscription na hone par TradingView delayed feed deta hai. 10 August se
theek ho gaya tha, par confirm kar lo ki wo permanent hai.

Chart pe symbol ke paas dekho:

- **"Real-time"** ya "Cboe BZX" jaisa kuch → theek hai
- **"Delayed 15 min"** → problem hai, NSE data subscription lena padega

Ye bug abhi bhi wapas aa sakta hai. Agar delayed feed pe chalega to bot 15
minute purane price pe trade karega.

---

## Step 6 — Deploy

Render/jahan bhi host hai, wahan naya code deploy karo. Naye env vars **optional
hain** (sab ka sensible default hai), par chaaho to set kar sakte ho:

```
ENTRY_CUTOFF_IST=14:45
SQUARE_OFF_IST=15:20
SQUARE_OFF_ENABLED=true
PAPER_SLIPPAGE_POINTS=1.5
```

Deploy ke baad `/health` check karo:

```json
{
  "status": "ok",
  "trading_enabled": true,
  "entries_enabled": true,
  "market_open": false,
  "ist_time": "2026-08-13 09:00:00",
  "entry_cutoff_ist": "14:45",
  "square_off_ist": "15:20"
}
```

`entries_enabled` agar `null` aa raha hai → migration nahi chali (Step 1).

---

## Naya kill switch — `entries_enabled`

Ab do switch hain:

| Switch | Kya karta hai | Kab use karo |
|---|---|---|
| `trading_enabled` | **Sab kuch** band — entries aur exits dono | Emergency. Dhyan: khuli position phas jayegi |
| `entries_enabled` | Sirf **nayi entries** band, exits chalu | Safely wind down karna ho |

Supabase → `app_config` table → row `id = 1` → flag toggle karo. Turant asar
hota hai, redeploy nahi chahiye.

Din khatam karne ka safe tareeka: `entries_enabled = false` karo, phir 15:20 pe
square-off khud position band kar dega.

---

## Ab kya expect karna hai

Ye fixes system ko **sahi aur safe** banate hain — **profitable nahi**.

Jo theek ho gaya:

- P&L ab asli option premium se calculate hota hai (pehle index se hota tha,
  aur har PUT trade ka sign ulta aata tha)
- Position overnight nahi rahegi — 15:20 pe force close
- 14:45 ke baad koi nayi entry nahi (pehle 15:31 pe bhi entry ho jaati thi)
- Dead band khatam — chart pe fresh signal dikhe aur bot purani position pakde
  hue baithe, ab aisa nahi hoga
- Reversal pe exit aur entry ab race nahi karte (per-symbol queue)
- Sandbox ki asliyat ab record hoti hai (`broker_entry_status` mein
  `open pending` dikhega — kyunki sandbox kabhi fill karta hi nahi)

Jo **ab bhi problem hai**:

Indicator ka directional edge negative hai. Signal ke 10 minute baad Bank Nifty
signalled direction mein sirf 33% baar gaya (random ~49%). Maine har parameter
combination test kiya — koi bhi profitable nahi tha, ulta signal lene par bhi
loss hota hai.

Isliye: **ye system ab bhi paisa haarega**, bas ab sach-sach report karega. Agle
kuch din isko sirf **data collect karne** ke liye chalao, profit ke liye nahi.
Asli kaam ye hai ki signal khud dobara design ho — 4-5 correlated lagging
indicators ki jagah kuch aisa jo move ke baad confirm karne ke bajaye pehle
pakde.
