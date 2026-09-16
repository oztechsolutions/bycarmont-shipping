import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import "dotenv/config";

// Adjust this import path if your route file lives somewhere other than
// app/routes/ — db.server.ts exports prisma as a default export.
import prisma from "../db.server";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type ShopifyRateRequest = {
  rate?: {
    currency?: string;
    origin?: ShopifyAddress;
    destination?: ShopifyAddress;
    items?: Array<{
      grams?: number;
      quantity?: number;
      name?: string;
      sku?: string;
      properties?: Record<string, string>;
    }>;
  };
};

type ShopifyAddress = {
  city?: string;
  province?: string;
  postal_code?: string;
  country?: string;
  address1?: string;
  address2?: string;
};

type ShippingRate = {
  service_name: string;
  service_code: string;
  description: string;
  total_price: string;
  currency: string;
};

type FastCourierQuote = {
  priceIncludingGst?: number | string;
  priceExcludingGst?: number | string;
  total_price?: number | string;
  price?: number | string;
  amount?: number | string;
  currency?: string;
  name?: string;
  courierName?: string;
  eta?: string;
  quote_id?: number | string;
  id?: string;
};

type FastCourierResponse = {
  status?: boolean;
  message?: string;
  data?: FastCourierQuote[] | { quotes?: FastCourierQuote[] };
  quotes?: FastCourierQuote[];
  rates?: FastCourierQuote[];
};

type ScoredQuote = {
  entry: FastCourierQuote;
  price: number;
  courierName: string;
  serviceName: string;
  eta: string;
};

// Everything we want to persist about a single rate request, built up as we
// go. Field names are provider-agnostic on purpose: whichever shipping
// source handles the request (Fast Courier, Smart Send, a future provider)
// writes into the same `provider*` fields.
type RateLogEntry = {
  shop?: string;
  requestId?: string;
  checkoutToken?: string;

  currency?: string;
  totalWeightGrams?: number;
  totalWeightKg?: number;
  itemCount?: number;

  destinationCountry?: string;
  destinationState?: string;
  destinationCity?: string;
  destinationPostcode?: string;

  requestJson?: string;
  itemsJson?: string;

  provider?: string;

  providerRequestJson?: string;
  providerResponseJson?: string;
  providerHttpStatus?: number;

  totalQuoteCount?: number;
  quoteBreakdownJson?: string;

  returnedRatesJson?: string;
  returnedRateCount?: number;

  status: "success" | "empty" | "error";
  errorMessage?: string;

  durationMs?: number;
};

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const FAST_DELIVERY_WEIGHT_LIMIT_GRAMS = 30_000;
const FAST_COURIER_QUOTES_URL = "https://enterprise-api.fastcourier.com.au/api/quotes";

// How many quotes we try to hand back to Shopify in total, and how many of
// those we prefer from each of the couriers below.
const TARGET_TOTAL_QUOTES = 4;
const PER_COURIER_TARGET = 2;

// Match against courierName.toLowerCase() with .includes(), so "Aramex" and
// "Couriers Please" both match regardless of the exact service name Fast
// Courier appends (e.g. "Aramex Road Express ATL" still matches "aramex").
const PREFERRED_COURIER_KEYWORDS = ["aramex", "couriers please"];

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function toUpper(value?: string) {
  return value?.trim().toUpperCase() ?? "";
}

function safeJson(data: unknown): string | undefined {
  try {
    return JSON.stringify(data);
  } catch {
    return undefined;
  }
}

/** Never let a logging failure break the actual shipping-rate response. */
async function saveRateLog(entry: RateLogEntry) {
  try {
    await prisma.shippingRateLog.create({ data: entry });
  } catch (err) {
    console.error("Failed to write ShippingRateLog:", err);
  }
}

