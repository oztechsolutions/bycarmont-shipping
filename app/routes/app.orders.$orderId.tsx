import { useState } from "react";
import {
  useLoaderData,
  useFetcher,
  useRouteError,
  isRouteErrorResponse,
} from "react-router";
import { authenticate } from "../shopify.server";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */
const COURIERS = {
  fastCourier: { label: "Fast Courier", pattern: /fast[\s_-]*courier/i },
  smartSend: { label: "Smart Send", pattern: /smart[\s_-]*send/i },
};

const ORDER_QUERY = `#graphql
  query GetOrder($id: ID!) {
    order(id: $id) {
      id
      name
      note
      email
      phone
      customer { email defaultPhoneNumber { phoneNumber } }
      createdAt
      displayFinancialStatus
      displayFulfillmentStatus
      shippingAddress {
        firstName lastName company address1 address2
        city province provinceCode country countryCodeV2 zip phone
      }
      shippingLines(first: 10) {
        nodes {
          id title code source carrierIdentifier
          originalPriceSet { shopMoney { amount currencyCode } }
          discountedPriceSet { shopMoney { amount currencyCode } }
        }
      }
      lineItems(first: 100) {
        nodes {
          id title quantity sku currentQuantity
          variant { id title sku }
          discountedUnitPriceSet { shopMoney { amount currencyCode } }
        }
      }
    }
  }
`;

/* ------------------------------------------------------------------ */
/* Error helpers                                                       */
/* ------------------------------------------------------------------ */

/* Turns anything thrown (Error, Response, fetch failure) into readable text */
async function describeError(err) {
  if (err instanceof Response) {
    let text = "";
    try {
      text = (await err.clone().text()).slice(0, 500);
    } catch {
      /* ignore */
    }
    return `HTTP ${err.status} ${err.statusText}${text ? ` - ${text}` : ""}`;
  }
  const cause = err?.cause?.message ? ` (cause: ${err.cause.message})` : "";
  return `${err?.message ?? String(err)}${cause}`;
}

/* Auth redirects (3xx Responses) must be rethrown or the embedded app breaks */
const isRedirect = (err) =>
  err instanceof Response && err.status >= 300 && err.status < 400;

/* Fail loudly if .env wasn't loaded (common after restarting the dev server) */
function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
}

/* ------------------------------------------------------------------ */
/* Server helpers (only used by loader/action, so not bundled client)  */
/* ------------------------------------------------------------------ */
async function fetchOrder(admin, orderId) {
  const response = await admin.graphql(ORDER_QUERY, {
    variables: { id: `gid://shopify/Order/${orderId}` },
  });
  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(
      `Shopify GraphQL error: ${json.errors.map((e) => e.message).join(" | ")}`,
    );
  }
  return json.data?.order ?? null;
}

/* Finds the shipping line matching a courier, and which field matched,
   so the UI can show why an order was detected. */
function findCourierLine(order, pattern) {
  for (const line of order.shippingLines.nodes) {
    const matchedOn = ["title", "code", "carrierIdentifier"].find(
      (field) => line[field] && pattern.test(line[field]),
    );
    if (matchedOn) return { line, matchedOn };
  }
  return { line: null, matchedOn: null };
}

/* Which courier (if any) this order was shipped with */
function detectCourier(order) {
  for (const [courier, { pattern }] of Object.entries(COURIERS)) {
    const { line, matchedOn } = findCourierLine(order, pattern);
    if (line) return { courier, line, matchedOn };
  }
  return { courier: null, line: null, matchedOn: null };
}

/* Fast Courier shipping line code:
     fast-courier:<orderId>:<quoteId>
     e.g. fast-courier:QMXQXZXYWO:18582818
   orderId = QMXQXZXYWO (used in the URL paths), quoteId = 18582818 */
function parseFastCourierCode(code = "") {
  const [prefix, fcOrderId, quoteId] = String(code)
    .split(":")
    .map((s) => s.trim());
  if (!COURIERS.fastCourier.pattern.test(prefix ?? "") || !quoteId || !fcOrderId) {
    return { quoteId: null, fcOrderId: null };
  }
  return { quoteId, fcOrderId };
}

/* Smart Send shipping line code:
     smart-send-<priceId>
     e.g. smart-send-689741  ->  PriceID 689741
   Also accepts smart-send:689741 or smart_send_689741. */
