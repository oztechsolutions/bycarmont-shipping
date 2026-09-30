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
const FAST_COURIER_PATTERN = /fast[\s_-]*courier/i;

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

/* Finds the shipping line that looks like Fast Courier, and which field
   matched, so the UI can show why an order was detected. */
function findFastCourierLine(order) {
  for (const line of order.shippingLines.nodes) {
    const matchedOn = ["title", "code", "carrierIdentifier"].find(
      (field) => line[field] && FAST_COURIER_PATTERN.test(line[field]),
    );
    if (matchedOn) return { line, matchedOn };
  }
  return { line: null, matchedOn: null };
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

/* Same auth on every Fast Courier call. Sends both header styles because
   the quote and booking calls previously used different ones. Once you
   confirm which one the docs require, delete the other. */
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
function buildPreview(order, collectionDate) {
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

  const items = order.lineItems.nodes.map((li) => ({
    id: li.id,
    title: li.title,
    type: e.FAST_COURIER_DEFAULT_TYPE ?? "roll",
    // Must be one of the values from GET /package-contents-list
    contents: e.FAST_COURIER_DEFAULT_CONTENTS ?? "other",
    weight: Number(e.FAST_COURIER_DEFAULT_WEIGHT_KG ?? 1),
    length: Number(e.FAST_COURIER_DEFAULT_LENGTH_CM ?? 30),
    width: Number(e.FAST_COURIER_DEFAULT_WIDTH_CM ?? 20),
    height: Number(e.FAST_COURIER_DEFAULT_HEIGHT_CM ?? 15),
    quantity: li.currentQuantity ?? li.quantity,
  }));

  // Not displayed, but still sent as valueOfContent in the booking.
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

  // Prefer the line that matched Fast Courier; otherwise the first line
  const { line: fcLine, matchedOn } = findFastCourierLine(order);
  const shippingLine = fcLine ?? order.shippingLines.nodes[0] ?? null;

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
      shippingTitle: shippingLine?.title ?? "",
      shippingCode: shippingLine?.code ?? "",
      carrierIdentifier: shippingLine?.carrierIdentifier ?? "",
      shippingSource: shippingLine?.source ?? "",
      matchedOn,
      shippingOriginal: shippingLine?.originalPriceSet?.shopMoney ?? null,
      shippingCharged: shippingLine?.discountedPriceSet?.shopMoney ?? null,
      authorityToLeave: e.FAST_COURIER_AUTHORITY_TO_LEAVE === "true",
      collectionDate: collectionDate || nextBusinessDay(),
      pickupTimeWindow: e.FAST_COURIER_PICKUP_TIME_WINDOW ?? "9am to 5pm",
    },
    specialInstructions: order.note ?? "",
    docsEmail: e.FAST_COURIER_DOCS_EMAIL ?? sender.email,
  };
}

/**
 * STEP 1 - request a quote.
 * Returns the quoteId plus Fast Courier's own order id, which step 2 needs.
 * ASSUMPTION: response field names are a guess. Check the logged response.
 */
async function requestQuote(preview) {
  const e = process.env;
  requireEnv(
    "FAST_COURIER_BASE_URL",
    "FAST_COURIER_QUOTES_PATH",
    "FAST_COURIER_SECRET_KEY",
  );

  const res = await fetch(
    `${e.FAST_COURIER_BASE_URL}${e.FAST_COURIER_QUOTES_PATH}`,
    {
      method: "POST",
      headers: fastCourierHeaders(),
      body: JSON.stringify({
        pickupSuburb: preview.sender.suburb,
        pickupState: preview.sender.state,
        pickupPostcode: preview.sender.postcode,
        pickupBuildingType: e.FAST_COURIER_PICKUP_BUILDING_TYPE,
        destinationSuburb: preview.receiver.suburb,
        destinationState: preview.receiver.state,
        destinationPostcode: preview.receiver.postcode,
        destinationBuildingType: e.FAST_COURIER_DESTINATION_BUILDING_TYPE,
        isPickupTailLift: e.FAST_COURIER_PICKUP_TAIL_LIFT === "true",
        isDropOffTailLift: e.FAST_COURIER_DROPOFF_TAIL_LIFT === "true",
        isDropOffPOBox: e.FAST_COURIER_DROPOFF_PO_BOX === "true",
        items: preview.items.map((i) => ({
          type: i.type,
          contents: i.contents,
          length: i.length,
          width: i.width,
          height: i.height,
          weight: i.weight,
          quantity: i.quantity,
        })),
      }),
    },
  );

  const body = await res.json().catch(() => null);
  console.log("Fast Courier quote response:", JSON.stringify(body, null, 2));

  if (!res.ok) {
    throw new Error(`Quote: ${apiError(body, `failed (${res.status})`)}`);
  }

  const first = body?.data?.[0] ?? body?.quotes?.[0] ?? body;
  const quoteId = first?.quoteId ?? first?.id;
  const fcOrderId =
    body?.orderId ??
    body?.order_id ??
    body?.data?.orderId ??
    first?.orderId ??
    first?.order_id ??
    null;

  if (!quoteId) {
    throw new Error("Quote response had no quoteId (see server log for body)");
  }
  return { quoteId, fcOrderId };
}

