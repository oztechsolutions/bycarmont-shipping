# BY Carmont Shipping App - Troubleshooting Runbook

## 1. Shopify Carrier Service / CCS Not Showing

If shipping rates are not appearing at checkout, first check whether the Carrier Calculated Shipping (CCS) service is registered correctly.

### Check registered Carrier Services

Use Shopify GraphiQL:

```graphql
query CheckCarrierServices {
  carrierServices(first: 10) {
    nodes {
      id
      name
      active
      callbackUrl
      supportsServiceDiscovery
    }
  }
}
```

### Expected result

Check that:

* `name` is the expected carrier service name, e.g. `CCS`
* `active` is `true`
* `callbackUrl` points to the **current application URL**
* `supportsServiceDiscovery` is correct
* The callback URL uses HTTPS
* The URL is publicly reachable

Example:

```json
{
  "data": {
    "carrierServices": {
      "nodes": [
        {
          "id": "gid://shopify/DeliveryCarrierService/109250281835",
          "name": "CCS",
          "active": true,
          "callbackUrl": "https://CURRENT-DOMAIN.example.com/api/shipping-rates",
          "supportsServiceDiscovery": true
        }
      ]
    }
  }
}
```

### If callbackUrl points to an old Cloudflare URL

For example:

```text
https://old-tunnel.trycloudflare.com/api/shipping-rates
```

while the current application is using a different URL.

The old callback URL will cause Shopify to send shipping requests to the wrong application.

**Fix:**

* Stop using the old carrier registration.
* Uninstall/reinstall the app if that is how the carrier service is recreated.
* Alternatively, update/re-register the carrier service using the current callback URL.
* Run the carrier registration script again if required.

---

# 2. Manually Register Carrier Service

If automatic registration fails, manually run the registration script.

Project:

```text
~/Public/bucklit/BYCARMOUNT/
```

Run:

```bash
node manualRegisterServices.js
```

After running it, verify the registration again using:

```graphql
query CheckCarrierServices {
  carrierServices(first: 10) {
    nodes {
      id
      name
      active
      callbackUrl
      supportsServiceDiscovery
    }
  }
}
```

Do not assume registration succeeded just because the script completed. **Always verify the returned Carrier Service.**

---

# 3. Check Shopify Delivery Profile

Even if the Carrier Service is registered correctly, Shopify may not call it for the checkout.

Check:

**Shopify Admin → Settings → Shipping and delivery**

Verify that:

* The relevant shipping profile exists.
* The correct products are assigned to the profile.
* The relevant shipping zone includes the customer's destination.
* The Carrier Service is enabled for that zone.
* The carrier-calculated rates are actually available in the selected shipping profile.

If the carrier service exists in GraphQL but Shopify never calls `/api/shipping-rates`, investigate the delivery profile before changing application code.

---

# 4. Check Carrier Calculated Shipping Eligibility

Verify that the Shopify store/plan and shipping configuration support the required carrier-calculated shipping functionality.

If the store is not eligible/configured correctly, the application can be working while Shopify still does not request rates.

---

# 5. Check the Shipping Callback URL Directly

Before debugging courier APIs, verify that Shopify can reach the application.

Current callback should look like:

```text
https://YOUR-DOMAIN/api/shipping-rates
```

Test the deployed endpoint independently.

Check:

* HTTPS works
* DNS works
* Application is running
* Route exists
* No authentication middleware is incorrectly blocking Shopify
* No Cloudflare tunnel has expired
* No firewall is blocking the request
* No proxy is returning 404/502/503
* Server responds within Shopify's expected timeframe

For local development, remember that a temporary Cloudflare tunnel URL can change.

---

# 6. Check Application / Shopify App Logs

When Shopify requests shipping rates, check the application logs immediately.

Look for:

```text
Shipping request received
```

Then check:

```text
Request payload
Weight
Dimensions
Origin postcode
Destination postcode
Selected shipping logic
Courier API started
Courier API response
Returned rate count
Total duration
```

The important question is:

> Did Shopify actually reach `/api/shipping-rates`?

### If there is NO log entry

The problem is likely before your application:

```text
Shopify
   ↓
Delivery Profile
   ↓
Carrier Service
   ↓
Callback URL
   ↓
Application
```

Check the carrier registration, delivery profile, callback URL and store configuration.

### If there IS a log entry

The problem is inside the application or an external API.

---

# 7. Check Shipping Request Payload

When a request arrives, verify:

```text
Origin postcode
Origin suburb
Origin state

Destination postcode
Destination suburb
Destination state

Total weight
Dimensions
Number of items
Currency
Country
```

Pay particular attention to:

* grams vs kilograms
* centimetres vs millimetres
* decimal vs integer values
* missing dimensions
* multiple packages
* zero/null weight
* invalid postcode
* incorrect suburb/state combinations

For example:

```text
Shopify weight: 30000 grams
Application weight: 30 kg
Courier API weight: 30 kg
```

Make sure the conversion happens exactly once.