function parseSmartSendCode(code = "") {
  const m = String(code)
    .trim()
    .match(/^smart[\s_-]*send[\s:_-]*(\d+)$/i);
  return { priceId: m ? m[1] : null };
}

/* Next business day in Sydney time, as YYYY-MM-DD */
const nextBusinessDay = () => {
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Australia/Sydney",
  });
  const d = new Date(`${today}T00:00:00Z`);
  do d.setUTCDate(d.getUTCDate() + 1);
  while ([0, 6].includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
};

/* Server-side check of the (editable) collection date and pickup time */
function validateSchedule({ collectionDate, pickupTimeWindow }) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(collectionDate ?? "") ||
    Number.isNaN(Date.parse(collectionDate))
  ) {
    throw new Error("Collection date must be a valid date (yyyy-mm-dd).");
  }
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Australia/Sydney",
  });
  if (collectionDate < today) {
    throw new Error(`Collection date ${collectionDate} is in the past.`);
  }
  if (!pickupTimeWindow) throw new Error("Choose a pickup time.");
}

/* Same auth on every Fast Courier call. Sends both header styles because
   the calls previously used different ones. Once you confirm which one
   the docs require, delete the other. */
const fastCourierHeaders = () => ({
  "Content-Type": "application/json",
  Accept: "application/json",
  "Secret-Key": `${process.env.FAST_COURIER_SECRET_KEY}`,
  Authorization: `Bearer ${process.env.FAST_COURIER_SECRET_KEY}`,
});

/* Turns a Fast Courier error body into a readable message, including
   the per-field validation errors. */
const apiError = (body, fallback) => {
  const details = body?.errors
    ? Object.entries(body.errors)
        .map(([field, msgs]) => `${field}: ${[].concat(msgs).join(", ")}`)
        .join(" | ")
    : "";
  return [body?.message ?? fallback, details].filter(Boolean).join(" - ");
};

/**
 * Everything the page shows AND everything the booking uses is built here,
 * so what the merchant sees is exactly what gets sent.
 */
