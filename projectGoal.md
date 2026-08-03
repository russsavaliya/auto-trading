# Project Brief: TradingView → Upstox Sandbox Auto-Trading Bridge

## Goal
Bank Nifty options (CALL/PUT) ke liye ek Pine Script indicator already ban chuka hai jo entry aur exit signals deta hai (score-based: Trend + Momentum + Volume). Ab is signal ko **automatically paper trade** karwana hai Upstox Sandbox pe, kai hafte test karne ke baad hi real money pe move karna hai.

## Architecture (Flow)
```
TradingView Alert (Pine Script se, JSON payload)
        │  webhook fire hota hai
        ▼
Custom Node.js Bridge Server (Express)
   - webhook receive + validate
   - duplicate alert check
   - current position state check
   - Upstox Sandbox order placement
   - Supabase mein full trade log
        ▼
Upstox Sandbox API (paper trade order place)
```

## Current Status
- ✅ Pine Script indicator ready — Directional Bias Score (CALL/PUT), score range -6 to +6, strongCall (≥4) / strongPut (≤-4) triggers entry, exit logic bhi add ho chuka hai (score weaken hone pe ya opposite bias flip hone pe exit signal deta hai — `exitThreshold` input se control hota hai).
- ✅ Node.js chosen as bridge language (not Python) — kyunki main already Node dev hoon aur ye sirf webhook-receive → parse → API-call → log ka kaam hai, heavy data science nahi.
- ✅ Node.js bridge code Claude Code se likhwa chuka hoon aur review bhi ho chuka hai (logic sahi hai) — but abhi tak sirf code/logic check hua hai, real credentials `.env` mein daalni baaki hain.
- ⏳ Next: `.env` credentials fill haff fill kar diya he , phir Pine Script alert JSON format ko bridge ke expected format se match karna, phir local testing.

## Bridge Server — Key Requirements (already built, for reference)
1. **Webhook receiver** (`POST /webhook/tradingview`) — signal_type, symbol, price, score, timestamp, unique alert_id accept karta hai.
2. **Webhook security** — shared secret query param (`?token=...`) se verify hota hai, kyunki TradingView custom headers set nahi karne deta webhook alerts mein.
3. **Duplicate prevention** — same alert_id dobara aaye toh skip (Supabase mein unique constraint), plus 30-second time-window check same signal_type ke liye.
4. **Position state tracking** — FLAT / IN_CALL / IN_PUT, Supabase mein persist hota hai (server restart pe bhi state na khoye). Entry order sirf tab place hota hai jab state usse allow kare (e.g. IN_CALL rehte hue dubara CALL_ENTRY na le), exit sirf tab jab actually position mein ho.
5. **Upstox Sandbox integration** — sandbox=true mode, retry logic (max 2 retries, exponential backoff) transient failures ke liye.
6. **Trade logging** — `trades` table (entry/exit price, score, order_id, status, pnl) + `webhook_log` table (har incoming webhook, duplicate/reject bhi) Supabase mein.
7. **Kill switch** — Supabase `app_config.trading_enabled` flag se turant pause kar sakte hain naye orders ko, bina redeploy kiye. `.env` ka `TRADING_ENABLED` sirf fallback hai agar Supabase read fail ho jaye.
8. **Structure** — separated files: `server.js`, `routes/webhook.js`, `services/upstoxService.js`, `services/supabaseService.js`, `services/duplicateCheck.js`, `services/positionState.js`, `middleware/validateWebhook.js`, `config/env.js`.

## Env Variables Needed (values fill karni hain, agent ko mat batana actual values)
- `WEBHOOK_SECRET` — khud generate karna hai (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), TradingView alert URL mein `?token=...` se bhejna hai.
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — Supabase dashboard → Project Settings → API se (service_role/secret key, anon key nahi — service_role sab RLS bypass karta hai, sirf server pe use hona chahiye, kabhi bhi frontend/client code mein nahi).
- `UPSTOX_API_BASE_URL`, `UPSTOX_SANDBOX_ACCESS_TOKEN` — Upstox developer console se sandbox token generate karna hai (sandbox base URL Upstox docs se verify karna, brokers paths change karte rehte hain).
- Order defaults (`DEFAULT_INSTRUMENT_TOKEN`, `DEFAULT_QUANTITY`, etc.) — sirf local-testing fallback hain, real alerts mein instrument_token/quantity Pine Script JSON payload mein directly bhejna better hai kyunki weekly option contracts expiry/strike ke saath change hote hain.

## Next Steps (in order)
1. `.env` mein sab real credentials fill karna (Supabase project banao agar nahi bana, Upstox sandbox access token generate karo).
2. Supabase mein `sql/schema.sql` run karna (trades, webhook_log, app_config tables).
3. Pine Script mein `alert()` function calls add karna — structured JSON payload ke saath (signal_type, symbol, price, score, alert_id, timestamp) jo bridge ke expected format se match kare.
4. TradingView mein alert set karna, webhook URL mein bridge server ka URL + `?token=WEBHOOK_SECRET` daalna.
5. Local mein curl se webhook simulate karke test karna (bina TradingView ke, directly POST request bhejke).
6. Server ko deploy karna (Railway/Render/VPS jahan bhi hosting ho) taaki TradingView actual webhook hit kar sake.
7. Kai hafte (minimum 4-6 hafte) paper trading observe karna — alag-alag market conditions (trending, choppy, high volatility) cover honi chahiye.
8. Metrics track karna: win rate, avg profit/loss per trade, max drawdown, kitni baar exit signal late fire hua.
9. Sab sahi lagne ke baad hi chhoti position size ke saath real Upstox account pe move karna — kill switch hamesha ready rakhna.

## Important Safety Reminders (agent ko bhi yaad dilana)
- Duplicate order kabhi place na ho — ye sabse critical hai.
- State check hamesha Supabase se fresh read ho, cache na ho (especially kill switch flag).
- Real credentials kabhi bhi commit ya kisi third-party tool/chat mein paste na ho.
- Sandbox endpoint hi use ho jab tak explicit decision na le ki live jaana hai.