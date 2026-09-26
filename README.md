# Shopify Shipping Rate Service

A custom Shopify [carrier service](https://shopify.dev/docs/apps/build/shipping/carrier-services) endpoint that calculates live shipping rates at checkout by calling two courier providers (Fast Courier and Smart Send), with a built-in flat-rate fallback so checkout never breaks if a provider is unavailable.

## Overview

Shopify calls this endpoint every time a customer reaches the shipping step at checkout, passing along the cart's weight, item list, and destination address. The endpoint:

1. Picks a courier provider based on total order weight
2. Requests live quotes from that provider
3. Filters/ranks the quotes it gets back
4. Falls back to a flat-rate price table if no live quotes are available
5. Logs the full request/response for every call
6. Returns a list of shipping options back to Shopify

See [Algorithm](#algorithm) and [Architecture](#architecture) below for details.

## Tech stack

| Layer | Technology |
|---|---|
| Framework | React Router (Remix-style route module: `loader` / `action`) |
| Language | TypeScript |
| Database / ORM | Prisma (`ShippingRateLog` model) |
| Courier A — light parcels | [Fast Courier](https://fastcourier.com.au) REST API (JSON) |
| Courier B — bulk/freight | [Smart Send](https://smartsend.com.au) SOAP 1.2 API (XML) |
| Config | `dotenv` (`.env` file locally) |

> This route is one endpoint inside a larger Shopify app project — it assumes an existing `db.server.ts` that exports a configured Prisma client as its default export, and an existing `ShippingRateLog` model in the Prisma schema.

## Environment variables

### Required

| Variable | Description |
|---|---|
| `FAST_COURIER_SECRET_KEY` | API secret key for Fast Courier. Without this, the Fast Courier path fails and falls back to flat rates. |
| `SMARTSEND_VIP_USERNAME` | Smart Send VIP account username. |
| `SMARTSEND_VIP_PASSWORD` | Smart Send VIP account password. |

### Optional — behaviour tuning

| Variable | Default | Description |
|---|---|---|
| `FAST_DELIVERY_WEIGHT_LIMIT_GRAMS` | `30000` (30kg) | Orders under this weight use Fast Courier; at/above it, Smart Send is used instead. |
| `TARGET_TOTAL_QUOTES` | `4` | Max number of Fast Courier quotes returned to the customer. |
| `PER_COURIER_TARGET` | `2` | Max quotes taken from each preferred courier (Aramex, Couriers Please) before backfilling with any other courier. |
| `SMARTSEND_TARGET_TOTAL_QUOTES` | value of `TARGET_TOTAL_QUOTES` | Max number of Smart Send quotes returned. |

### Optional — pickup address (used by both providers)

| Variable | Default |
|---|---|
| `FAST_COURIER_PICKUP_SUBURB` | `BRONTE` |
| `FAST_COURIER_PICKUP_STATE` | `NSW` |
| `FAST_COURIER_PICKUP_POSTCODE` | `2024` |
| `FAST_COURIER_PICKUP_BUILDING_TYPE` | `residential` |
| `FAST_COURIER_DESTINATION_BUILDING_TYPE` | `residential` |
| `SMARTSEND_COURIER_PICKUP_SUBURB` | `BRONTE` |
| `SMARTSEND_COURIER_PICKUP_STATE` | `NSW` |
| `SMARTSEND_COURIER_PICKUP_POSTCODE` | `2024` |

### Optional — parcel dimensions (used when Shopify doesn't provide real package dimensions)

| Variable | Default | Used by |
|---|---|---|
| `FAST_COURIER_DEFAULT_TYPE` | `roll` | Fast Courier |
| `FAST_COURIER_DEFAULT_LENGTH_CM` | `30` | Fast Courier |
| `FAST_COURIER_DEFAULT_WIDTH_CM` | `20` | Fast Courier |
| `FAST_COURIER_DEFAULT_HEIGHT_CM` | `15` | Fast Courier |
| `SMARTSEND_COURIER_DEFAULT_TYPE` | `roll` | Smart Send |
| `SMARTSEND_COURIER_DEFAULT_WIDTH_CM` | `20` | Smart Send (maps to `Depth`) |
| `SMARTSEND_COURIER_DEFAULT_HEIGHT_CM` | `15` | Smart Send |
| `SMARTSEND_COURIER_DEFAULT_LENGTH_CM` | `30` | Smart Send |
| `SMARTSEND_COURIER_DEFAULT_QUANTITY` | `1` | Smart Send (fallback if a line item has no quantity) |
| `SMARTSEND_TAILLIFT` | *(unused currently — reserved)* | Smart Send |

### Optional — provider URLs (override for testing/staging)

| Variable | Default |
|---|---|
| `FAST_COURIER_QUOTES_URL` | `https://enterprise-api.fastcourier.com.au/api/quotes` |
| `SMARTSEND_COURIER_QUOTES_URL` | `https://developer.smartsend.com.au/service.asmx` |

### Example `.env`

```bash
# Fast Courier
FAST_COURIER_SECRET_KEY=your-fast-courier-secret

# Smart Send
SMARTSEND_VIP_USERNAME=your-vip-username
SMARTSEND_VIP_PASSWORD=your-vip-password

# Optional overrides
FAST_DELIVERY_WEIGHT_LIMIT_GRAMS=30000
TARGET_TOTAL_QUOTES=4
PER_COURIER_TARGET=2

# Pickup address
FAST_COURIER_PICKUP_SUBURB=BRONTE
FAST_COURIER_PICKUP_STATE=NSW
FAST_COURIER_PICKUP_POSTCODE=2024
```

Set the same variables in your hosting provider's environment/secrets dashboard for staging and production (values will differ from local — production should use production API keys, not sandbox/test ones if the providers offer them).

## How to run locally

1. **Install dependencies** (from the project root):
   ```bash
   npm install
   ```
2. **Create a `.env` file** in the project root using the example above, filling in real Fast Courier and Smart Send credentials (ask the client/provider for sandbox credentials if available, to avoid hitting live pricing during testing).
3. **Set up the database** (if not already done):
   ```bash
   npx prisma generate
   npx prisma migrate dev
   ```
4. **Start the dev server**:

   ### Local Development

    ```shell
    shopify app dev
    shopify app dev --store YOUR-NEW-STORE.myshopify.com
    ```


5. **Test the endpoint directly** with a sample Shopify-style payload:
   ```bash
   curl -X POST http://localhost:3000/path/to/this/route \
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
   A `GET` request to the same URL returns a `405` — this route is POST-only, matching what Shopify's carrier service calls with.
6. **Point Shopify at it**: register the endpoint as a [carrier service](https://shopify.dev/docs/api/admin-rest/latest/resources/carrierservice) in the store's admin (or via the Admin API), using a publicly reachable URL (e.g. an ngrok tunnel while developing locally).

## Algorithm

1. Shopify sends cart weight, item list, and destination address.
2. Total order weight is calculated by summing `grams × quantity` across all items.
3. **Weight decides the provider:**
   - Under `FAST_DELIVERY_WEIGHT_LIMIT_GRAMS` (default 30kg) → **Fast Courier**
   - At or above that limit → **Smart Send**
4. The chosen provider is called with the shop's pickup address, the destination, and per-item weight/dimensions.
5. **If quotes come back:**
   - Fast Courier: up to 2 cheapest quotes each from Aramex and Couriers Please are preferred; if either courier is missing or short, the gap is backfilled with the next-cheapest quotes from any courier, up to 4 total.
   - Smart Send: simply the cheapest quotes, up to the configured total.
6. **If no quotes come back** (provider error, timeout, empty response, missing config, or an unhandled exception) — a flat-rate fallback table is used instead, banded by total weight (0–1kg, 1–5kg, 5–15kg, 15–20kg, 20–200kg, 200kg+ "confirm freight manually").
7. Every call — request, raw provider response, chosen rates, and any error — is written to the `ShippingRateLog` table. A logging failure never blocks the response to Shopify.
8. The final list of rates is returned as JSON in Shopify's expected `{ rates: [...] }` shape.

## Architecture

```
Shopify checkout
      │  POST cart weight + destination
      ▼
action() [route entrypoint]
      │
      ├─ parse & validate request body
      ├─ calculate total weight
      │
      ▼
  weight < limit? ──yes──► getFastDeliveryRates()  ──► Fast Courier REST API (JSON)
      │
      no
      │
      ▼
  getSmartSendShippingRate() ──► Smart Send SOAP API (XML)
      │
      ▼
  quotes returned? ──no──► getManualFallbackRates()  (static, weight-banded)
      │
     yes
      │
      ▼
  select/rank quotes (preferred couriers + cheapest, or cheapest-only for Smart Send)
      │
      ▼
  saveRateLog()  ──► Prisma → ShippingRateLog table
      │
      ▼
  Response.json({ rates: [...] })  ──► back to Shopify checkout
```

**Key design decisions:**
- **Never 500.** Every failure path (bad request, provider timeout, invalid JSON, SOAP fault) is caught and degrades to either an empty rate list or the flat-rate fallback, rather than throwing — Shopify's own static fallback rate is worse for the customer than either of these.
- **Provider-agnostic types.** Internal types (`ScoredQuote`, `RateLogEntry`) are written so a third courier could be added later without renaming fields across the codebase.
- **Full audit trail.** Every rate request — successful or not — is logged with the raw provider request/response, so pricing disputes or "why did the customer see that price" questions can be answered from the database.

## File reference

- `action()` — the route entrypoint Shopify's carrier service calls (POST only).
- `loader()` — returns a `405` for any non-POST request (browsers, uptime checks, etc.), so the route doesn't crash.
- `getFastDeliveryRates()` — Fast Courier integration (light parcels).
- `getSmartSendShippingRate()` — Smart Send integration (bulk/freight, SOAP/XML).
- `getManualFallbackRates()` — static flat-rate table, weight-banded.
- `selectPreferredCouriersWithBackfill()` — Fast Courier quote ranking logic.
- `selectCheapest()` — Smart Send quote ranking logic.
- `saveRateLog()` — writes every request to `ShippingRateLog`, swallowing any DB errors.



##Troubleshooting