function buildPreview(order, collectionDate, pickupTime) {
  const e = process.env;
  const a = order.shippingAddress ?? {};

  const sender = {
    firstName: e.FAST_COURIER_PICKUP_FIRST_NAME ?? "",
    lastName: e.FAST_COURIER_PICKUP_LAST_NAME ?? "",
    company: e.FAST_COURIER_PICKUP_COMPANY ?? "",
    address1: e.FAST_COURIER_PICKUP_ADDRESS1 ?? "",
    address2: e.FAST_COURIER_PICKUP_ADDRESS2 ?? "",
    suburb: e.FAST_COURIER_PICKUP_SUBURB ?? "",
    state: e.FAST_COURIER_PICKUP_STATE ?? "",
    postcode: e.FAST_COURIER_PICKUP_POSTCODE ?? "",
    phone: e.FAST_COURIER_PICKUP_PHONE ?? "",
    email: e.FAST_COURIER_PICKUP_EMAIL ?? "",
  };

  const receiver = {
    firstName: a.firstName ?? "",
    lastName: a.lastName ?? "",
    company: a.company ?? "",
    address1: a.address1 ?? "",
    address2: a.address2 ?? "",
    suburb: a.city ?? "",
    state: a.provinceCode ?? a.province ?? "",
    postcode: a.zip ?? "",
    // Shipping address phone first, then order phone, then customer profile phone
    phone:
      a.phone ||
      order.phone ||
      order.customer?.defaultPhoneNumber?.phoneNumber ||
      "",
    email: order.email || order.customer?.email || "",
  };

  // Fast Courier: display only (the saved quote is used).
  // Smart Send: sent in the BookJob request, so these must match the
  // items the quote was originally obtained with.
  const items = order.lineItems.nodes.map((li) => ({
    id: li.id,
    title: li.title,
    type: e.FAST_COURIER_DEFAULT_TYPE ?? "roll",
    contents: e.FAST_COURIER_DEFAULT_CONTENTS ?? "other",
    weight: Number(e.FAST_COURIER_DEFAULT_WEIGHT_KG ?? 1),
    length: Number(e.FAST_COURIER_DEFAULT_LENGTH_CM ?? 30),
    width: Number(e.FAST_COURIER_DEFAULT_WIDTH_CM ?? 20),
    height: Number(e.FAST_COURIER_DEFAULT_HEIGHT_CM ?? 15),
    quantity: li.currentQuantity ?? li.quantity,
  }));

  // Not displayed, but still sent as valueOfContent in the Fast Courier booking.
  const declaredValue =
    Math.round(
      order.lineItems.nodes.reduce(
        (sum, li) =>
          sum +
          Number(li.discountedUnitPriceSet?.shopMoney?.amount ?? 0) *
            (li.currentQuantity ?? li.quantity),
        0,
      ) * 100,
    ) / 100;

  // Prefer the line that matched a courier; otherwise the first line
  const { courier, line: courierLine, matchedOn } = detectCourier(order);
  const shippingLine = courierLine ?? order.shippingLines.nodes[0] ?? null;

  const ids =
    courier === "fastCourier"
      ? parseFastCourierCode(shippingLine?.code)
      : courier === "smartSend"
        ? parseSmartSendCode(shippingLine?.code)
        : {};

  return {
    sender,
    receiver,
    items,
    declaredValue,
    contents: order.lineItems.nodes
      .map((li) => li.title)
      .join(", ")
      .slice(0, 250),
    carrier: {
      courier, // "fastCourier" | "smartSend" | null
      courierLabel: courier ? COURIERS[courier].label : "",
      shippingTitle: shippingLine?.title ?? "",
      shippingCode: shippingLine?.code ?? "",
      carrierIdentifier: shippingLine?.carrierIdentifier ?? "",
      shippingSource: shippingLine?.source ?? "",
      matchedOn,
      shippingOriginal: shippingLine?.originalPriceSet?.shopMoney ?? null,
      shippingCharged: shippingLine?.discountedPriceSet?.shopMoney ?? null,
      // Ids read from the shipping line code (no quote is ever requested)
      quoteId: null, // Fast Courier
      fcOrderId: null, // Fast Courier
      priceId: null, // Smart Send
      ...ids,
      authorityToLeave: e.FAST_COURIER_AUTHORITY_TO_LEAVE === "true",
      collectionDate: collectionDate || nextBusinessDay(),
      // Editable on the page: the submitted value wins, env is the default
      pickupTimeWindow:
        pickupTime ||
        (courier === "smartSend"
          ? (e.SMARTSEND_PICKUP_TIME ?? "9am to 5pm")
          : (e.FAST_COURIER_PICKUP_TIME_WINDOW ?? "9am to 5pm")),
      // Optional comma-separated lists. When set, the page shows a dropdown.
      pickupTimeOptions: (
        (courier === "smartSend"
          ? e.SMARTSEND_PICKUP_TIME_OPTIONS
          : e.FAST_COURIER_PICKUP_TIME_OPTIONS) ?? ""
      )
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    },
    specialInstructions: order.note ?? "",
    docsEmail: e.FAST_COURIER_DOCS_EMAIL ?? sender.email,
  };
}

/* ------------------------------------------------------------------ */
/* Fast Courier                                                        */
/* ------------------------------------------------------------------ */

/* STEP 1 - save booking details: POST {BASE}{SAVE_BOOKING_PATH}/{fcOrderId}
   (/api/save-order-details/{orderId}) */
