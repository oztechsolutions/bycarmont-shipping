import type { ActionFunctionArgs } from "react-router";
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

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

const FAST_DELIVERY_WEIGHT_LIMIT_GRAMS = 30_000;
const FAST_COURIER_QUOTES_URL = "https://enterprise-api.fastcourier.com.au/api/quotes";

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

/* ---------------------------------------------------------------------- */
/* File logger — survives terminal scrollback loss / dev-server restarts  */
/* ---------------------------------------------------------------------- */

const LOG_FILE = process.env.SHIPPING_LOG_FILE ?? path.join(process.cwd(), "shipping-debug.log");

function logToFile(level: "INFO" | "ERROR", message: string, data?: unknown) {
  const line =
    `[${new Date().toISOString()}] [${level}] ${message}` +
    (data !== undefined ? ` ${safeStringify(data)}` : "") +
    "\n";
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    // If we can't even write the log file, fall back to console so we still see *something*.
    console.error("Failed to write shipping-debug.log:", err);
  }
  // Still mirror to console so `shopify app dev` output shows it when it IS working.
  if (level === "ERROR") {
    console.error(message, data ?? "");
  } else {
    console.log(message, data ?? "");
  }
}

function safeStringify(data: unknown) {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function toUpper(value?: string) {
  return value?.trim().toUpperCase() ?? "";
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
async function getFastDeliveryRates(
  currency: string,
  rate: NonNullable<ShopifyRateRequest["rate"]>,
): Promise<ShippingRate[]> {
  const secretKey = process.env.FAST_COURIER_SECRET_KEY;
  if (!secretKey) {
    logToFile("ERROR", "FAST_COURIER_SECRET_KEY is not set");
    return [];
  }

  const destination = rate.destination ?? {};
  const destinationPostcodeRaw = Number(destination.postal_code);
  const destinationPostcode = Number.isFinite(destinationPostcodeRaw) ? destinationPostcodeRaw : undefined;

  if (destinationPostcode === undefined) {
    logToFile("ERROR", "Missing/invalid destination postal_code — skipping Fast Courier quote", {
      destination,
    });
    return [];
  }

  const postBody = {
    pickupSuburb: toUpper(process.env.FAST_COURIER_PICKUP_SUBURB ?? "SYDNEY"),
    pickupState: toUpper(process.env.FAST_COURIER_PICKUP_STATE ?? "NSW"),
    pickupPostcode: envNumber("FAST_COURIER_PICKUP_POSTCODE", 2000),
    pickupBuildingType: process.env.FAST_COURIER_PICKUP_BUILDING_TYPE ?? "commercial",
    isPickupTailLift: false,
    destinationSuburb: toUpper(destination.city),
    destinationState: toUpper(destination.province),
    destinationPostcode,
    destinationBuildingType: process.env.FAST_COURIER_DESTINATION_BUILDING_TYPE ?? "residential",
    isDropOffTailLift: false,
    isDropOffPOBox: false,
    items: (rate.items ?? []).map((item) => ({
      type: "box",
      weight: (item.grams ?? 0) / 1000,
      length: envNumber("FAST_COURIER_DEFAULT_LENGTH_CM", 30),
      width: envNumber("FAST_COURIER_DEFAULT_WIDTH_CM", 20),
      height: envNumber("FAST_COURIER_DEFAULT_HEIGHT_CM", 15),
      quantity: item.quantity ?? 1,
      contents: "Other",
    })),
  };

  logToFile("INFO", "Fast Courier quote request body", postBody);

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
    logToFile("ERROR", "Fast Courier fetch threw (network/DNS/timeout)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "<unreadable body>");
    logToFile("ERROR", "Fast Courier quote request failed", {
      status: response.status,
      body: bodyText,
    });
    return [];
  }

  let result: FastCourierResponse;
  try {
    result = (await response.json()) as FastCourierResponse;
  } catch (err) {
    logToFile("ERROR", "Fast Courier response was not valid JSON", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  logToFile("INFO", "Fast Courier quote result", result);

  const quotes = Array.isArray(result.data) ? result.data : result.data?.quotes ?? result.quotes ?? [];

  logToFile("INFO", "Fast Courier quotes parsed", quotes);

  const rates: ShippingRate[] = quotes
    .map((entry) => {
      const price = Number(entry?.priceIncludingGst ?? entry?.price ?? entry?.amount);

      if (!Number.isFinite(price)) {
        logToFile("ERROR", "Invalid Fast Courier price", entry);
        return null;
      }

      const courierName = entry?.courierName?.trim() || "";
      const serviceName = entry?.name?.trim() || "";
      const eta = entry?.eta?.trim() || "";

      const description = [courierName, serviceName, eta].filter(Boolean).join(" · ");

      const shippingRate: ShippingRate = {
        service_name: serviceName || courierName || "Fast courier shipping",
        service_code: `fast-courier-${entry?.quote_id ?? "quote"}`,
        description: description || "Fast Courier quote",
        // Shopify expects cents
        total_price: String(Math.round(price * 100)),
        currency: entry?.currency || currency,
      };

      return shippingRate;
    })
    .filter((r): r is ShippingRate => r !== null);

  logToFile("INFO", "Total Fast Courier shipping rates", rates.length);

  return rates;
}

async function getSmartSendShippingRate(currency: string): Promise<ShippingRate[]> {
  return [
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
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const body = (await request.json()) as ShopifyRateRequest;
    const currency = body.rate?.currency;

    if (!currency) {
      logToFile("ERROR", "No currency on rate request — returning empty rates", body);
      return Response.json({ rates: [] });
    }

    const rateRequest = body.rate;
    if (!rateRequest) {
      logToFile("ERROR", "No rate object on request body", body);
      return Response.json({ rates: [] });
    }

    const totalWeightGrams = (rateRequest.items ?? []).reduce(
      (total, item) => total + (item.grams ?? 0) * (item.quantity ?? 1),
      0,
    );

    logToFile("INFO", "Shipping rate request received", {
      items: rateRequest.items ?? [],
      totalWeightGrams,
      totalWeightKilograms: totalWeightGrams / 1000,
    });

    // NOTE: these helpers already return arrays — do NOT wrap them in another [ ... ]
    // (that was the bug causing Shopify to fall back to a static rate).
    const rates =
      totalWeightGrams < FAST_DELIVERY_WEIGHT_LIMIT_GRAMS
        ? await getFastDeliveryRates(currency, rateRequest)
        : await getSmartSendShippingRate(currency);

    logToFile("INFO", "Final rates returned to Shopify", rates);

    return Response.json({ rates });
  } catch (err) {
    logToFile("ERROR", "Unhandled exception in shipping rate action", {
      error: err instanceof Error ? err.stack ?? err.message : String(err),
    });
    // Return an empty rate list rather than letting the request 500 —
    // a 500 is likely what's been triggering Shopify's static fallback rate.
    return Response.json({ rates: [] });
  }
}