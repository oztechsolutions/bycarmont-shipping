# Bycarmont Shipping – Shopify Carrier Service App

A custom Shopify app that calculates **live shipping rates at checkout** using two courier providers (**Fast Courier** and **Smart Send**), with a **flat-rate fallback** so checkout never breaks if a provider is down.

> **Security:** Never commit `.env`, API keys, passwords, Shopify tokens or database URLs to Git. Production secrets live in **Railway → Variables** only.

---

## 1. Quick Links & Environments

| What | Where |
|---|---|
| **Dev store** (testing) | `byc-shipping-advanced.myshopify.com` |
| **Prod app** (Shopify Dev Dashboard) | https://dev.shopify.com/dashboard/184100839/apps/422694879233 |
| **Hosting / variables / Postgres** (Railway) | https://railway.com/project/ff1c3cc6-be7b-4b98-8512-dfd92d72be82/service/2e8b38e1-d3a5-43d7-8663-1ebb5c1968b5/variables?environmentId=e8cdc435-e075-4e37-ad75-bbaf15a559fc |
| **Prod app URL** | https://bycarmont-shipping-production.up.railway.app/ |
| **Source code** | GitHub repo (connected to Railway for auto-deploys) |

| Environment | How it runs | Config source |
|---|---|---|
| **Dev** | `shopify app dev --store byc-shipping-advanced.myshopify.com` (temporary tunnel URL) | local `.env` |
| **Prod** | Railway deploy from GitHub, installed via the Dev Dashboard app | Railway Variables |

---

## 2. How It Works (30-second version)

1. Customer reaches the shipping step at checkout.
2. Shopify POSTs cart weight, items and destination to our endpoint.
3. We add up total weight → pick a courier:
   - **Under 30 kg → Fast Courier** (REST/JSON)
   - **30 kg or more → Smart Send** (SOAP/XML)
4. We request live quotes, rank/filter them, and return them to Shopify.
5. If no quotes come back (error, timeout, empty, missing config) → **flat-rate fallback table** by weight.
6. Every request/response is logged to the `ShippingRateLog` table (a logging failure never blocks checkout).

**Golden rule: the endpoint never returns a 500.** All failures degrade to an empty list or the flat-rate fallback.

---

## 3. Architecture

```
Shopify checkout
      │  POST cart weight + destination
      ▼
action() [route entrypoint]
      │
      ├─ parse & validate request body
      ├─ calculate total weight (Σ grams × quantity)
      │
      ▼
  weight < FAST_DELIVERY_WEIGHT_LIMIT_GRAMS?
      │
      ├─ yes ──► getFastDeliveryRates()      ──► Fast Courier REST API (JSON)
      │
      └─ no  ──► getSmartSendShippingRate()  ──► Smart Send SOAP API (XML)
                          │
                          ▼
              quotes returned? ──no──► getManualFallbackRates() (static, weight-banded)
                          │
                         yes
                          ▼
              select / rank quotes
                (Fast Courier: preferred couriers + backfill
                 Smart Send:   cheapest only)
                          │
                          ▼
              saveRateLog() ──► Prisma → PostgreSQL (ShippingRateLog)
                          │
                          ▼
              Response.json({ rates: [...] }) ──► Shopify checkout
```

### Tech stack

| Layer | Technology |
|---|---|
| Framework | React Router (Remix-style `loader` / `action` route) |
| Language | TypeScript |
| Database / ORM | PostgreSQL (Railway) + Prisma (`ShippingRateLog` model) |
| Courier A – light parcels | Fast Courier REST API |
| Courier B – bulk/freight | Smart Send SOAP 1.2 API |
| Hosting | Railway (deploys from GitHub) |
| Config | `dotenv` locally, Railway Variables in prod |

> The rate route is one endpoint inside a larger Shopify app. It assumes an existing `db.server.ts` exporting a Prisma client as default, and a `ShippingRateLog` model in the Prisma schema.

---

## 4. Algorithm in Detail

1. **Weight:** total grams = Σ (`grams × quantity`) across items.
2. **Provider choice:** `< FAST_DELIVERY_WEIGHT_LIMIT_GRAMS` (default 30,000 g) → Fast Courier; otherwise → Smart Send.
3. **Fast Courier ranking:**
   - Take up to `PER_COURIER_TARGET` (2) cheapest quotes each from **Aramex** and **Couriers Please**.
   - If either is missing/short, backfill with the next-cheapest from any courier.
   - Cap at `TARGET_TOTAL_QUOTES` (4).