async function bookCourier(fcOrderId, quoteId, preview) {
  const e = process.env;
  requireEnv(
    "FAST_COURIER_BASE_URL",
    "FAST_COURIER_SAVE_BOOKING_PATH",
    "FAST_COURIER_SECRET_KEY",
  );
  const extended = e.FAST_COURIER_EXTENDED_LIABILITY ?? "0";

  const payload = {
    quoteId,
    senderType: "sender",

    pickupFirstName: preview.sender.firstName,
    pickupLastName: preview.sender.lastName,
    pickupCompanyName: preview.sender.company,
    pickupEmail: preview.sender.email,
    pickupAddress1: preview.sender.address1,
    pickupAddress2: preview.sender.address2,
    pickupPhone: preview.sender.phone,

    destinationFirstName: preview.receiver.firstName,
    destinationLastName: preview.receiver.lastName,
    destinationCompanyName: preview.receiver.company,
    destinationEmail: preview.receiver.email,
    destinationAddress1: preview.receiver.address1,
    destinationAddress2: preview.receiver.address2,
    destinationPhone: preview.receiver.phone,

    collectionDate: preview.carrier.collectionDate,
    pickupTimeWindow: preview.carrier.pickupTimeWindow,
    parcelContent: preview.contents,
    specialInstructions: preview.specialInstructions,
    valueOfContent: preview.declaredValue,
    authorityToLeave: preview.carrier.authorityToLeave,
    noPrinter: false,

    extendedLiability: extended,
    ...(extended !== "0" && { insuranceValue: `$${preview.declaredValue}` }),
    acceptInsuranceConditions: extended !== "0",
    acceptTermConditions: true,
    acceptAttachment: true,
    acceptNoDangerousGoods: true,
    acceptReadFinancialServiceGuide: true,

    emailForDocuments: preview.docsEmail,
    additionalEmailsForDocuments: preview.docsEmail
      ? [{ email: preview.docsEmail }]
      : [],
  };

  const url = `${e.FAST_COURIER_BASE_URL}${e.FAST_COURIER_SAVE_BOOKING_PATH}/${fcOrderId}`;
  console.log("Fast Courier save-order-details URL:", url);

  const res = await fetch(url, {
    method: "POST",
    headers: fastCourierHeaders(),
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    console.error("Fast Courier booking failed", res.status, body);
    throw new Error(`Save booking: ${apiError(body, `failed (${res.status})`)}`);
  }
  return body;
}

/* STEP 2 - confirm the booking: POST {BASE}{BOOKING_PATH}/{fcOrderId}
   (/api/order-booking/{orderId})
   ASSUMPTION: takes the order id in the path with no body. Check the docs. */
async function confirmBooking(fcOrderId) {
  const e = process.env;
  requireEnv("FAST_COURIER_BASE_URL", "FAST_COURIER_BOOKING_PATH");
  const url = `${e.FAST_COURIER_BASE_URL}${e.FAST_COURIER_BOOKING_PATH}/${fcOrderId}`;
  console.log("Fast Courier order-booking URL:", url);

  const res = await fetch(url, { method: "POST", headers: fastCourierHeaders() });
  const body = await res.json().catch(() => null);
  console.log("Fast Courier order-booking response:", JSON.stringify(body, null, 2));
  if (!res.ok) {
    throw new Error(`Confirm booking: ${apiError(body, `failed (${res.status})`)}`);
  }
  return body;
}

/* ------------------------------------------------------------------ */
/* Smart Send (SOAP)                                                   */
/* ------------------------------------------------------------------ */
const xmlEscape = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const xmlUnescape = (v) =>
  String(v ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/* <Name>value</Name>, or nothing when the value is empty (optional fields) */
const tag = (name, value) =>
  value === undefined || value === null || value === ""
    ? ""
    : `<${name}>${xmlEscape(value)}</${name}>`;

const xmlValue = (xml, name) =>
  xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? null;

/* Smart Send phone numbers must be exactly 10 digits */
function auPhone(raw, label) {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.startsWith("61") && d.length === 11) d = `0${d.slice(2)}`;
  if (d.length !== 10) {
    throw new Error(
      `Smart Send needs a 10-digit ${label} phone number (got "${raw || ""}").`,
    );
  }
  return d;
}

const cut = (v, n) => String(v ?? "").slice(0, n);
const fullName = (p) => cut([p.firstName, p.lastName].filter(Boolean).join(" "), 30);

/* Books using the PriceID saved on the order. No quote is requested.
   The BookJob "request" block must match the ObtainQuote request the
   PriceID came from (postcodes, suburbs, states, items), so it is built
   from the same sender / receiver / items shown on the page. */
async function bookSmartSend(preview, orderName) {
  const e = process.env;
  requireEnv(
    "SMARTSEND_COURIER_QUOTES_URL",
    "SMARTSEND_VIP_USERNAME",
    "SMARTSEND_VIP_PASSWORD",
  );
  const { sender, receiver, carrier } = preview;

  if (!carrier.priceId) {
    throw new Error(
      `Couldn't read a Smart Send PriceID from the shipping code "${carrier.shippingCode}".`,
    );
  }
  if (!carrier.pickupTimeWindow) {
    throw new Error(
      "Choose a pickup time (must be one of Smart Send's valid pickup time values).",
    );
  }

  const pickupPhone = auPhone(sender.phone, "pickup");
  const destPhone = auPhone(receiver.phone, "receiver");

  // Smart Send has no quantity field, so repeat each item per unit
  const itemsXml = preview.items
    .flatMap((i) =>
      Array.from({ length: Math.max(1, Number(i.quantity) || 1) }, () => i),
    )
    .map(
      (i) =>
        `<Item>${tag("Description", cut(i.title, 30))}` +
        `${tag("Depth", Math.round(i.width))}` +
        `${tag("Height", Math.round(i.height))}` +
        `${tag("Length", Math.round(i.length))}` +
        `${tag("Weight", i.weight)}</Item>`,
    )
    .join("");

  const requestXml =
    `<request>` +
    tag("DeveloperId", e.SMARTSEND_DEVELOPER_ID) +
    tag("ResellerId", e.SMARTSEND_RESELLER_ID) +
    tag("TailLift", e.SMARTSEND_TAIL_LIFT ?? "None") +
    tag("TransportAssurance", Number(e.SMARTSEND_TRANSPORT_ASSURANCE ?? 0)) +
    tag("VIPUsername", e.SMARTSEND_VIP_USERNAME) +
    tag("VIPPassword", e.SMARTSEND_VIP_PASSWORD) +
    tag("PostcodeFrom", sender.postcode) +
    tag("PostcodeTo", receiver.postcode) +
    tag("SuburbFrom", sender.suburb) +
    tag("SuburbTo", receiver.suburb) +
    tag("StateFrom", sender.state) +
    tag("StateTo", receiver.state) +
    tag("UserType", e.SMARTSEND_USER_TYPE ?? "Business") +
    tag("ReceiptedDelivery", e.SMARTSEND_RECEIPTED_DELIVERY === "true") +
    `<Items>${itemsXml}</Items>` +
    `</request>`;

  const party = (p, phone) =>
    tag("CompanyName", cut(p.company, 30)) +
    tag("Name", fullName(p)) +
    tag("Phone", phone);

  const detailsXml =
    `<details>` +
    tag("PriceID", carrier.priceId) +
    tag("MerchantInvoiceNumber", cut(orderName, 20)) +
    `<ContactDetails>${party(sender, pickupPhone)}${tag("Email", sender.email)}</ContactDetails>` +
    `<PickupDetails>${party(sender, pickupPhone)}` +
    `${tag("StreetAddress1", cut(sender.address1, 30))}${tag("StreetAddress2", cut(sender.address2, 30))}</PickupDetails>` +
    `<DestinationDetails>${party(receiver, destPhone)}` +
    `${tag("StreetAddress1", cut(receiver.address1, 30))}${tag("StreetAddress2", cut(receiver.address2, 30))}</DestinationDetails>` +
    tag("PickupDate", carrier.collectionDate) +
    tag("PickupTime", carrier.pickupTimeWindow) +
    tag("ReceiverEmailIn", receiver.email) +
    `</details>`;

  // The quote block is reduced to the PriceID we have saved
  const quoteXml = `<quote>${tag("PriceID", carrier.priceId)}</quote>`;

  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body><BookJob xmlns="http://developer.smartsend.com.au/">` +
    requestXml +
    detailsXml +
    quoteXml +
    `</BookJob></soap:Body></soap:Envelope>`;

  // POST to the service URL itself. "?op=BookJob" is only the help page.
  console.log("Smart Send BookJob URL:", e.SMARTSEND_COURIER_QUOTES_URL);

  const res = await fetch(e.SMARTSEND_COURIER_QUOTES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: '"http://developer.smartsend.com.au/BookJob"',
    },
    body: envelope,
  });
  const text = await res.text();
  // Log the response only, never the request (it contains the password)
  console.log("Smart Send BookJob response:", text.slice(0, 2000));

  if (!res.ok) {
    const fault = xmlValue(text, "faultstring");
    throw new Error(
      `Smart Send: HTTP ${res.status}${fault ? ` - ${xmlUnescape(fault)}` : ""}`,
    );
  }

  const statusCode = xmlValue(text, "StatusCode");
  const messages = [
    ...(xmlValue(text, "StatusMessages") ?? "").matchAll(
      /<string>([\s\S]*?)<\/string>/g,
    ),
  ].map((m) => xmlUnescape(m[1]));

  if (statusCode !== "0") {
    throw new Error(
      `Smart Send: ${messages.join(" | ") || `failed (StatusCode ${statusCode ?? "unknown"})`}`,
    );
  }

  return {
    referenceNumber: xmlValue(text, "ReferenceID"),
    messages,
  };
}

/* ------------------------------------------------------------------ */
/* Loader / action                                                     */
/* ------------------------------------------------------------------ */
export const loader = async ({ request, params }) => {
  // Outside try/catch on purpose: auth throws redirects that must pass through
  const { admin } = await authenticate.admin(request);

  try {
    const order = await fetchOrder(admin, params.orderId);
    if (!order) {
      return {
        error: `Order gid://shopify/Order/${params.orderId} not found (Shopify returned no order and no errors).`,
      };
    }

    const preview = buildPreview(order);

    return {
      order,
      isSupportedCourier: preview.carrier.courier !== null,
      preview,
      error: null,
    };
  } catch (err) {
    if (isRedirect(err)) throw err;
    console.error("Loader failed:", err);
    return { error: await describeError(err) };
  }
};

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);

  try {
    const form = await request.formData();
    const order = await fetchOrder(admin, params.orderId);
    if (!order) throw new Error("Order not found");

    const preview = buildPreview(
      order,
      String(form.get("collectionDate") ?? "").trim(),
      String(form.get("pickupTime") ?? "").trim(),
    );
    const { courier } = preview.carrier;

    // Server-side guard: only book couriers this page supports
    if (!courier) {
      const method = order.shippingLines.nodes[0]?.title ?? "unknown";
      throw new Error(
        `This order's shipping method ("${method}") is not Fast Courier or Smart Send, so it can't be booked here.`,
      );
    }

    validateSchedule(preview.carrier);

    // Ids come ONLY from the order's saved shipping code. No quote is requested.
    if (courier === "fastCourier") {
      const { quoteId, fcOrderId } = preview.carrier;
      if (!quoteId || !fcOrderId) {
        throw new Error(
          `Couldn't read a quote id and order id from the shipping code "${preview.carrier.shippingCode}". Expected fast-courier:<orderId>:<quoteId>.`,
        );
      }

      const saved = await bookCourier(fcOrderId, quoteId, preview);
      const confirmed = await confirmBooking(fcOrderId);

      return { ok: true, booking: confirmed ?? saved };
    }

    // courier === "smartSend"
    const booking = await bookSmartSend(preview, order.name);
    return { ok: true, booking };
  } catch (err) {
    if (isRedirect(err)) throw err;
    console.error("Action failed:", err);
    return { ok: false, error: await describeError(err) };
  }
};

