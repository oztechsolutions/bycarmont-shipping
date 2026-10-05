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
      variant_id?: number | string;
      title?: string;
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

type ShopifyRateItem = NonNullable<ShopifyRateRequest["rate"]>["items"] extends
  | (infer Item)[]
  | undefined
  ? Item
  : never;

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
  orderId?: string;
  data?: FastCourierQuote[] | { quotes?: FastCourierQuote[] };
  quotes?: FastCourierQuote[];
  rates?: FastCourierQuote[];
};

// Row shape from the VariantPackage table (see app/routes/app.variant-packages.tsx
// for the admin UI that maintains this table). weightKg/length/width/height are
// Decimal columns in Postgres, so Prisma may hand them back as Decimal objects
// rather than plain numbers — always coerce with Number(...) before using them.
type VariantPackageRecord = Awaited<
  ReturnType<typeof prisma.variantPackage.findMany>
>[number];

// Provider-agnostic "scored quote" shape used for selecting/ranking quotes
// once a provider's response has been normalized. `entry` carries whatever
// raw record the provider returned, so we can still pull provider-specific
// fields (ids, etc.) back out after selection.
type ScoredQuote<T = unknown> = {
  entry: T;
  price: number;
  courierName: string;
  serviceName: string;
  eta: string;
};

