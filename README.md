# Maktub — multi-network dashboard

One login, one dashboard, N manual MikroTik/Mikhmon networks (Maktub 1, Maktub 2, …).
No customer payments: users are synced from the routers. The only money flow is the
owner's dashboard subscription — **₦5,000 per network per month, billed on the 10th,
no grace period**.

- **Dashboard:** https://maktub.dreamhatcher.ink/
- **API:** https://zmolotveyvkplfrgrqqw.supabase.co/functions/v1/maktub
- **Supabase project:** `zmolotveyvkplfrgrqqw` (eu-west-1)
- **Squad account:** Dream Hatcher Tech (`78TR887Y`), `pass_charge:true`

## How it fits together

```
MikroTik (Maktub 1) ─┐  maktub-sync (2m)      ┌─> mikrotik_users
                     ├───────────────────────>│
MikroTik (Maktub 2) ─┘  x-api-key per network  └─> activity_log
                                                    │
                          dashboard (single login) ─┘
                          cards -> per-network stats/users/activity

MikroTik ── maktub-licence (1m) ──> /api/licence -> disable hotspot when unpaid
```

- One **tenant** row holds the licence (`paid_until`, `per_network_amount=₦5,000`).
- One **networks** row per router, each with its own hashed API key.
- One **admin** login for the owner.
- **Billing:** `amount = active networks × ₦5,000`, due on the **10th 00:00 WAT**.
  Adding a network changes the count; the next payment (on the 10th) is
  `N × ₦5,000` automatically.
- **Lockout (no grace):** `paid_until` passing makes `/api/networks` return 402,
  `/api/mikhmon-sync` return 403, and `/api/licence` return `active:false`.
  The router script disables the hotspot within one poll (≤1 min).
- Fail-safe: a cloud/network outage does **not** lock the router (`fail-open`).

## Adding a network

1. Run (once, from this folder, with the service role key):

   ```bash
   SUPABASE_SERVICE_ROLE_KEY=... node tools/add-network.js "Maktub 3" maktub-3
   ```

   Optional fourth argument overrides prices:
   `'{"24hr":200,"7d":800,"30d":3000}'`.

2. On the new router, install `mikrotik/maktub-sync.rsc` and
   `mikrotik/maktub-licence.rsc` with the printed key, then run
   `mikrotik/maktub-schedulers.rsc`.

3. The card appears on the next dashboard load — **no deploy, no new project,
   no new login**. Billing becomes ₦15,000 on the next 10th (count × ₦5,000).

Set the hotspot server name in `maktub-licence.rsc` (`/ip hotspot print`).

## Routes

| Method | Path | Auth |
|---|---|---|
| GET | `/health` | none |
| POST | `/api/login` | username/password |
| POST | `/api/logout` | session |
| POST | `/api/change-password` | session |
| GET | `/api/networks` | session |
| GET | `/api/network/:slug` | session |
| GET | `/api/network/:slug/users?page&status&search` | session |
| GET | `/api/network/:slug/activity` | session |
| POST | `/api/mikhmon-sync` | `x-api-key` (network) |
| GET | `/api/licence` | `x-api-key` (network) |
| GET | `/api/subscription/status` | none |
| POST | `/api/subscription/initiate` | none |
| POST | `/api/subscription-webhook` | HMAC-SHA512 |
| GET | `/subscription-callback` | Squad redirect |
| POST | `/api/subscription/reconcile` | `CRON_API_KEY` |

## Database

`tenant`, `networks`, `mikrotik_users`, `activity_log`, `admin_users`,
`admin_sessions`, `subscription_payments`. RLS is on; only the service role
(the edge function) touches them. Migration:
`supabase/migrations/20261104_maktub_core.sql`.

Cron:
- `maktub-expire` every minute → `maktub_expire_users()`
- `maktub-reconcile` every 5 minutes → verifies pending subscription checkouts

## Sync format

The router posts `text/plain` lines:

```
U|username|password|profile|mac|disabled|limit-uptime|uptime|comment
A|username            (an active session)
F|1                    (full snapshot; users no longer present become expired)
```

Rules: unused vouchers (never logged in, no expiry) are ignored; an expiry comes
from the Mikhmon comment timestamp, or `limit-uptime - uptime`; online = seen in
the last 3 minutes.

## Security

- Per-network API keys are stored only as SHA-256 hashes.
- Login uses PBKDF2-SHA256 (150k) with a random salt; sessions expire after 12 h
  (2 h idle).
- The service role key never reaches the browser; the dashboard only calls this
  function.
- `pass_charge:true` means the payer covers the Squad fee; Dream Hatcher receives
  the full ₦5,000 per network.

## Local helpers (not deployed)

`tools/add-network.js` needs `SUPABASE_SERVICE_ROLE_KEY`. Never commit `.env*`,
keys, or `.session`.