/* ------------------------------------------------------------------ */
/* UI helpers                                                          */
/* ------------------------------------------------------------------ */
const humanize = (s) =>
  s
    ? s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())
    : "—";

const statusTone = (s = "") => {
  const v = s.toUpperCase();
  if (["FULFILLED", "PAID", "CLOSED"].includes(v)) return "success";
  if (["PARTIALLY_FULFILLED", "PARTIALLY_PAID", "IN_PROGRESS", "PENDING"].includes(v))
    return "caution";
  if (["UNFULFILLED", "OPEN"].includes(v)) return "warning";
  return "neutral";
};

const dmy = (iso) => iso.split("-").reverse().join("-"); // 2026-09-15 -> 15-09-2026

const money = (m) =>
  m
    ? new Intl.NumberFormat("en-AU", {
        style: "currency",
        currency: m.currencyCode,
      }).format(Number(m.amount))
    : "—";

const MATCH_LABELS = {
  title: "service title",
  code: "service code",
  carrierIdentifier: "carrier ID",
};

function Party({ heading, p }) {
  return (
    <s-stack gap="small-200">
      <s-heading>{heading}</s-heading>
      <s-stack gap="small-500">
        <s-text type="strong">
          {[p.firstName, p.lastName].filter(Boolean).join(" ") || "—"}
        </s-text>
        {p.company && <s-text>{p.company}</s-text>}
        <s-text>{p.address1}</s-text>
        {p.address2 && <s-text>{p.address2}</s-text>}
        <s-text>
          {[p.suburb, [p.state, p.postcode].filter(Boolean).join(" ")]
            .filter(Boolean)
            .join(" ")}
        </s-text>
        {p.phone && <s-text color="subdued">Phone: {p.phone}</s-text>}
        {p.email && <s-text color="subdued">Email: {p.email}</s-text>}
      </s-stack>
    </s-stack>
  );
}

