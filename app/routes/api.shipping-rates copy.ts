import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import "dotenv/config";

// Adjust this import path if your route file lives somewhere other than
// app/routes/ — db.server.ts exports prisma as a default export.
import prisma from "../db.server";

// Used to get an Admin API client for a shop OUTSIDE of an authenticated
// embedded-app request (this route is a public carrier-service callback
// that Shopify's checkout calls directly, so there's no App Bridge session
// here — we need the shop's stored offline session instead).
// Confirm this matches the actual export name/path in your shopify.server.ts.
import { unauthenticated } from "../shopify.server";

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

// Minimal shape of the Shopify Admin API client we need — just enough to
// call admin.graphql(...). Matches what unauthenticated.admin(shop) /
// authenticate.admin(request) return as `admin`.
type AdminApiContext = {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

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
const FAST_COURIER_QUOTES_URL = process.env.FAST_COURIER_QUOTES_URL || "https://enterprise-api.fastcourier.com.au/api/quotes";

// How many quotes we try to hand back to Shopify in total, and how many of
// those we prefer from each of the couriers below.
const TARGET_TOTAL_QUOTES = envNumber("TARGET_TOTAL_QUOTES", 4);
const PER_COURIER_TARGET = envNumber("PER_COURIER_TARGET", 2);

// Match against courierName.toLowerCase() with .includes(), so "Aramex" and
// "Couriers Please" both match regardless of the exact service name Fast
// Courier appends (e.g. "Aramex Road Express ATL" still matches "aramex").
const PREFERRED_COURIER_KEYWORDS = ["aramex", "couriers please"];

// --- Smart Send (SOAP) ------------------------------------------------
const SMARTSEND_COURIER_QUOTES_URL =
  process.env.SMARTSEND_COURIER_QUOTES_URL || "https://developer.smartsend.com.au/service.asmx";
const SMARTSEND_VIP_USERNAME = process.env.SMARTSEND_VIP_USERNAME ?? "";
const SMARTSEND_VIP_PASSWORD = process.env.SMARTSEND_VIP_PASSWORD ?? "";

// Smart Send's item schema (Description/Depth/Height/Length/Weight) has no
// quantity field, so we expand each Shopify line item into `quantity`
// repeated <Item> blocks rather than passing quantity through directly.
// Depth/Height/Length always use these fixed defaults now — only weight is
// pulled per-item from the Package metafield / inventory data.
const SMARTSEND_DEFAULT_TYPE = process.env.SMARTSEND_COURIER_DEFAULT_TYPE ?? "roll";
const SMARTSEND_DEFAULT_DEPTH_CM = envNumber("SMARTSEND_COURIER_DEFAULT_WIDTH_CM", 20);
const SMARTSEND_DEFAULT_HEIGHT_CM = envNumber("SMARTSEND_COURIER_DEFAULT_HEIGHT_CM", 15);
const SMARTSEND_DEFAULT_LENGTH_CM = envNumber("SMARTSEND_COURIER_DEFAULT_LENGTH_CM", 30);
const SMARTSEND_DEFAULT_QUANTITY = envNumber("SMARTSEND_COURIER_DEFAULT_QUANTITY", 1);
const SMARTSEND_TAIL_LIFT = process.env.SMARTSEND_TAILLIFT ?? "";

// How many Smart Send quotes to return. Falls back to the shared
// TARGET_TOTAL_QUOTES unless a Smart Send-specific override is set.
const SMARTSEND_TARGET_TOTAL_QUOTES = envNumber("SMARTSEND_TARGET_TOTAL_QUOTES", TARGET_TOTAL_QUOTES);

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
 * Fetches per-variant weight for a batch of variant IDs in a single
 * GraphQL call using `nodes`. Depth/Height/Length are no longer sourced
 * from the Package metafield — they use the fixed SMARTSEND_DEFAULT_*
 * constants instead, so this only needs to resolve weight.
 *
 * NOTE: Adjust the metafield `namespace`/`key` below to match your actual
 * Package metafield definition — inspect it in Shopify Admin under
 * Settings > Custom data > Variants, or query metafields(first: 20) once
 * to confirm. I'm guessing "custom" / "package" here.
 */
/*
async function fetchVariantPackages(
  admin: AdminApiContext,
  variantIds: string[], // full GIDs, e.g. "gid://shopify/ProductVariant/53843343180139"
): Promise<Map<string, { weight?: number }>> {
  const result = new Map<string, { weight?: number }>();

  if (variantIds.length === 0) return result;

  const query = `#graphql
    query getVariantPackages($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          inventoryItem {
            measurement {
              weight {
                value
                unit
              }
            }
          }
          metafield(namespace: "custom", key: "package") {
            reference {
              ... on Metaobject {
                fields {
                  key
                  value
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await admin.graphql(query, { variables: { ids: variantIds } });
  const { data } = await response.json();

  for (const node of data?.nodes ?? []) {
    if (!node?.id) continue;

    const packageFields = Object.fromEntries(
      node.metafield?.reference?.fields?.map((field: { key: string; value: string }) => [
        field.key,
        field.value,
      ]) ?? [],
    );

    // Prefer the metaobject's own weight field if present; else fall back
    // to Shopify's inventory item weight (converted to kg if needed).
    let weight = Number(packageFields.weight);
    if (!Number.isFinite(weight)) {
      const invWeight = node.inventoryItem?.measurement?.weight;
      if (invWeight?.value != null) {
        weight =
          invWeight.unit === "GRAMS"
            ? invWeight.value / 1000
            : invWeight.unit === "KILOGRAMS"
              ? invWeight.value
              : invWeight.unit === "POUNDS"
                ? invWeight.value * 0.453592
                : invWeight.unit === "OUNCES"
                  ? invWeight.value * 0.0283495
                  : NaN;
      }
    }

    result.set(node.id, {
      weight: Number.isFinite(weight) ? weight : undefined,
    });
  }

  return result;
}
*/
/**
 * Determines the SmartSend "Item Type" (packaging) from the product title.
 * Falls back to SMARTSEND_DEFAULT_TYPE if nothing matches.
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
 * line item is expanded into `quantity` repeated <Item> elements. Depth,
 * Height and Length always use the fixed SMARTSEND_DEFAULT_* constants —
 * only Weight is pulled per-item from the Package metafield / inventory
 * data.
 */
function buildSmartSendItemsXml(
  items: NonNullable<ShopifyRateRequest["rate"]>["items"]
): string {
  const lines: string[] = [];

  for (const item of items ?? []) {
    const quantity =
      item.quantity && item.quantity > 0
        ? item.quantity
        : SMARTSEND_DEFAULT_QUANTITY;

    //const variantGid = `gid://shopify/ProductVariant/${item.variant_id}`;
    ///const pkg = packagesByVariantId.get(variantGid);

    // if (!pkg || pkg.weight === undefined) {
    //   throw new Error(
    //     `No weight found for Shopify product: ${item.name ?? item.title ?? "Unknown product"}`,
    //   );
    // }

    const itemType = getSmartSendItemType(item.title);

    for (let i = 0; i < quantity; i += 1) {
      lines.push(
        `<Item>` +
          `<Description>${escapeXml(itemType)}</Description>` +
          `<Depth>${SMARTSEND_DEFAULT_DEPTH_CM}</Depth>` +
          `<Height>${SMARTSEND_DEFAULT_HEIGHT_CM}</Height>` +
          `<Length>${SMARTSEND_DEFAULT_LENGTH_CM}</Length>` +
          `<Weight>50</Weight>` +
          `</Item>`,
      );
    }
  }

  return lines.join("");
}

async function buildSmartSendRequestXml(
  admin: AdminApiContext,
  rate: NonNullable<ShopifyRateRequest["rate"]>,
): Promise<string> {
  // FIX: `destination` was referenced below but never defined in this
  // function's scope (only `rate` is a parameter) — derive it from `rate`
  // the same way getFastDeliveryRates does.
  const destination = rate.destination ?? {};

  const variantIds = (rate.items ?? []).map(
    (item) => `gid://shopify/ProductVariant/${item.variant_id}`,
  );

  //const packagesByVariantId = await fetchVariantPackages(admin, variantIds);
  const itemsXml = buildSmartSendItemsXml(rate.items);

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
  admin: AdminApiContext,
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

  const requestXml = await buildSmartSendRequestXml(admin, rate);
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
      service_name: serviceName || courierName || "Smart Send shipping",
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

    const useFastCourier = totalWeightGrams < FAST_DELIVERY_WEIGHT_LIMIT_GRAMS;

    let rates: ShippingRate[];

    try {
      if (useFastCourier) {
        rates = await getFastDeliveryRates(currency, rateRequest, log);
      } else if (!log.shop) {
        // Smart Send needs an Admin API client for the shop, which we can
        // only get if we know which shop this request is for.
        log.status = "error";
        log.errorMessage = "Missing x-shopify-shop-domain header; cannot resolve admin session for Smart Send";
        rates = [];
      } else {
        const { admin } = await unauthenticated.admin(log.shop);
        rates = await getSmartSendShippingRate(currency, rateRequest, log, admin);
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