/** Groups scored quotes by courier name and counts each group, e.g. { "Aramex": 4, "Couriers Please": 2 }. */
function buildQuoteBreakdown(quotes: ScoredQuote[]): Record<string, number> {
  return quotes.reduce<Record<string, number>>((counts, quote) => {
    const key = quote.courierName || "Unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

/**
 * Picks up to `perCourierTarget` cheapest quotes from each courier in
 * `preferredKeywords` (matched via courierName.toLowerCase().includes(...)),
 * in the order the keywords are given. If that doesn't reach `total` — e.g.
 * one preferred courier returned no quotes at all — backfills with the
 * next-cheapest quotes from ANY courier (preferred or not) until `total` is
 * reached or quotes run out. If none of the preferred couriers appear at
 * all, this naturally falls back to plain cheapest-first across everyone.
 */
function selectPreferredCouriersWithBackfill(
  quotes: ScoredQuote[],
  total: number,
  perCourierTarget: number,
  preferredKeywords: string[],
): ScoredQuote[] {
  const remaining = [...quotes];
  const selected: ScoredQuote[] = [];

  const takeMatching = (predicate: (quote: ScoredQuote) => boolean, limit: number) => {
    const matches = remaining.filter(predicate).sort((a, b) => a.price - b.price).slice(0, limit);

    for (const match of matches) {
      const index = remaining.indexOf(match);
      if (index !== -1) remaining.splice(index, 1);
    }

    selected.push(...matches);
  };

  for (const keyword of preferredKeywords) {
    takeMatching((quote) => quote.courierName.toLowerCase().includes(keyword), perCourierTarget);
  }

  if (selected.length < total) {
    takeMatching(() => true, total - selected.length);
  }

  return selected.sort((a, b) => a.price - b.price).slice(0, total);
}

/*
Fast Courier quote request shape (reference — do NOT put real secrets in comments):
POST https://enterprise-api.fastcourier.com.au/api/quotes
Header: Secret-Key: <FAST_COURIER_SECRET_KEY from env>
Body: {
  pickupSuburb, pickupState, pickupPostcode, pickupBuildingType, isPickupTailLift,
  destinationSuburb, destinationState, destinationPostcode, destinationBuildingType,
  isDropOffTailLift, isDropOffPOBox,
  items: [{ type, weight, length, width, height, quantity, contents }]
}
*/

/* ------------------------------------------------------------------ */
/* Fast Courier integration                                            */
/* ------------------------------------------------------------------ */

async function getFastDeliveryRates(
  currency: string,
  rate: NonNullable<ShopifyRateRequest["rate"]>,
  log: RateLogEntry,
): Promise<ShippingRate[]> {
  log.provider = "fast-courier";

  const secretKey = process.env.FAST_COURIER_SECRET_KEY;
  if (!secretKey) {
    log.status = "error";
    log.errorMessage = "FAST_COURIER_SECRET_KEY is not set";
    return [];
  }

  const destination = rate.destination ?? {};

  const destinationPostcodeRaw = Number(destination.postal_code);
  const destinationPostcode = Number.isFinite(destinationPostcodeRaw)
    ? destinationPostcodeRaw
    : undefined;

  if (destinationPostcode === undefined) {
    log.status = "error";
    log.errorMessage = "Missing/invalid destination postcode";
    return [];
  }

  if (!destination.city || !destination.province || !destination.country) {
    log.status = "error";
    log.errorMessage = "Incomplete destination address";
    return [];
  }

  if (!rate.items?.length) {
    log.status = "error";
    log.errorMessage = "No cart items on the rate request";
    return [];
  }

  const postBody = {
    pickupSuburb: toUpper(process.env.FAST_COURIER_PICKUP_SUBURB ?? "BRONTE"),
    pickupState: toUpper(process.env.FAST_COURIER_PICKUP_STATE ?? "NSW"),
    pickupPostcode: envNumber("FAST_COURIER_PICKUP_POSTCODE", 2024),
    pickupBuildingType: process.env.FAST_COURIER_PICKUP_BUILDING_TYPE ?? "residential",
    isPickupTailLift: false,

    destinationSuburb: toUpper(destination.city),
    destinationState: toUpper(destination.province),
    destinationPostcode,
    destinationBuildingType:
      process.env.FAST_COURIER_DESTINATION_BUILDING_TYPE ?? "residential",
    isDropOffTailLift: false,
    isDropOffPOBox: false,

    items: rate.items.map((item) => ({
      type: process.env.FAST_COURIER_DEFAULT_TYPE ?? "roll",
      weight: (item.grams ?? 0) / 1000,
      length: envNumber("FAST_COURIER_DEFAULT_LENGTH_CM", 30),
      width: envNumber("FAST_COURIER_DEFAULT_WIDTH_CM", 20),
      height: envNumber("FAST_COURIER_DEFAULT_HEIGHT_CM", 15),
      quantity: item.quantity ?? 1,
      contents: "Other",
    })),
  };

  log.providerRequestJson = safeJson(postBody);

  let response: Response;
  try {
    response = await fetch(FAST_COURIER_QUOTES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Secret-Key": secretKey,
      },
      body: JSON.stringify(postBody),
    });
  } catch (err) {
    log.status = "error";
    log.errorMessage = `Fast Courier request failed: ${
      err instanceof Error ? err.message : String(err)
    }`;
    return [];
  }

  log.providerHttpStatus = response.status;

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "<unreadable body>");
    log.status = "error";
    log.errorMessage = `Fast Courier returned HTTP ${response.status}`;
    log.providerResponseJson = bodyText;
    return [];
  }

  let result: FastCourierResponse;
  const rawBodyText = await response.text();
  log.providerResponseJson = rawBodyText;

  try {
    result = JSON.parse(rawBodyText) as FastCourierResponse;
  } catch (err) {
    log.status = "error";
    log.errorMessage = `Fast Courier returned invalid JSON: ${
      err instanceof Error ? err.message : String(err)
    }`;
    return [];
  }

  const quotes: FastCourierQuote[] = Array.isArray(result.data)
    ? result.data
    : result.data?.quotes ?? result.quotes ?? result.rates ?? [];

  if (!quotes.length) {
    log.status = "empty";
    log.errorMessage = result.message ?? "Fast Courier returned no shipping quotes";
    return [];
  }

  // Convert to a simpler internal structure, dropping anything with a bad price.
  const validQuotes: ScoredQuote[] = quotes
    .map((entry) => {
      const price = Number(
        entry.priceIncludingGst ?? entry.price ?? entry.amount ?? entry.total_price,
      );

      if (!Number.isFinite(price) || price < 0) {
        return null;
      }

      return {
        entry,
        price,
        courierName: entry.courierName?.trim() || "",
        serviceName: entry.name?.trim() || "",
        eta: entry.eta?.trim() || "",
      };
    })
    .filter((quote): quote is ScoredQuote => quote !== null);

  log.totalQuoteCount = validQuotes.length;
  log.quoteBreakdownJson = safeJson(buildQuoteBreakdown(validQuotes));

  // 2 cheapest Aramex + 2 cheapest Couriers Please; if either is missing or
  // short, backfill with the next-cheapest quotes from any courier so we
  // still return up to 4 total.
  const selectedQuotes = selectPreferredCouriersWithBackfill(
    validQuotes,
    TARGET_TOTAL_QUOTES,
    PER_COURIER_TARGET,
    PREFERRED_COURIER_KEYWORDS,
  );

  log.status = "success";

  return selectedQuotes.map(({ entry, price, courierName, serviceName, eta }) => {
    const description = [courierName, serviceName, eta].filter(Boolean).join(" · ");

    return {
      service_name: serviceName || courierName || "Fast courier shipping",
      service_code: `fast-courier-${entry.quote_id ?? entry.id ?? `${courierName}-${serviceName}`}`,
      description: description || "Fast Courier shipping",
      total_price: String(Math.round(price * 100)),
      currency: entry.currency || currency,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Fallback for heavy shipments                                        */
/* ------------------------------------------------------------------ */

async function getSmartSendShippingRate(
  currency: string,
  log: RateLogEntry,
): Promise<ShippingRate[]> {
  log.provider = "smart-send";

  const rates: ShippingRate[] = [
    {
      service_name: "Smart Send shipping",
      service_code: "smart-send-shipping",
      description: "Smart Send shipping rate",
      total_price: "5000",
      currency,
    },
    {
      service_name: "Smart Send shipping1",
      service_code: "smart-send-shipping1",
      description: "Smart Send shipping rate",
      total_price: "9000",
      currency,
    },
  ];

  // Smart Send is currently a static fallback (no external call), so the
  // generic provider fields are simple — but if this becomes a real API
  // call later, populate providerRequestJson / providerResponseJson /
  // providerHttpStatus / totalQuoteCount / quoteBreakdownJson exactly the
  // same way getFastDeliveryRates does, and this row will look consistent
  // with Fast Courier rows in the log table.
  log.totalQuoteCount = rates.length;
  log.status = "success";

  return rates;
}

/* ------------------------------------------------------------------ */
/* Loader — this route only ever does work on POST (the `action`).     */
/* Shopify calls this endpoint with POST, but browsers, uptime checks, */
/* or someone opening the URL directly will send GET. Without a       */
/* loader, React Router has no handler for GET and throws. This just  */
/* returns a harmless response instead of crashing.                    */
/* ------------------------------------------------------------------ */

export async function loader({ request }: LoaderFunctionArgs) {
  return Response.json(
    { message: "This endpoint accepts POST requests only." },
    { status: 405 },
  );
}

/* ------------------------------------------------------------------ */
/* Route action                                                        */
/* ------------------------------------------------------------------ */

export async function action({ request }: ActionFunctionArgs) {
  const startedAt = Date.now();

  const log: RateLogEntry = {
    shop: request.headers.get("x-shopify-shop-domain") ?? undefined,
    requestId: request.headers.get("x-request-id") ?? undefined,
    status: "error", // overwritten below once we know the outcome
  };

  try {
    const body = (await request.json()) as ShopifyRateRequest;
    const rateRequest = body.rate;
    const currency = rateRequest?.currency;

    log.requestJson = safeJson(body);
    log.currency = currency;
    log.checkoutToken = (body as { rate?: { checkout_token?: string } }).rate
      ?.checkout_token as string | undefined;

    if (!rateRequest || !currency) {
      log.errorMessage = !rateRequest
        ? "No rate object on request body"
        : "No currency on rate request";
      await saveRateLog({ ...log, durationMs: Date.now() - startedAt });
      return Response.json({ rates: [] });
    }

    const destination = rateRequest.destination ?? {};
    log.destinationCountry = destination.country;
    log.destinationState = destination.province;
    log.destinationCity = destination.city;
    log.destinationPostcode = destination.postal_code;

    log.itemsJson = safeJson(rateRequest.items ?? []);
    log.itemCount = rateRequest.items?.length ?? 0;

    const totalWeightGrams = (rateRequest.items ?? []).reduce(
      (total, item) => total + (item.grams ?? 0) * (item.quantity ?? 1),
      0,
    );
    log.totalWeightGrams = totalWeightGrams;
    log.totalWeightKg = totalWeightGrams / 1000;

    const rates =
      totalWeightGrams < FAST_DELIVERY_WEIGHT_LIMIT_GRAMS
        ? await getFastDeliveryRates(currency, rateRequest, log)
        : await getSmartSendShippingRate(currency, log);

    log.returnedRatesJson = safeJson(rates);
    log.returnedRateCount = rates.length;
    log.durationMs = Date.now() - startedAt;

    await saveRateLog(log);

    return Response.json({ rates });
  } catch (err) {
    log.status = "error";
    log.errorMessage = err instanceof Error ? err.stack ?? err.message : String(err);
    log.durationMs = Date.now() - startedAt;

    await saveRateLog(log);

    // Return an empty rate list rather than letting the request 500 —
    // a 500 is likely what's been triggering Shopify's static fallback rate.
    return Response.json({ rates: [] });
  }
}