/* STEP 2 - save booking details: POST {BASE}{SAVE_BOOKING_PATH}/{fcOrderId} */
async function bookCourier(fcOrderId, quoteId, preview) {
  const e = process.env;
  requireEnv("FAST_COURIER_BASE_URL", "FAST_COURIER_SAVE_BOOKING_PATH");
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

/* STEP 3 - confirm the booking: POST {BASE}{BOOKING_PATH}/{fcOrderId}
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

    const isFastCourier = findFastCourierLine(order).line !== null;

    return { order, isFastCourier, preview: buildPreview(order), error: null };
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

    // Server-side guard: never book Fast Courier for other shipping methods
    if (!findFastCourierLine(order).line) {
      const method = order.shippingLines.nodes[0]?.title ?? "unknown";
      throw new Error(
        `This order's shipping method ("${method}") is not Fast Courier, so it can't be booked here.`,
      );
    }

    const preview = buildPreview(order, form.get("collectionDate"));

    let quoteId = form.get("quoteId");
    let fcOrderId = form.get("fcOrderId");
    if (!quoteId) {
      ({ quoteId, fcOrderId } = await requestQuote(preview));
    }

    if (!fcOrderId) {
      throw new Error(
        "Quote response had no Fast Courier order id (check the logged quote response)",
      );
    }
    const saved = await bookCourier(fcOrderId, quoteId, preview);
    const confirmed = await confirmBooking(fcOrderId);

    return { ok: true, booking: confirmed ?? saved };
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

  const { order, isFastCourier, preview } = data;
  const { sender, receiver, carrier, items, contents } = preview;
  const booked = fetcher.data?.ok === true;
  const failed = fetcher.data?.ok === false;
  const submitting = fetcher.state !== "idle";
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
          Courier booked for {order.name}
          {reference ? ` · Reference ${reference}` : ""}.
        </s-banner>
      )}
      {failed && (
        <s-banner tone="critical" heading="Booking failed">
          {fetcher.data.error}
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

            {/* Booking details: only relevant when we will book Fast Courier */}
            {isFastCourier && (
              <s-stack gap="small-500">
                <s-heading>Fast Courier booking</s-heading>
                {carrier.matchedOn && (
                  <Field
                    label="Detected via"
                    value={MATCH_LABELS[carrier.matchedOn]}
                  />
                )}
                <Field
                  label="Authority to leave"
                  value={carrier.authorityToLeave ? "Yes" : "No"}
                />
                <Field
                  label="Collection date"
                  value={dmy(carrier.collectionDate)}
                />
                <Field label="Pickup time" value={carrier.pickupTimeWindow} />
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

      {/* Items ----------------------------------------------------------- */}
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
      {isFastCourier ? (
        <s-section heading="Book courier">
          <s-stack
            direction="inline"
            justifyContent="space-between"
            alignItems="center"
            gap="base"
          >
            <s-paragraph>
              Check the sender, receiver and items above. Fulfilling the order
              requests a quote and books the pickup.
            </s-paragraph>
            <fetcher.Form method="post">
              <input
                type="hidden"
                name="collectionDate"
                value={carrier.collectionDate}
              />
              <s-button
                variant="primary"
                type="submit"
                loading={submitting || undefined}
                disabled={booked || undefined}
              >
                Fulfil the order
              </s-button>
            </fetcher.Form>
          </s-stack>
        </s-section>
      ) : (
        <s-banner tone="info">
          This order uses "{carrier.shippingTitle || "no shipping method"}", not
          Fast Courier, so booking is disabled.
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