4. **Smart Send ranking:** cheapest quotes only, capped at `SMARTSEND_TARGET_TOTAL_QUOTES` (defaults to `TARGET_TOTAL_QUOTES`).
5. **Fallback (flat rate):** used when there are no live quotes. Banded by total weight: 0–1 kg, 1–5 kg, 5–15 kg, 15–20 kg, 20–200 kg, 200 kg+ ("confirm freight manually").
6. **Logging:** request, raw provider response, chosen rates and any error → `ShippingRateLog`.
7. **Response:** `{ rates: [...] }` in Shopify's expected format.

---

## 5. Setup

### 5.1 Local development

```bash
# 1. Install
npm install

# 2. Create .env in project root (see section 6 for variables)

# 3. Database
npx prisma generate
npx prisma migrate dev

# 4. Start against the dev store
shopify app dev --store byc-shipping-advanced.myshopify.com
```

`shopify app dev` creates a temporary tunnel URL and updates the app's URLs for the dev session. Use sandbox/test courier credentials where available so you don't hit live pricing.

### 5.2 Test the endpoint directly

```bash
curl -X POST https://<your-tunnel-or-prod-url>/<path-to-rate-route> \
  -H "Content-Type: application/json" \
  -d '{
    "rate": {
      "currency": "AUD",
      "destination": {
        "city": "Melbourne",
        "province": "VIC",
        "postal_code": "3000",
        "country": "AU"
      },
      "items": [
        { "grams": 1200, "quantity": 1, "name": "Sample product" }
      ]
    }
  }'
```

- Try `grams: 35000` to force the **Smart Send** path.
- A `GET` to the same URL returns **405** – the route is POST-only (this is normal).

### 5.3 Production (Railway)

1. Railway service is connected to the GitHub repo – **pushing to the deploy branch triggers a deploy**.
2. Set variables in **Railway → Project → Service → Variables** (section 6).
3. `DATABASE_URL` should reference the **Railway PostgreSQL service's generated variable**, not a pasted string.
4. Make sure migrations run on deploy (e.g. `npx prisma migrate deploy` in the start/release command).
5. Set `SHOPIFY_APP_URL` to the public Railway URL and make sure the same URL is configured in the app's settings in the Dev Dashboard.
6. Install/update the app on the store from the Dev Dashboard app page (section 1).

### 5.4 Register the carrier service in Shopify

The carrier service's **callback URL** must be the publicly reachable rate route (`<SHOPIFY_APP_URL>/<path-to-rate-route>`). Register it via the [Admin API](https://shopify.dev/docs/api/admin-rest/latest/resources/carrierservice) (or your app's setup code). For local dev, the callback must point to the current tunnel URL.

Then in **Shopify Admin → Settings → Shipping and delivery**, confirm the shipping profile/zone includes this carrier-calculated service.

---

## 6. Environment Variables

### 6.1 Required

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string used by Prisma (Railway generated var) |
| `FAST_COURIER_SECRET_KEY` | Fast Courier API secret. Missing → Fast path fails → flat-rate fallback |
| `SMARTSEND_VIP_USERNAME` | Smart Send VIP username |
| `SMARTSEND_VIP_PASSWORD` | Smart Send VIP password |
| `SHOPIFY_APP_URL` | Public URL of deployed app, e.g. `https://bycarmont-shipping-production.up.railway.app/` |
| `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | Shopify app credentials (from Dev Dashboard) |
| `SHOPIFY_ADMIN_TOKEN` | Shopify Admin API access token |
| `SHOPIFY_SHOP` / `SHOPIFY_STORE` | e.g. `byc-shipping-advanced` / `byc-shipping-advanced.myshopify.com` |
| `SHOPIFY_API_VERSION` | Admin API version, e.g. `2026-07` |

Optional Shopify: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` (only if the app code requires them).

### 6.2 Routing & quote selection

| Variable | Default | Description |
|---|---|---|
| `FAST_DELIVERY_WEIGHT_LIMIT_GRAMS` | `30000` | Below → Fast Courier; at/above → Smart Send |
| `TARGET_TOTAL_QUOTES` | `4` | Max Fast Courier quotes returned |
| `PER_COURIER_TARGET` | `2` | Max per preferred courier (Aramex, Couriers Please) before backfill |
| `SMARTSEND_TARGET_TOTAL_QUOTES` | = `TARGET_TOTAL_QUOTES` | Max Smart Send quotes returned |

### 6.3 Provider URLs (override for testing/staging)