---

# 8. FastCourier Troubleshooting

## Test independently in Postman

Use the appropriate FastCourier endpoint configured for the environment.

### Stage

```text
https://enterprise-api-stage.fastcourier.com.au/api/quotes
```

### Live

```text
https://enterprise-api.fastcourier.com.au/api/quotes
```

Use the API credentials stored in your environment variables/Postman environment.

**Do not store real API keys in this troubleshooting document.**

Test the same:

* Origin
* Destination
* Weight
* Dimensions
* Service requirements

that the Shopify application is sending.

---

# 9. Compare Postman vs Application Request

If Postman works but the application fails, compare the actual request.

Check:

```text
URL
HTTP method
Headers
Authorization
Content-Type
JSON/XML body
Weight
Dimensions
Postcodes
Authentication
Timeout
```

Log a sanitised request from the application so it can be compared with Postman.

Never log:

```text
API keys
Passwords
Access tokens
Shopify secrets
VIP passwords
```

---

# 10. Check External API Response

For each courier request, log:

```text
Courier
Request started
Request completed
HTTP status
Duration
Returned rate count
Error message
```

Example:

```text
FastCourier
Started: 10:31:02.100
Completed: 10:31:03.050
Status: 200
Duration: 950ms
Rates: 4
```

This is particularly important because Shopify shipping requests have a limited response window.

---

# 11. Shipping API Timeout

If Shopify is timing out, identify how long each external API takes.

Example:

```text
Shopify request
    ↓
FastCourier       1.2 sec
Smart Send        3.8 sec
Aramex            6.5 sec
Database          0.2 sec
Processing        0.1 sec
-------------------------
Total             11.8 sec
```

If courier requests are independent, investigate running them concurrently rather than sequentially.

For example:

```javascript
const results = await Promise.allSettled([
  getFastCourierRates(),
  getSmartSendRates(),
  getAramexRates(),
]);
```

A slow or failed courier should not unnecessarily prevent other valid rates from being returned.

Use per-courier timeouts so one external service cannot hold the Shopify request indefinitely.

---

# 12. Check Shipping Rate Selection Logic

Verify the weight/business rules.

For example:

```javascript
if (totalWeightGrams < FAST_DELIVERY_WEIGHT_LIMIT_GRAMS) {
  // FastCourier
} else {
  // Smart Send
}
```

Check:

* Correct threshold
* Correct units
* `<` vs `<=`
* Multiple item weights
* Total package weight
* Dimensions
* Multiple packages
* Fallback behaviour

For a boundary test, test:

```text
19.99 kg
20.00 kg
20.01 kg
```

if 20 kg is the configured threshold.

---

# 13. Check Courier Fallback Behaviour

If the primary courier returns no rates:

```text
Primary courier
       ↓
No rates
       ↓
Fallback courier
       ↓
Return available rates
```

Also handle:

```text
HTTP error
Timeout
Empty response
Invalid response
Malformed JSON
Authentication failure
```

A failed courier should be logged without necessarily causing the entire Shopify response to fail.

---

# 14. Check Returned Shopify Rates

Verify the final response sent back to Shopify contains valid rates.

For example:

```json
{
  "rates": [
    {
      "service_name": "Courier Service",
      "service_code": "courier-service",
      "total_price": "5000",
      "currency": "AUD",
      "description": "Courier delivery"
    }
  ]
}
```

Check:

* `service_name`
* `service_code`
* `total_price`
* `currency`
* Valid JSON
* Price is in the expected minor currency unit
* No `NaN`
* No `null` prices
* At least one valid rate when rates are available

---

# 15. Check Database / Prisma

If the request is slow, check whether database operations are blocking the shipping response.

Look for:

* Multiple unnecessary queries
* Prisma connection delays
* Queries inside loops
* Logging every courier response synchronously
* Large database writes before returning the Shopify response

If detailed logging is required, consider whether non-critical logging can happen after the response path or be handled asynchronously.

---

# 16. Check Environment Variables

A large number of shipping problems are caused by environment mismatches.

Verify:

```text
APP_URL
SHOPIFY_API_KEY
SHOPIFY_API_SECRET
SHOPIFY_API_VERSION
DATABASE_URL

SMARTSEND_ENDPOINT
SMARTSEND_USERNAME
SMARTSEND_PASSWORD

FASTCOURIER_ENDPOINT
FASTCOURIER_API_KEY
```

Check that the deployed application is using the intended:

```text
UAT
```

or:

```text
LIVE
```

endpoint.

Do not assume local `.env` values are the same as Railway/Render/production environment variables.

---

# 17. Check Shopify Dev App vs Production App

The Shopify development application and production application can have different:

* App URLs
* Client IDs
* Client secrets
* Redirect URLs
* Carrier Service registrations
* Webhooks
* Environment variables
* Installed stores

When testing:

```text
Shopify Dev App
        ↓
Install using current development URL
        ↓
Approve permissions
        ↓
Verify app installation
        ↓
Verify Carrier Service
        ↓
Verify callback URL
```