// Resolved per-item package attributes used to build a courier request,
// after merging (in priority order) the saved VariantPackage row, the
// Shopify cart item itself (grams), and hard-coded env-var fallbacks.
type ResolvedPackage = {
  packageType: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
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

const FAST_DELIVERY_WEIGHT_LIMIT_GRAMS = envNumber("FAST_DELIVERY_WEIGHT_LIMIT_GRAMS", 30_000);
const FAST_COURIER_QUOTES_URL = process.env.FAST_COURIER_BASE_URL + process.env.FAST_COURIER_QUOTES_PATH || "https://enterprise-api.fastcourier.com.au/api/quotes";

// How many quotes we try to hand back to Shopify in total, and how many of
// those we prefer from each of the couriers below.
const TARGET_TOTAL_QUOTES = envNumber("TARGET_TOTAL_QUOTES", 4);
const PER_COURIER_TARGET = envNumber("PER_COURIER_TARGET", 2);

// Match against courierName.toLowerCase() with .includes(), so "Aramex" and
// "Couriers Please" both match regardless of the exact service name Fast
// Courier appends (e.g. "Aramex Road Express ATL" still matches "aramex").
const PREFERRED_COURIER_KEYWORDS = ["aramex", "couriers please"];

// Fallback dimensions/type used ONLY when a cart item's variant has no row
// in VariantPackage yet (e.g. it was never filled in on the admin page).
const FAST_COURIER_DEFAULT_TYPE = process.env.FAST_COURIER_DEFAULT_TYPE ?? "roll";
const FAST_COURIER_DEFAULT_LENGTH_CM = envNumber("FAST_COURIER_DEFAULT_LENGTH_CM", 30);
const FAST_COURIER_DEFAULT_WIDTH_CM = envNumber("FAST_COURIER_DEFAULT_WIDTH_CM", 20);
const FAST_COURIER_DEFAULT_HEIGHT_CM = envNumber("FAST_COURIER_DEFAULT_HEIGHT_CM", 15);

// Fast Courier's `items[].type` field expects packaging-type tokens.
// Confirm the exact accepted strings against Fast Courier's API docs — this
// maps the labels used on the Variant Packages admin page
// (PACKAGE_TYPE_OPTIONS in app/routes/app.variant-packages.tsx) onto
// reasonable Fast Courier equivalents, and lower-cases anything unmapped.
const FAST_COURIER_TYPE_BY_PACKAGE_TYPE: Record<string, string> = {
  "Carton": "carton",
  "Satchel/Bag": "satchel",
  "Tube": "tube",
  "Skid": "skid",
  "Pallet": "pallet",
  "Crate": "crate",
  "Flat Pack": "flat pack",
  "Roll": "roll",
  "Length": "length",
  "Tyre/Wheel": "tyre",
  "Envelope": "envelope",
};

// --- Smart Send (SOAP) ------------------------------------------------
const SMARTSEND_COURIER_QUOTES_URL =
  process.env.SMARTSEND_COURIER_QUOTES_URL || "https://developer.smartsend.com.au/service.asmx";
const SMARTSEND_VIP_USERNAME = process.env.SMARTSEND_VIP_USERNAME ?? "";
const SMARTSEND_VIP_PASSWORD = process.env.SMARTSEND_VIP_PASSWORD ?? "";

// Smart Send's item schema (Description/Depth/Height/Length/Weight) has no
// quantity field, so we expand each Shopify line item into `quantity`
// repeated <Item> blocks rather than passing quantity through directly.
// These are only used as a fallback when the variant has no VariantPackage
// row in Postgres.
const SMARTSEND_DEFAULT_TYPE = process.env.SMARTSEND_COURIER_DEFAULT_TYPE ?? "roll";
// NB (pre-existing naming quirk, kept as-is): this reads the *_WIDTH_CM env
// var but backs the SOAP request's <Depth> element — our "width" column is
// what gets sent as Depth. <Height> and <Length> map onto Depth/Height/
// Length 1:1 with their own names.
const SMARTSEND_DEFAULT_DEPTH_CM = envNumber("SMARTSEND_COURIER_DEFAULT_WIDTH_CM", 20);
const SMARTSEND_DEFAULT_HEIGHT_CM = envNumber("SMARTSEND_COURIER_DEFAULT_HEIGHT_CM", 15);
const SMARTSEND_DEFAULT_LENGTH_CM = envNumber("SMARTSEND_COURIER_DEFAULT_LENGTH_CM", 30);
// Previously this was hard-coded to a flat 50kg in the SOAP body regardless
// of the item — that was almost certainly a placeholder left in by mistake.
// It's now only used when neither the VariantPackage row nor the Shopify
// cart item (grams) has a usable weight.
const SMARTSEND_DEFAULT_WEIGHT_KG = envNumber("SMARTSEND_COURIER_DEFAULT_WEIGHT_KG", 1);
const SMARTSEND_DEFAULT_QUANTITY = envNumber("SMARTSEND_COURIER_DEFAULT_QUANTITY", 1);
const SMARTSEND_TAIL_LIFT = process.env.SMARTSEND_TAILLIFT ?? "";

// How many Smart Send quotes to return. Falls back to the shared
// TARGET_TOTAL_QUOTES unless a Smart Send-specific override is set.
const SMARTSEND_TARGET_TOTAL_QUOTES = envNumber("SMARTSEND_TARGET_TOTAL_QUOTES", TARGET_TOTAL_QUOTES);

const INCHES_TO_CM = 2.54;

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
function buildQuoteBreakdown(quotes: Array<{ courierName: string }>): Record<string, number> {
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
function selectPreferredCouriersWithBackfill<T>(
  quotes: ScoredQuote<T>[],
  total: number,
  perCourierTarget: number,
  preferredKeywords: string[],
): ScoredQuote<T>[] {
  const remaining = [...quotes];
  const selected: ScoredQuote<T>[] = [];

  const takeMatching = (predicate: (quote: ScoredQuote<T>) => boolean, limit: number) => {
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

/** Cheapest-first selection with no courier preference — used for Smart Send. */
function selectCheapest<T>(quotes: ScoredQuote<T>[], total: number): ScoredQuote<T>[] {
  return [...quotes].sort((a, b) => a.price - b.price).slice(0, total);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Pulls the text content of the first `<tag>...</tag>` inside `xmlBlock`, if present. */
function extractXmlTag(xmlBlock: string, tag: string): string | undefined {
  const match = xmlBlock.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXmlEntities(match[1].trim()) : undefined;
}

/** Shopify's carrier-service `variant_id` is already a bare numeric id (matching
 *  how VariantPackage.variantId is stored) — this just normalizes it to a string
 *  and guards against it being missing. */
function toNumericVariantId(variantId: number | string | undefined | null): string {
  if (variantId === undefined || variantId === null || variantId === "") return "";
  return String(variantId);
}

function toCm(value: number, unit: string | null | undefined): number {
  return unit === "INCHES" ? value * INCHES_TO_CM : value;
}

function mapPackageTypeToFastCourierType(packageType: string | undefined | null): string | undefined {
  const trimmed = packageType?.trim();
  if (!trimmed) return undefined;
  return FAST_COURIER_TYPE_BY_PACKAGE_TYPE[trimmed] ?? trimmed.toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Variant Package (Postgres) lookups                                  */
/* ------------------------------------------------------------------ */

/**
 * Fetches saved package rows (weight/dimensions/type) for a batch of
 * variants in a single query, scoped to `shop`. This is the same table the
 * "Variant Packages" admin page (app/routes/app.variant-packages.tsx)
 * reads/writes, so whatever a merchant fills in there is what carrier
 * quoting will use.
 *
 * Returns a Map keyed by the bare numeric variant id. If a variant somehow
 * has more than one saved row, the most recently updated one wins (the
 * query is ordered asc, so later rows overwrite earlier ones in the map) —
 * mirrors the same dedupe logic used on the admin page.
 */
async function fetchVariantPackagesForShop(
  shop: string,
  numericVariantIds: string[],
): Promise<Map<string, VariantPackageRecord>> {
  const map = new Map<string, VariantPackageRecord>();

  const ids = [...new Set(numericVariantIds.filter(Boolean))];
  if (ids.length === 0) return map;

  const rows = await prisma.variantPackage.findMany({
    where: {
      shop,
      variantId: { in: ids },
    },
    orderBy: {
      updatedAt: "asc",
    },
  });

  for (const row of rows) {
    map.set(row.variantId, row);
  }

  return map;
}

/**
 * Merges (in priority order) a saved VariantPackage row, the Shopify cart
 * item itself, and hard env-var fallbacks into one set of package
 * attributes to send to a courier.
 *
 * `preferDbWeight` controls whether the saved VariantPackage.weightKg wins
 * over the Shopify cart item's `grams` when both are present:
 *  - Fast Courier previously always used Shopify's `grams`, so it stays
 *    weight-from-Shopify-first (preferDbWeight: false) — only dimensions
 *    and package type are now sourced from Postgres for that provider.
 *  - Smart Send previously had no real per-item weight at all (a hard-coded
 *    50kg placeholder), so for Smart Send the saved DB weight is preferred
 *    when present (preferDbWeight: true).
 */
function resolveItemPackage(
  item: ShopifyRateItem,
  pkg: VariantPackageRecord | undefined,
  defaults: {
    type: string;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    weightKg: number;
  },
  options: { preferDbWeight?: boolean } = {},
): ResolvedPackage {
  const preferDbWeight = options.preferDbWeight ?? true;

  const dbLength = pkg?.length != null ? Number(pkg.length) : undefined;
  const dbWidth = pkg?.width != null ? Number(pkg.width) : undefined;
  const dbHeight = pkg?.height != null ? Number(pkg.height) : undefined;
  const dbWeight = pkg?.weightKg != null ? Number(pkg.weightKg) : undefined;
  const unit = pkg?.unit;

  const itemWeightKg =
    item.grams !== undefined && item.grams !== null && item.grams > 0
      ? item.grams / 1000
      : undefined;

  const weightKg = preferDbWeight
    ? (Number.isFinite(dbWeight as number) ? (dbWeight as number) : undefined) ?? itemWeightKg ?? defaults.weightKg
    : itemWeightKg ?? (Number.isFinite(dbWeight as number) ? (dbWeight as number) : undefined) ?? defaults.weightKg;

  return {
    packageType: pkg?.packageType?.trim() || defaults.type,
    lengthCm: dbLength !== undefined && Number.isFinite(dbLength) ? toCm(dbLength, unit) : defaults.lengthCm,
    widthCm: dbWidth !== undefined && Number.isFinite(dbWidth) ? toCm(dbWidth, unit) : defaults.widthCm,
    heightCm: dbHeight !== undefined && Number.isFinite(dbHeight) ? toCm(dbHeight, unit) : defaults.heightCm,
    weightKg,
  };
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

  // Look up saved dimensions/package type for every item's variant in one
  // query. If we don't know the shop (header missing) we just fall back to
  // the env-var defaults below rather than failing the whole quote.
  const numericVariantIds = rate.items.map((item) => toNumericVariantId(item.variant_id));
  const packagesByVariantId = log.shop
    ? await fetchVariantPackagesForShop(log.shop, numericVariantIds)
    : new Map<string, VariantPackageRecord>();

  const fastCourierDefaults = {
    type: FAST_COURIER_DEFAULT_TYPE,
    lengthCm: FAST_COURIER_DEFAULT_LENGTH_CM,
    widthCm: FAST_COURIER_DEFAULT_WIDTH_CM,
    heightCm: FAST_COURIER_DEFAULT_HEIGHT_CM,
    weightKg: 0,
  };

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

    items: rate.items.map((item) => {
      const numericVariantId = toNumericVariantId(item.variant_id);
      const pkg = packagesByVariantId.get(numericVariantId);

      // Fast Courier keeps using Shopify's own `grams` for weight (as
      // before) — only dimensions and packaging type come from Postgres.
      const resolved = resolveItemPackage(item, pkg, fastCourierDefaults, {
        preferDbWeight: false,
      });

      return {
        type: mapPackageTypeToFastCourierType(pkg?.packageType) ?? fastCourierDefaults.type,
        weight: resolved.weightKg,
        length: resolved.lengthCm,
        width: resolved.widthCm,
        height: resolved.heightCm,
        quantity: item.quantity ?? 1,
        contents: "Other",
      };
    }),
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


  // Fast Courier's own order id for this quote request. We need to thread
  // this through to the order webhook later (via service_code), since
  // nothing else in the Shopify rate-request/order flow carries it for us.
  const fastCourierOrderId = result.orderId;

  if (!fastCourierOrderId) {
    log.status = "error";
    log.errorMessage = "Fast Courier response missing orderId";
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
  const validQuotes: ScoredQuote<FastCourierQuote>[] = quotes
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
    .filter((quote): quote is ScoredQuote<FastCourierQuote> => quote !== null);

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

    // BUG FIX: Fast Courier's save-order-details endpoint needs the quote's
    // alphanumeric string `id` (e.g. "EQZWYVALDO"), NOT the numeric
    // `quote_id` (e.g. 18711508). Sending the numeric one fails with
    // "The selected quote is invalid or does not exist." The old code
    // preferred `quote_id` first; `id` now comes first.
    const quoteId = entry.id ?? entry.quote_id ?? `${courierName}-${serviceName}`;

    return {
      service_name: "(FC)" + serviceName || courierName || "Fast courier shipping",
      service_code: `fast-courier:${fastCourierOrderId}:${quoteId}`,
      description: description || "Fast Courier shipping",
      total_price: String(Math.round(price * 100)),
      currency: entry.currency || currency,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Smart Send integration (SOAP 1.2 / .asmx)                           */
/* ------------------------------------------------------------------ */

type SmartSendQuote = {
  priceId?: string;
  courierName: string;
  serviceName: string;
  transitDescription: string;
  totalPrice: number;
};

/**
 * Determines the SmartSend "Item Type" (packaging) from the product title.
 * Only used as a last-resort fallback now, when the variant has no saved
 * VariantPackage.packageType in Postgres. Falls back to SMARTSEND_DEFAULT_TYPE
 * if nothing matches.
 */
function getSmartSendItemType(title: string | undefined | null): string {
  const t = (title ?? "").toLowerCase();

  if (/\brugs?\b/.test(t) || /\bdoor ?mats?\b/.test(t)) return "Roll";
  if (/\bbags?\b/.test(t) || /\bottomans?\b/.test(t)) return "Carton";
  if (/\bplace ?mats?\b/.test(t)) return "Satchel";

  return SMARTSEND_DEFAULT_TYPE;
}

/**
 * Builds the <Items> block for the ObtainQuote SOAP request. Each Shopify
 * line item is expanded into `quantity` repeated <Item> elements.
 * Description/Depth/Height/Length/Weight are all now sourced from the
 * matching VariantPackage row when one exists, falling back to the
 * SMARTSEND_DEFAULT_* constants (and a title-based guess for the type)
 * when it doesn't.
 */
function buildSmartSendItemsXml(
  items: NonNullable<ShopifyRateRequest["rate"]>["items"],
  packagesByVariantId: Map<string, VariantPackageRecord>,
): string {
  const lines: string[] = [];

  const smartSendDefaults = {
    type: SMARTSEND_DEFAULT_TYPE,
    lengthCm: SMARTSEND_DEFAULT_LENGTH_CM,
    widthCm: SMARTSEND_DEFAULT_DEPTH_CM,
    heightCm: SMARTSEND_DEFAULT_HEIGHT_CM,
    weightKg: SMARTSEND_DEFAULT_WEIGHT_KG,
  };

  for (const item of items ?? []) {
    const quantity =
      item.quantity && item.quantity > 0
        ? item.quantity
        : SMARTSEND_DEFAULT_QUANTITY;

    const numericVariantId = toNumericVariantId(item.variant_id);
    const pkg = packagesByVariantId.get(numericVariantId);

    // Smart Send never had a real per-item weight before (it was a
    // hard-coded 50kg placeholder) so the saved DB weight — or Shopify's
    // grams as a secondary fallback — is preferred here.
    const resolved = resolveItemPackage(item, pkg, smartSendDefaults, {
      preferDbWeight: true,
    });

    const itemType = pkg?.packageType?.trim() || getSmartSendItemType(item.title);

    for (let i = 0; i < quantity; i += 1) {
      lines.push(
        `<Item>` +
          `<Description>${escapeXml(itemType)}</Description>` +
          `<Depth>${resolved.widthCm}</Depth>` +
          `<Height>${resolved.heightCm}</Height>` +
          `<Length>${resolved.lengthCm}</Length>` +
          `<Weight>${resolved.weightKg}</Weight>` +
          `</Item>`,
      );
    }
  }

  return lines.join("");
}

async function buildSmartSendRequestXml(
  shop: string,
  rate: NonNullable<ShopifyRateRequest["rate"]>,
): Promise<string> {
  const destination = rate.destination ?? {};

  const numericVariantIds = (rate.items ?? []).map((item) => toNumericVariantId(item.variant_id));
  const packagesByVariantId = await fetchVariantPackagesForShop(shop, numericVariantIds);
  const itemsXml = buildSmartSendItemsXml(rate.items, packagesByVariantId);

  const pickupSuburb = toUpper(process.env.SMARTSEND_COURIER_PICKUP_SUBURB ?? "BRONTE");
  const pickupState = toUpper(process.env.SMARTSEND_COURIER_PICKUP_STATE ?? "NSW");
  const pickupPostcode = envNumber("SMARTSEND_COURIER_PICKUP_POSTCODE", 2024);

  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
    `<soap12:Body>` +
    `<ObtainQuote xmlns="http://developer.smartsend.com.au/">` +
    `<request>` +
    `<TailLift>${escapeXml(SMARTSEND_TAIL_LIFT || "BOTH")}</TailLift>` +
    `<TransportAssurance>0</TransportAssurance>` +
    `<VIPUsername>${escapeXml(SMARTSEND_VIP_USERNAME)}</VIPUsername>` +
    `<VIPPassword>${escapeXml(SMARTSEND_VIP_PASSWORD)}</VIPPassword>` +
    `<PostcodeFrom>${pickupPostcode}</PostcodeFrom>` +
    `<PostcodeTo>${escapeXml(String(destination.postal_code ?? ""))}</PostcodeTo>` +
    `<SuburbFrom>${escapeXml(pickupSuburb)}</SuburbFrom>` +
    `<SuburbTo>${escapeXml(toUpper(destination.city))}</SuburbTo>` +
    `<StateFrom>${escapeXml(pickupState)}</StateFrom>` +
    `<StateTo>${escapeXml(toUpper(destination.province))}</StateTo>` +
    `<UserType></UserType>` +
    `<OnlineSellerID></OnlineSellerID>` +
    `<PromotionalCode></PromotionalCode>` +
    `<ReceiptedDelivery>false</ReceiptedDelivery>` +
    `<Items>${itemsXml}</Items>` +
    `<CallSrc>Shopify</CallSrc>` +
    `<CallVer>1.0</CallVer>` +
    `</request>` +
    `</ObtainQuote>` +
    `</soap12:Body>` +
    `</soap12:Envelope>`
  );
}

/** Extracts every <Quote>...</Quote> block from the SOAP response body and parses its fields. */
function parseSmartSendQuotesXml(xml: string): SmartSendQuote[] {
  const quoteBlocks = xml.match(/<Quote>[\s\S]*?<\/Quote>/g) ?? [];

  return quoteBlocks
    .map((block): SmartSendQuote | null => {
      const totalPriceRaw = extractXmlTag(block, "TotalPrice");
      const totalPrice = Number(totalPriceRaw);

      if (!Number.isFinite(totalPrice) || totalPrice < 0) {
        return null;
      }

      return {
        priceId: extractXmlTag(block, "PriceID"),
        courierName: extractXmlTag(block, "CourierName") ?? "",
        serviceName: extractXmlTag(block, "ServiceName") ?? "",
        transitDescription: extractXmlTag(block, "TransitDescription") ?? "",
        totalPrice,
      };
    })
    .filter((quote): quote is SmartSendQuote => quote !== null);
}

async function getSmartSendShippingRate(
  currency: string,
  rate: NonNullable<ShopifyRateRequest["rate"]>,
  log: RateLogEntry,
  shop: string,
): Promise<ShippingRate[]> {
  log.provider = "smart-send";

  if (!SMARTSEND_VIP_USERNAME || !SMARTSEND_VIP_PASSWORD) {
    log.status = "error";
    log.errorMessage = "SMARTSEND_VIP_USERNAME / SMARTSEND_VIP_PASSWORD is not set";
    return [];
  }

  const destination = rate.destination ?? {};

  if (!destination.city || !destination.province || !destination.postal_code) {
    log.status = "error";
    log.errorMessage = "Incomplete destination address";
    return [];
  }

  if (!rate.items?.length) {
    log.status = "error";
    log.errorMessage = "No cart items on the rate request";
    return [];
  }

  const requestXml = await buildSmartSendRequestXml(shop, rate);
  log.providerRequestJson = requestXml;

  let response: Response;
  try {
    response = await fetch(SMARTSEND_COURIER_QUOTES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/soap+xml; charset=utf-8",
      },
      body: requestXml,
    });
  } catch (err) {
    log.status = "error";
    log.errorMessage = `Smart Send request failed: ${
      err instanceof Error ? err.message : String(err)
    }`;
    return [];
  }

  log.providerHttpStatus = response.status;

  const rawBodyText = await response.text();
  log.providerResponseJson = rawBodyText;

  if (!response.ok) {
    log.status = "error";
    log.errorMessage = `Smart Send returned HTTP ${response.status}`;
    return [];
  }

  if (/<soap(?:12)?:Fault>/i.test(rawBodyText)) {
    log.status = "error";
    log.errorMessage =
      extractXmlTag(rawBodyText, "faultstring") ?? "Smart Send returned a SOAP fault";
    return [];
  }

  const statusCode = extractXmlTag(rawBodyText, "StatusCode");
  const quotes = parseSmartSendQuotesXml(rawBodyText);

  if (statusCode !== undefined && statusCode !== "0") {
    log.status = "error";
    log.errorMessage =
      extractXmlTag(rawBodyText, "StatusMessages") ?? `Smart Send returned StatusCode ${statusCode}`;
    return [];
  }

  if (!quotes.length) {
    log.status = "empty";
    log.errorMessage = "Smart Send returned no shipping quotes";
    return [];
  }

  const scoredQuotes: ScoredQuote<SmartSendQuote>[] = quotes.map((quote) => ({
    entry: quote,
    price: quote.totalPrice,
    courierName: quote.courierName,
    serviceName: quote.serviceName,
    eta: quote.transitDescription,
  }));

  log.totalQuoteCount = scoredQuotes.length;
  log.quoteBreakdownJson = safeJson(buildQuoteBreakdown(scoredQuotes));

  // No preferred-courier logic for Smart Send (unlike Fast Courier) — just
  // hand back the cheapest few. Adjust with selectPreferredCouriersWithBackfill
  // if Smart Send should favor specific couriers later.
  const selectedQuotes = selectCheapest(scoredQuotes, SMARTSEND_TARGET_TOTAL_QUOTES);

  log.status = "success";

  return selectedQuotes.map(({ entry, price, courierName, serviceName, eta }) => {
    const description = [courierName, serviceName, eta].filter(Boolean).join(" · ");

    return {
      service_name: "(SS)" + serviceName || courierName || "Smart Send shipping",
      service_code: `smart-send-${entry.priceId ?? `${courierName}-${serviceName}`}`,
      description: description || "Smart Send shipping",
      total_price: String(Math.round(price * 100)),
      currency,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Fallback for when no provider returned usable quotes                */
/* ------------------------------------------------------------------ */

function getManualFallbackRates(totalWeightGrams: number, currency = "AUD"): ShippingRate[] {
  const weightKg = totalWeightGrams / 1000;

  if (weightKg >= 200) {
    return [
      {
        service_name: "Bulk Order – Freight To Be Confirmed",
        service_code: "bulk-freight-confirm",
        description: "200-99,999kg",
        total_price: "0",
        currency,
      },
    ];
  }

  if (weightKg <= 1) {
    return [
      {
        service_name: "Standard",
        service_code: "standard-0-1kg",
        description: "0-1kg • 2–8 business days",
        total_price: "1200",
        currency,
      },
    ];
  }

  if (weightKg <= 5) {
    return [
      {
        service_name: "Standard",
        service_code: "standard-1-5kg",
        description: "1-5kg • 2–8 business days",
        total_price: "2500",
        currency,
      },
    ];
  }

  if (weightKg <= 15) {
    return [
      {
        service_name: "Standard",
        service_code: "standard-5-15kg",
        description: "5-15kg • 2–8 business days",
        total_price: "5500",
        currency,
      },
    ];
  }

  if (weightKg <= 20) {
    return [
      {
        service_name: "Standard",
        service_code: "standard-15-20kg",
        description: "15-20kg • 2–8 business days",
        total_price: "10000",
        currency,
      },
    ];
  }

  return [
    {
      service_name: "Standard",
      service_code: "standard-20-200kg",
      description: "20-200kg • 2–8 business days",
      total_price: "15000",
      currency,
    },
  ];
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

    //const useFastCourier = totalWeightGrams < FAST_DELIVERY_WEIGHT_LIMIT_GRAMS;
    // Weight rule applies to domestic (AU) only; international always uses Fast Courier
    const isDomestic = toUpper(destination.country) === "AU";
    const useFastCourier = !isDomestic || totalWeightGrams < FAST_DELIVERY_WEIGHT_LIMIT_GRAMS;

    let rates: ShippingRate[];

    try {
      if (useFastCourier) {
        rates = await getFastDeliveryRates(currency, rateRequest, log);
      } else if (!log.shop) {
        // We need the shop to look up saved VariantPackage rows for Smart
        // Send's dimensions/weight.
        log.status = "error";
        log.errorMessage =
          "Missing x-shopify-shop-domain header; cannot look up saved package dimensions for Smart Send";
        rates = [];
      } else {
        rates = await getSmartSendShippingRate(currency, rateRequest, log, log.shop);
      }
    } catch (error) {
      console.error("Carrier API failed:", error);
      log.status = "error";
      log.errorMessage = error instanceof Error ? error.message : String(error);
      rates = [];
    }

    const finalRates =
      rates.length > 0 ? rates : getManualFallbackRates(totalWeightGrams, currency);

    log.returnedRatesJson = safeJson(finalRates);
    log.returnedRateCount = finalRates.length;
    log.durationMs = Date.now() - startedAt;

    await saveRateLog(log);

    return Response.json({ rates: finalRates });
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