| Variable | Default |
|---|---|
| `FAST_COURIER_QUOTES_URL` | `https://enterprise-api.fastcourier.com.au/api/quotes` |
| `SMARTSEND_COURIER_QUOTES_URL` | `https://developer.smartsend.com.au/service.asmx` |

### 6.4 Pickup address

| Variable | Default |
|---|---|
| `FAST_COURIER_PICKUP_SUBURB` / `_STATE` / `_POSTCODE` | `BRONTE` / `NSW` / `2024` |
| `FAST_COURIER_PICKUP_BUILDING_TYPE` | `residential` |
| `FAST_COURIER_DESTINATION_BUILDING_TYPE` | `residential` |
| `SMARTSEND_COURIER_PICKUP_SUBURB` / `_STATE` / `_POSTCODE` | `BRONTE` / `NSW` / `2024` |

### 6.5 Default parcel dimensions (used when Shopify doesn't send real dimensions)

| Variable | Default | Provider |
|---|---|---|
| `FAST_COURIER_DEFAULT_TYPE` | `roll` | Fast Courier |
| `FAST_COURIER_DEFAULT_LENGTH_CM` / `_WIDTH_CM` / `_HEIGHT_CM` | `30` / `20` / `15` | Fast Courier |
| `FAST_COURIER_DEFAULT_QUANTITY` | `1` | Fast Courier |
| `SMARTSEND_COURIER_DEFAULT_TYPE` | `roll` | Smart Send |
| `SMARTSEND_COURIER_DEFAULT_LENGTH_CM` / `_WIDTH_CM` / `_HEIGHT_CM` | `30` / `20` / `15` | Smart Send (width maps to `Depth`) |
| `SMARTSEND_COURIER_DEFAULT_QUANTITY` | `1` | Smart Send (fallback if line item has no quantity) |
| `SMARTSEND_TAILLIFT` | `BOTH` | Smart Send tail-lift setting (currently reserved/unused in code) |

### 6.6 Fast Courier pickup details (shipment creation)

`FAST_COURIER_PICKUP_FIRST_NAME`, `_LAST_NAME`, `_COMPANY`, `_EMAIL`, `_ADDRESS1`, `_ADDRESS2`, `_PHONE`, `_TIME_WINDOW`, `FAST_COURIER_DOCS_EMAIL`, `FAST_COURIER_DEFAULT_CONTENTS`, `FAST_COURIER_PICKUP_TAIL_LIFT`, `FAST_COURIER_DROPOFF_TAIL_LIFT`, `FAST_COURIER_DROPOFF_PO_BOX`.

### 6.7 Example local `.env` (placeholders only)

```bash
DATABASE_URL=postgresql://user:password@localhost:5432/byc_shipping

SHOPIFY_SHOP=byc-shipping-advanced
SHOPIFY_STORE=byc-shipping-advanced.myshopify.com
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...
SHOPIFY_API_VERSION=2026-07

FAST_COURIER_SECRET_KEY=...
SMARTSEND_VIP_USERNAME=...
SMARTSEND_VIP_PASSWORD=...

FAST_DELIVERY_WEIGHT_LIMIT_GRAMS=30000
TARGET_TOTAL_QUOTES=4
PER_COURIER_TARGET=2
```

---

## 7. Troubleshooting – Where to Look

### 7.1 First 3 checks for any problem

1. **`ShippingRateLog` table** – did Shopify even call us? What did the provider return? Any error saved?
2. **Railway → Deployments → Logs** – crashes, failed deploys, provider errors.
3. **Railway → Variables** – missing/wrong credentials or URLs.

Useful query (adjust column names to your Prisma schema):

```sql
SELECT * FROM "ShippingRateLog" ORDER BY "createdAt" DESC LIMIT 20;
```

Or browse it with `npx prisma studio` (local, pointing `DATABASE_URL` at the target DB).

### 7.2 Symptom → cause → where to look