Do not assume registering the carrier in one app automatically registers it for another Shopify app.

---

# 18. Check App Installation

When installing the development app using a temporary URL:

1. Start the application.
2. Start the Cloudflare tunnel if required.
3. Confirm the current public URL.
4. Confirm the app's configured `APP_URL`.
5. Install/reinstall the development app.
6. Approve permissions.
7. Verify the Carrier Service callback URL.
8. Test checkout/shipping rates.

If the Cloudflare URL changes, repeat the carrier callback verification.

---

# 19. Check Webhooks / App Lifecycle

If the application depends on Shopify app installation/uninstallation events, verify:

* Webhooks are registered
* Webhook URL is current
* App reinstall creates the required carrier service
* Uninstall/reinstall does not leave an old carrier service behind
* Old carrier services are removed or disabled where appropriate

---

# 20. Check Logs for Failed Shipping Rates

For every shipping-rate request, record a correlation/request ID.

Example:

```text
Request ID: SHIP-20260923-001

Shopify request received
Weight: 30kg
From: 2024
To: 5038

FastCourier started
SmartSend started

FastCourier: 1,240ms / 4 rates
SmartSend: 2,100ms / 3 rates

Returned rates: 7
Total: 2,145ms
```

This makes it much easier to diagnose whether the problem is:

```text
Shopify
↓
Carrier Service
↓
Application
↓
Database
↓
Courier API
↓
Rate processing
↓
Shopify response
```

---

# 21. Quick Troubleshooting Order

When **shipping does not appear**, check in this order:

### Step 1

Check Shopify Delivery Profile.

### Step 2

Check Carrier Service registration:

```graphql
query CheckCarrierServices {
  carrierServices(first: 10) {
    nodes {
      id
      name
      active
      callbackUrl
      supportsServiceDiscovery
    }
  }
}
```

### Step 3

Check `callbackUrl`.

### Step 4

Check application is running and publicly reachable.

### Step 5

Check `/api/shipping-rates` application logs.

### Step 6

Check incoming Shopify request values.

### Step 7

Check courier API request.

### Step 8

Test courier API independently in Postman.

### Step 9

Check courier response and timing.

### Step 10

Check rate transformation.

### Step 11

Check final Shopify response.

### Step 12

Check total response time.

---

# 22. Quick Diagnosis Matrix

| Symptom                                    | First thing to check                    |
| ------------------------------------------ | --------------------------------------- |
| Shipping option completely missing         | Shopify Delivery Profile                |
| Carrier service missing                    | Carrier Service registration            |
| Carrier exists but callback is old         | Re-register/update Carrier Service      |
| No application log                         | Shopify → callback configuration        |
| Application receives request but no rates  | Shipping-rate logic                     |
| FastCourier fails                          | Postman + credentials + endpoint        |
| Smart Send fails                           | SOAP request + credentials + validation |
| One courier works, another fails           | Individual courier API                  |
| Rates arrive but Shopify doesn't show them | Shopify response format                 |
| Shopify times out                          | External API latency / sequential calls |
| Works locally but not deployed             | Environment variables / deployment      |
| Works in UAT but not live                  | Live credentials/endpoint/config        |
| Works in Postman but not app               | Compare exact request                   |
| Works in app but not checkout              | Shopify delivery profile/config         |
| Old Cloudflare URL appears                 | Carrier Service registration            |
| Rates change unexpectedly                  | Cache/rate calculation logic            |
| 20kg+ products fail                        | Weight threshold/business rule          |
| Multiple products give wrong price         | Total weight/package calculation        |
| App reinstall breaks shipping              | Carrier registration lifecycle          |

# 23. Emergency Checklist

If checkout suddenly stops showing shipping:

```text
[ ] Is the Shopify app running?
[ ] Is the public URL working?
[ ] Is the Cloudflare tunnel running?
[ ] Is callbackUrl current?
[ ] Is Carrier Service active?
[ ] Is the shipping profile configured?
[ ] Is the destination zone configured?
[ ] Is /api/shipping-rates receiving requests?
[ ] Is the request payload valid?
[ ] Is weight correct?
[ ] Are dimensions correct?
[ ] Are postcode/suburb/state combinations valid?
[ ] Are courier credentials valid?
[ ] Are courier endpoints correct?
[ ] Do courier APIs respond in Postman?
[ ] Are external calls timing out?
[ ] Are courier calls unnecessarily sequential?
[ ] Are valid rates being returned?
[ ] Is the Shopify response JSON valid?
[ ] Is the total response under the Shopify timeout?
```

## Security reminder

Never store real credentials in this troubleshooting document.

Use:

```text
SMARTSEND_USERNAME=<from environment>
SMARTSEND_PASSWORD=<from environment>
FASTCOURIER_API_KEY=<from environment>
SHOPIFY_API_SECRET=<from environment>
```

Rotate any credentials that have been pasted into chat, screenshots, Git commits, logs, or shared documentation.
