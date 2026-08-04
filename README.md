# TradingView → Upstox Sandbox Webhook Bridge

Receives TradingView Pine Script alerts for a Bank Nifty CALL/PUT options
strategy and places matching paper-trading orders against the **Upstox
Sandbox API**. Built for safety first: idempotent alert handling, a
persisted position state machine, an always-on audit log, and a kill switch.

## Project structure

```
server.js                    Express app entry point
config/env.js                Loads and validates .env, exports config
routes/webhook.js             POST /webhook/tradingview — orchestration logic
middleware/validateWebhook.js Shared-secret check + payload schema validation
services/upstoxService.js     Order placement against Upstox sandbox, with retry
services/supabaseService.js   All Supabase reads/writes
services/duplicateCheck.js    Idempotency (alert_id + time-window) logic
services/positionState.js     FLAT / IN_CALL / IN_PUT state machine helpers
services/instrumentResolver.js Auto-resolves the ATM instrument_token from price
utils/logger.js               pino logger
utils/retry.js                Generic exponential-backoff retry helper
scripts/find-instrument.js    Manual instrument_token lookup CLI (debugging/override)
sql/schema.sql                Supabase schema — run this first
```

## 1. Supabase schema

Run [sql/schema.sql](sql/schema.sql) once in the Supabase SQL editor (or via
`psql`). It creates:

- `webhook_log` — every incoming webhook, including rejected/duplicate ones
- `processed_alerts` — the idempotency ledger (`alert_id` is the primary key)
- `trades` — one row per position, entry → exit
- `position_state` — current FLAT/IN_CALL/IN_PUT state per symbol
- `app_config` — the `trading_enabled` kill switch (single row, `id = 1`)
- `set_position_state(...)` — a Postgres function that does the state
  compare-and-swap atomically (see the comment block above it in the SQL
  file for why this can't just be a JS read-then-write)

## 2. Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Notes |
|---|---|---|
| `PORT` | no (default 3000) | |
| `WEBHOOK_SECRET` | strongly recommended | TradingView sends this back as `?token=...` on the alert URL (TradingView alerts can't set custom headers) |
| `SUPABASE_URL` | yes | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | yes | **Service role** key, not the anon key — this server needs write access to every table |
| `UPSTOX_API_BASE_URL` | yes | `https://api-sandbox.upstox.com/v2` — confirmed by direct testing (Upstox's own docs don't state it plainly) |
| `UPSTOX_SANDBOX_ACCESS_TOKEN` | yes | Sandbox access token from Upstox developer console |
| `DEFAULT_INSTRUMENT_TOKEN` | no | Manual override fallback only — see note below |
| `DEFAULT_QUANTITY` | no | Fallback only |
| `DEFAULT_PRODUCT` | no (default `I`) | Upstox product code (`I` = intraday) |
| `DEFAULT_ORDER_TYPE` | no (default `MARKET`) | |
| `TRADING_ENABLED` | no (default `true`) | Fallback kill switch, used only if the Supabase `app_config` read fails |
| `DUPLICATE_WINDOW_SECONDS` | no (default 30) | Soft duplicate window |
| `UPSTOX_MAX_RETRIES` | no (default 2) | Retries on top of the first attempt |
| `UPSTOX_RETRY_BASE_DELAY_MS` | no (default 500) | Backoff base |
| `STRIKE_INTERVAL` | no (default 100) | Strike spacing used for ATM rounding (Bank Nifty = 100) |
| `INSTRUMENT_MASTER_CACHE_TTL_MS` | no (default 6h) | How long the instrument master is cached before refreshing |

**How `instrument_token` gets resolved:** the sample TradingView payload only
has `symbol` (e.g. `"BANKNIFTY"`) and `price` (the underlying's price), not a
specific option contract. On every entry signal where the payload doesn't
include an explicit `instrument_token`, `services/instrumentResolver.js`
auto-resolves it: it downloads (and caches, refreshing every
`INSTRUMENT_MASTER_CACHE_TTL_MS`) Upstox's public instrument master, rounds
`price` to the nearest `STRIKE_INTERVAL` to get the ATM strike, and picks the
soonest expiry that hasn't passed for that strike/CE-or-PE. This has been
tested end-to-end against the real Upstox sandbox and correctly places the
order against the resolved contract. Exits don't need this — they reuse the
`instrument_token` stored on the original entry's `trades` row, not
whatever's in the exit payload.

An explicit `instrument_token` in the payload still overrides auto-resolution
if you ever want to force a specific contract (e.g. a non-ATM strike, or for
testing). `DEFAULT_INSTRUMENT_TOKEN` is a lower-priority fallback below that.

For manual lookup/debugging, `scripts/find-instrument.js` does the same
instrument-master search standalone:
```bash
node scripts/find-instrument.js BANKNIFTY 63800 CE
```
Note: Bank Nifty options are **monthly only** now (NSE discontinued the
weekly Bank Nifty expiry) — confirmed directly against the instrument
master. Current `lot_size` for BANKNIFTY is 30 (also confirmed from the
master — re-check periodically since exchanges do revise lot sizes; this
bridge does not auto-derive quantity, only the instrument_token).

## 3. Install and run

```bash
npm install
cp .env.example .env   # then fill in the values above
npm run dev             # nodemon, auto-restart on changes
# or
npm start                # plain node
```

Check it's up:

```bash
curl http://localhost:3000/health
```

## 4. Sample TradingView alert payload

Configure your Pine Script `alert()` / `alertcondition()` message as JSON,
e.g.:

```json
{
  "signal_type": "CALL_ENTRY",
  "symbol": "BANKNIFTY",
  "price": 63820,
  "score": 5,
  "timestamp": "{{timenow}}",
  "alert_id": "{{time}}-CALL_ENTRY",
  "quantity": 30,
  "product": "I",
  "order_type": "MARKET"
}
```

- `signal_type`: one of `CALL_ENTRY`, `CALL_EXIT`, `PUT_ENTRY`, `PUT_EXIT`
- `alert_id`: must be unique per distinct signal — bar time + signal type
  (as you described) is exactly right, e.g. `{{time}}-{{strategy.order.id}}`
  or built manually in Pine as `str.tostring(time) + "-CALL_ENTRY"`
- `instrument_token` is intentionally **not** sent — the bridge auto-resolves
  it from `price`. Only include it if you want to override auto-resolution.
- `quantity` / `product` / `order_type` are optional if you've set matching
  `DEFAULT_*` env vars, but pass them explicitly once trading real contracts

Set the alert webhook URL to:

```
https://your-server.example.com/webhook/tradingview?token=YOUR_WEBHOOK_SECRET
```

## 5. Test locally with curl

With the server running on port 3000 and `WEBHOOK_SECRET=test-secret` in `.env`:

```bash
# Entry signal — no instrument_token, the bridge resolves the ATM contract from "price"
curl -X POST "http://localhost:3000/webhook/tradingview?token=test-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "signal_type": "CALL_ENTRY",
    "symbol": "BANKNIFTY",
    "price": 63820,
    "score": 5,
    "timestamp": "2026-08-04T09:20:00Z",
    "alert_id": "1754210400-CALL_ENTRY",
    "quantity": 30
  }'

# Re-send the SAME alert_id — should come back as duplicate_skipped, no new order
curl -X POST "http://localhost:3000/webhook/tradingview?token=test-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "signal_type": "CALL_ENTRY",
    "symbol": "BANKNIFTY",
    "price": 63820,
    "score": 5,
    "timestamp": "2026-08-04T09:20:00Z",
    "alert_id": "1754210400-CALL_ENTRY",
    "quantity": 30
  }'

# Exit signal (different alert_id) — uses the instrument_token stored on the entry, not this payload
curl -X POST "http://localhost:3000/webhook/tradingview?token=test-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "signal_type": "CALL_EXIT",
    "symbol": "BANKNIFTY",
    "price": 63950,
    "score": 1,
    "timestamp": "2026-08-04T10:05:00Z",
    "alert_id": "1754213100-CALL_EXIT"
  }'
```

To test the kill switch: `update app_config set trading_enabled = false where id = 1;`
in Supabase, then re-send an entry — it should respond `{"status":"trading_paused"}`
and the webhook_log row should show `reason = 'trading_disabled'`, with no
row written to `trades`.

## 6. What you still need to configure manually

- Create a Supabase project (if you don't have one) and run `sql/schema.sql`
- Generate an Upstox sandbox access token from the Upstox developer console
  and confirm the current sandbox base URL in their docs — set both in `.env`
- Pick a strong `WEBHOOK_SECRET` and put it in the TradingView alert URL's
  `?token=` query param
- Deploy the server somewhere TradingView can reach it over HTTPS (TradingView
  alerts cannot call `localhost`) — e.g. a small VPS, Render, Fly.io, etc.,
  with `NODE_ENV=production`
- Set `DEFAULT_QUANTITY` (or always send `quantity` in the alert) to match
  your intended lot size before going live
