import { useLoaderData, useFetcher } from "react-router";
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
/* Server helpers (only used by loader/action, so not bundled client)  */
/* ------------------------------------------------------------------ */
async function fetchOrder(admin, orderId) {
  const response = await admin.graphql(ORDER_QUERY, {
    variables: { id: `gid://shopify/Order/${orderId}` },
  });
  const json = await response.json();
  return json.data?.order ?? null;
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

  const shippingTitle = order.shippingLines.nodes[0]?.title ?? "Fast Courier";

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
      shippingTitle,
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
 * Hits the QUOTES endpoint (no order id in the path) and returns the quoteId
 * plus Fast Courier's own order id, which step 2 needs.
 *
 * New env var required: FAST_COURIER_QUOTE_URL (the full quotes endpoint URL).
 * ASSUMPTION: response field names are a guess. Check the logged response.
 */
async function requestQuote(preview) {
  const e = process.env;
  const res = await fetch(`${e.FAST_COURIER_BASE_URL}${e.FAST_COURIER_QUOTES_PATH}`, {
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
  });

  const body = await res.json().catch(() => null);
  console.log("Fast Courier quote response:", JSON.stringify(body, null, 2));

  if (!res.ok) {
    throw new Error(apiError(body, `Quote failed (${res.status})`));
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

  if (!quoteId) throw new Error("Quote response had no quoteId");
  return { quoteId, fcOrderId };
}

/* STEP 2 - book: POST {FAST_COURIER_BOOKING_URL}/{fastCourierOrderId} */
async function bookCourier(fcOrderId, quoteId, preview) {
  const e = process.env;
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
    throw new Error(apiError(body, `Booking failed (${res.status})`));
  }
  return body;
}

/* STEP 3 - confirm the booking: POST {BASE}{BOOKING_PATH}/{fastCourierOrderId}
   ASSUMPTION: takes the order id in the path with no body. Check the docs. */
async function confirmBooking(fcOrderId) {
  const e = process.env;
  const url = `${e.FAST_COURIER_BASE_URL}${e.FAST_COURIER_BOOKING_PATH}/${fcOrderId}`;
  console.log("Fast Courier order-booking URL:", url);

  const res = await fetch(url, { method: "POST", headers: fastCourierHeaders() });
  const body = await res.json().catch(() => null);
  console.log("Fast Courier order-booking response:", JSON.stringify(body, null, 2));
  if (!res.ok) {
    throw new Error(apiError(body, `Order booking failed (${res.status})`));
  }
  return body;
}

/* ------------------------------------------------------------------ */
/* Loader / action                                                     */
/* ------------------------------------------------------------------ */
export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const order = await fetchOrder(admin, params.orderId);
  if (!order) throw new Response("Order not found", { status: 404 });

  const isFastCourier = order.shippingLines.nodes.some((l) =>
    [l.title, l.code, l.carrierIdentifier].some(
      (v) => v && FAST_COURIER_PATTERN.test(v),
    ),
  );

  return { order, isFastCourier, preview: buildPreview(order) };
};

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();

  try {
    const order = await fetchOrder(admin, params.orderId);
    if (!order) throw new Error("Order not found");

    const preview = buildPreview(order, form.get("collectionDate"));

    let quoteId = form.get("quoteId");
    let fcOrderId = form.get("fcOrderId");
    if (!quoteId) {
      ({ quoteId, fcOrderId } = await requestQuote(preview));
    }

    // Fast Courier's own order id from the quote. The Shopify id is only a
    // last-resort fallback (it is what caused the "No query results" error).
    if (!fcOrderId) {
      throw new Error("Quote response had no Fast Courier order id (check the logged quote response)");
    }
    const saved = await bookCourier(fcOrderId, quoteId, preview);
    const confirmed = await confirmBooking(fcOrderId);

    return { ok: true, booking: confirmed ?? saved };
  } catch (err) {
    return { ok: false, error: err.message };
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
  const { order, isFastCourier, preview } = useLoaderData();
  const fetcher = useFetcher();

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
      {failed && <s-banner tone="critical">{fetcher.data.error}</s-banner>}

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
            <s-text type="strong">Fast Courier</s-text>
            <Field label="Service" value={carrier.shippingTitle} />
            <Field
              label="Authority to leave"
              value={carrier.authorityToLeave ? "Yes" : "No"}
            />
            <Field label="Collection date" value={dmy(carrier.collectionDate)} />
            <Field label="Pickup time" value={carrier.pickupTimeWindow} />
            <Field label="Contents" value={contents || "—"} />
            {preview.specialInstructions && (
              <Field label="Instructions" value={preview.specialInstructions} />
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
              <input type="hidden" name="collectionDate" value={carrier.collectionDate} />
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
          This order doesn't use Fast Courier shipping, so booking is disabled.
        </s-banner>
      )}
    </s-page>
  );
}