function Field({ label, value }) {
  return (
    <s-stack direction="inline" gap="small-300">
      <s-text type="strong">{label}:</s-text>
      <s-text color="subdued">{value}</s-text>
    </s-stack>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */
export default function OrderFulfillmentConfirmation() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  // Editable schedule, starts from the loader defaults
  const [collectionDate, setCollectionDate] = useState(
    data.preview?.carrier?.collectionDate ?? "",
  );
  const [pickupTime, setPickupTime] = useState(
    data.preview?.carrier?.pickupTimeWindow ?? "",
  );

  // Loader failed: show the real reason instead of a 404 / generic error
  if (data.error) {
    return (
      <s-page heading="Fulfil order">
        <s-link slot="breadcrumb-actions" href="/app">
          Orders
        </s-link>
        <s-banner tone="critical" heading="Couldn't load this order">
          {data.error}
        </s-banner>
      </s-page>
    );
  }

  const { order, isSupportedCourier, preview } = data;
  const { sender, receiver, carrier, items, contents } = preview;
  const isFastCourier = carrier.courier === "fastCourier";
  const isSmartSend = carrier.courier === "smartSend";
  const booked = fetcher.data?.ok === true;
  const failed = fetcher.data?.ok === false;
  const submitting = fetcher.state !== "idle";
  const missingIds = isFastCourier
    ? !carrier.quoteId || !carrier.fcOrderId
    : isSmartSend
      ? !carrier.priceId
      : false;
  const booking = fetcher.data?.booking;
  const reference =
    booking?.referenceNumber ??
    booking?.data?.referenceNumber ??
    booking?.reference ??
    null;

  return (
    <s-page heading={`Fulfil order · ${order.name}`}>
      <s-link slot="breadcrumb-actions" href="/app">
        Orders
      </s-link>

      {booked && (
        <s-banner tone="success">
          Courier booked with {carrier.courierLabel} for {order.name}
          {reference ? ` · Reference ${reference}` : ""}.
        </s-banner>
      )}
      {failed && (
        <s-banner tone="critical" heading="Booking failed">
          {fetcher.data.error}
        </s-banner>
      )}
      {isSupportedCourier && missingIds && (
        <s-banner tone="warning" heading="Missing quote details">
          {isFastCourier
            ? `Couldn't read a quote id and order id from the shipping code "${carrier.shippingCode}". Expected fast-courier:<orderId>:<quoteId>.`
            : `Couldn't read a Smart Send PriceID from the shipping code "${carrier.shippingCode}".`}
        </s-banner>
      )}

      {/* Status ---------------------------------------------------------- */}
      <s-section>
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={statusTone(order.displayFinancialStatus)}>
            {humanize(order.displayFinancialStatus)}
          </s-badge>
          <s-badge tone={statusTone(order.displayFulfillmentStatus)}>
            {humanize(order.displayFulfillmentStatus)}
          </s-badge>
          <s-text color="subdued">
            Placed {new Date(order.createdAt).toLocaleString()}
          </s-text>
        </s-stack>
      </s-section>

      {/* Sender / Receiver / Shipping ------------------------------------ */}
      <s-section>
        <s-grid gridTemplateColumns="repeat(3, 1fr)" gap="large">
          <Party heading="Sender" p={sender} />
          <Party heading="Receiver" p={receiver} />

          <s-stack gap="small-200">
            <s-heading>Shipping</s-heading>

            {/* Exactly what the customer selected, straight from Shopify */}
            {order.shippingLines.nodes.length === 0 && (
              <s-text>No shipping method on this order</s-text>
            )}
            {order.shippingLines.nodes.map((line) => {
              const charged = line.discountedPriceSet?.shopMoney;
              const original = line.originalPriceSet?.shopMoney;
              return (
                <s-stack key={line.id} gap="small-500">
                  <s-text type="strong">{line.title}</s-text>
                  <Field label="Service code" value={line.code || "—"} />
                  <Field
                    label="Carrier ID"
                    value={line.carrierIdentifier || "—"}
                  />
                  <Field label="Source" value={line.source || "—"} />
                  <Field label="Shipping charged" value={money(charged)} />
                  {original && original.amount !== charged?.amount && (
                    <Field label="Original price" value={money(original)} />
                  )}
                </s-stack>
              );
            })}

            {/* Booking details: only relevant when we will book a courier */}
            {isSupportedCourier && (
              <s-stack gap="small-500">
                <s-heading>{carrier.courierLabel} booking</s-heading>
                {carrier.matchedOn && (
                  <Field
                    label="Detected via"
                    value={MATCH_LABELS[carrier.matchedOn]}
                  />
                )}
                {isFastCourier && (
                  <>
                    <Field label="Quote ID" value={carrier.quoteId || "—"} />
                    <Field
                      label="FC order ID"
                      value={carrier.fcOrderId || "—"}
                    />
                    <Field
                      label="Authority to leave"
                      value={carrier.authorityToLeave ? "Yes" : "No"}
                    />
                  </>
                )}
                {isSmartSend && (
                  <Field label="Price ID" value={carrier.priceId || "—"} />
                )}
                <Field
                  label="Collection date"
                  value={collectionDate ? dmy(collectionDate) : "—"}
                />
                <Field label="Pickup time" value={pickupTime || "—"} />
                <Field label="Contents" value={contents || "—"} />
                {preview.specialInstructions && (
                  <Field
                    label="Instructions"
                    value={preview.specialInstructions}
                  />
                )}
              </s-stack>
            )}
          </s-stack>
        </s-grid>
      </s-section>

      {/* Items (Fast Courier: display only. Smart Send: sent in the booking) */}
      <s-section heading="Items" padding="none">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Contents</s-table-header>
            <s-table-header>Package type</s-table-header>
            <s-table-header format="numeric">Weight</s-table-header>
            <s-table-header format="numeric">Length</s-table-header>
            <s-table-header format="numeric">Width</s-table-header>
            <s-table-header format="numeric">Height</s-table-header>
            <s-table-header format="numeric">Qty</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {items.map((i) => (
              <s-table-row key={i.id}>
                <s-table-cell>{i.title}</s-table-cell>
                <s-table-cell>{humanize(i.type)}</s-table-cell>
                <s-table-cell>{i.weight} kg</s-table-cell>
                <s-table-cell>{i.length} cm</s-table-cell>
                <s-table-cell>{i.width} cm</s-table-cell>
                <s-table-cell>{i.height} cm</s-table-cell>
                <s-table-cell>{i.quantity}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      {/* Fulfil ---------------------------------------------------------- */}
      {isSupportedCourier ? (
        <s-section heading="Book courier">
          <s-stack gap="base">
            <s-paragraph>
              Check the sender, receiver and shipping details above, and set
              the collection date and pickup time. Fulfilling the order books
              the pickup with {carrier.courierLabel} using the quote saved with
              this order.
            </s-paragraph>

            <s-stack direction="inline" gap="base">
              <s-date-field
                label="Collection date"
                details="Format yyyy-mm-dd, e.g. 2026-10-02"
                value={collectionDate}
                onChange={(e) => setCollectionDate(e.currentTarget.value)}
              />
              {carrier.pickupTimeOptions.length > 0 ? (
                <s-select
                  label="Pickup time"
                  value={pickupTime}
                  onChange={(e) => setPickupTime(e.currentTarget.value)}
                >
                  {(carrier.pickupTimeOptions.includes(pickupTime) || !pickupTime
                    ? carrier.pickupTimeOptions
                    : [pickupTime, ...carrier.pickupTimeOptions]
                  ).map((o) => (
                    <s-option key={o} value={o}>
                      {o}
                    </s-option>
                  ))}
                </s-select>
              ) : (
                <s-text-field
                  label="Pickup time"
                  placeholder="9am to 5pm"
                  details="Example: 9am to 5pm"
                  value={pickupTime}
                  onChange={(e) => setPickupTime(e.currentTarget.value)}
                />
              )}
            </s-stack>

            <fetcher.Form method="post">
              <input type="hidden" name="collectionDate" value={collectionDate} />
              <input type="hidden" name="pickupTime" value={pickupTime} />
              <s-button
                variant="primary"
                type="submit"
                loading={submitting || undefined}
                disabled={
                  booked || missingIds || !collectionDate || !pickupTime || undefined
                }
              >
                Fulfil by {carrier.courierLabel}
              </s-button>
            </fetcher.Form>
          </s-stack>
        </s-section>
      ) : (
        <s-banner tone="info">
          This order uses "{carrier.shippingTitle || "no shipping method"}", not
          Fast Courier or Smart Send, so booking is disabled.
        </s-banner>
      )}
    </s-page>
  );
}

/* ------------------------------------------------------------------ */
/* Error boundary: shows the real error instead of "Application Error" */
/* ------------------------------------------------------------------ */
export function ErrorBoundary() {
  const error = useRouteError();
  console.error("Route ErrorBoundary caught:", error);

  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText} - ${
        typeof error.data === "string" ? error.data : JSON.stringify(error.data)
      }`
    : (error?.stack ?? error?.message ?? String(error));

  return (
    <s-page heading="Something went wrong">
      <s-banner tone="critical">
        <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{message}</pre>
      </s-banner>
    </s-page>
  );
}