| Symptom | Likely cause | Where to look / fix |
|---|---|---|
| **No shipping options at checkout at all** | Carrier service not registered, wrong callback URL, or app not installed | Shopify Admin → Shipping settings; re-check callback URL = `SHOPIFY_APP_URL` + route; confirm app installed (Dev Dashboard). Check whether a new row appears in `ShippingRateLog` when you hit checkout – if not, Shopify isn't reaching us |
| **Third-party/carrier-calculated rates unavailable** | Shopify plan doesn't support carrier-calculated shipping | Shopify Admin → Settings → Plan / Shipping; check store plan and shipping profile |
| **Only flat-rate prices shown (no live quotes)** | Provider failed and fallback kicked in | Latest `ShippingRateLog` row → error + raw response; verify `FAST_COURIER_SECRET_KEY` / `SMARTSEND_VIP_*`; check provider status |
| **Fast Courier returns nothing** | Bad/missing secret, wrong URL, invalid suburb/postcode, weight/dimension rejected | Log's raw Fast Courier response; `FAST_COURIER_QUOTES_URL`; pickup + default dimension vars |
| **Smart Send returns nothing / SOAP fault** | Wrong VIP credentials, invalid suburb/postcode combo, bad dimension type | Log's raw XML response; `SMARTSEND_VIP_*`; `SMARTSEND_COURIER_DEFAULT_TYPE`; `getSmartSendShippingRate()` |
| **Wrong provider used** | Weight threshold or item grams wrong | `FAST_DELIVERY_WEIGHT_LIMIT_GRAMS`; check product weights in Shopify (0 g items skew totals); weight = Σ grams × qty |
| **Wrong couriers shown / not enough quotes** | Ranking/backfill settings | `TARGET_TOTAL_QUOTES`, `PER_COURIER_TARGET`, `selectPreferredCouriersWithBackfill()` / `selectCheapest()` |
| **Prices look wrong** | Default dimensions used instead of real ones; wrong pickup address | `*_DEFAULT_*` vars; pickup vars; compare log request vs provider quote |
| **"Confirm freight manually" shown** | Order ≥ 200 kg fell into the last fallback band | Expected behaviour for very heavy orders; see `getManualFallbackRates()` |
| **Checkout slow / rates missing intermittently** | Provider slow; Shopify gives up on slow callbacks (~10 s) | Log timestamps and provider response times; Railway logs; provider timeout handling |
| **`GET` on the route gives 405** | Route is POST-only | Normal – test with `curl -X POST` |
| **Nothing appears in `ShippingRateLog`** | DB unreachable, migrations not run, or Shopify not calling us | Railway Postgres status; `DATABASE_URL`; run `npx prisma migrate deploy`; note `saveRateLog()` swallows DB errors by design – check Railway logs |
| **Dev works, prod doesn't** | Variables differ, or prod app URL/install is stale | Compare `.env` vs Railway Variables; check `SHOPIFY_APP_URL`; reinstall/update app from Dev Dashboard |
| **Dev store stops getting rates** | Tunnel URL changed after restarting `shopify app dev` | Re-run `shopify app dev --store byc-shipping-advanced.myshopify.com`; make sure the carrier service callback points to the new tunnel |
| **Railway deploy fails** | Build error, missing env vars, Prisma migration failure | Railway → Deployments → Build/Deploy logs |
| **Prisma errors (`P1001`, missing table)** | DB not reachable or migrations not applied | Check `DATABASE_URL`; `npx prisma generate` + `npx prisma migrate deploy` |
| **Shopify auth / 401 / 403 errors** | Wrong client ID/secret, expired token, missing scopes | Dev Dashboard app settings; `SHOPIFY_*` variables; reinstall app after scope changes |

### 7.3 Debug workflow

1. Reproduce with the `curl` payload in section 5.2 (change weight/destination to match the failing order).
2. Check the newest `ShippingRateLog` row: request → provider response → chosen rates → error.
3. If the provider response is empty/errored → credentials, URLs, address, dimensions.
4. If the provider is fine but rates are wrong → ranking/selection functions and env tuning.
5. If there's no log row → Shopify isn't calling us (registration, URL, install, plan).

---

## 8. Code Reference

| Function | Purpose |
|---|---|
| `action()` | Route entrypoint Shopify calls (POST only) |
| `loader()` | Returns 405 for non-POST requests so the route doesn't crash |
| `getFastDeliveryRates()` | Fast Courier integration (light parcels, REST/JSON) |
| `getSmartSendShippingRate()` | Smart Send integration (bulk/freight, SOAP/XML) |
| `getManualFallbackRates()` | Static, weight-banded flat-rate table |
| `selectPreferredCouriersWithBackfill()` | Fast Courier quote ranking |
| `selectCheapest()` | Smart Send quote ranking |
| `saveRateLog()` | Writes every request to `ShippingRateLog`, swallowing DB errors |

## 9. Design Principles

- **Never 500** – every failure path degrades to an empty list or flat rates; Shopify's own static fallback is worse for the customer.
- **Provider-agnostic types** (`ScoredQuote`, `RateLogEntry`) – a third courier can be added without renaming fields.
- **Full audit trail** – every rate request is logged with raw provider request/response, so "why did the customer see that price?" can be answered from the database.