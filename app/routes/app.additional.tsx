import type { LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useSearchParams } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);

  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";

  const where: {
    shop: string;
    createdAt?: {
      gte?: Date;
      lte?: Date;
    };
  } = {
    shop: session.shop,
  };

  if (from || to) {
    where.createdAt = {};

    if (from) {
      const fromDate = new Date(from);

      if (!Number.isNaN(fromDate.getTime())) {
        where.createdAt.gte = fromDate;
      }
    }

    if (to) {
      const toDate = new Date(to);

      if (!Number.isNaN(toDate.getTime())) {
        where.createdAt.lte = toDate;
      }
    }
  }

  const logs = await prisma.shippingRateLog.findMany({
    where,
    orderBy: {
      createdAt: "desc",
    },
    take: 200,
    select: {
      id: true,
      requestId: true,
      checkoutToken: true,

      currency: true,
      totalWeightGrams: true,
      totalWeightKg: true,
      itemCount: true,

      destinationCountry: true,
      destinationState: true,
      destinationCity: true,
      destinationPostcode: true,

      provider: true,
      providerHttpStatus: true,
      totalQuoteCount: true,
      quoteBreakdownJson: true,

      returnedRateCount: true,

      status: true,
      errorMessage: true,
      durationMs: true,
      createdAt: true,

      requestJson: true,
      itemsJson: true,
      providerRequestJson: true,
      providerResponseJson: true,
      returnedRatesJson: true,
    },
  });

  return {
    logs: logs.map((log) => ({
      ...log,
      createdAt: log.createdAt.toISOString(),
    })),
    filters: {
      from,
      to,
    },
  };
}

type LoaderData = Awaited<ReturnType<typeof loader>>;

type ShippingLog = LoaderData["logs"][number];

function formatDate(date: string): string {
  return new Date(date).toLocaleString("en-AU", {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

function formatWeight(
  grams: number | null,
  kg: number | null,
): string {
  if (kg != null) {
    return `${Number(kg).toFixed(2)} kg`;
  }

  if (grams != null) {
    return `${grams.toLocaleString()} g`;
  }

  return "-";
}

function prettyJson(value: string | null): string {
  if (!value) {
    return "-";
  }

  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "success":
      return "Success";

    case "empty":
      return "No rates";

    case "error":
      return "Error";

    default:
      return status || "-";
  }
}

function statusTone(
  status: string,
): "success" | "caution" | "critical" | "neutral" {
  switch (status) {
    case "success":
      return "success";

    case "empty":
      return "caution";

    case "error":
      return "critical";

    default:
      return "neutral";
  }
}

export default function AdditionalPage() {
  const { logs, filters } =
    useLoaderData<typeof loader>();

  const [searchParams] = useSearchParams();

  return (
    <s-page heading="Shipping Rate Logs">
      {/* Search */}
      <s-section heading="Search logs">
        <Form method="get">
          <s-stack direction="inline" gap="base">
            <s-text-field
              label="From"
              name="from"
              type="datetime-local"
              value={filters.from}
            />

            <s-text-field
              label="To"
              name="to"
              type="datetime-local"
              value={filters.to}
            />

            <s-button
              type="submit"
              variant="primary"
            >
              Search
            </s-button>

            {(filters.from || filters.to) && (
              <s-button
                href="?"
                variant="secondary"
              >
                Clear
              </s-button>
            )}
          </s-stack>
        </Form>
      </s-section>

      {/* Results */}
      <s-section
        heading={`Transactions (${logs.length})`}
      >
        {logs.length === 0 ? (
          <s-empty-state heading="No shipping rate logs found">
            <s-paragraph>
              No shipping requests were found for
              the selected date and time range.
            </s-paragraph>
          </s-empty-state>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">
                Date / Time
              </s-table-header>

              <s-table-header>
                Destination
              </s-table-header>

              <s-table-header>
                Weight
              </s-table-header>

              <s-table-header>
                Items
              </s-table-header>

              <s-table-header>
                Provider
              </s-table-header>

              <s-table-header>
                Quotes
              </s-table-header>

              <s-table-header>
                Returned
              </s-table-header>

              <s-table-header>
                HTTP
              </s-table-header>

              <s-table-header>
                Status
              </s-table-header>

              <s-table-header>
                Duration
              </s-table-header>

              <s-table-header>
                Details
              </s-table-header>
            </s-table-header-row>

            <s-table-body>
              {logs.map((log) => (
                <ShippingLogRow
                  key={log.id}
                  log={log}
                />
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

interface ShippingLogRowProps {
  log: ShippingLog;
}

function ShippingLogRow({
  log,
}: ShippingLogRowProps) {
  const destination = [
    log.destinationCity,
    log.destinationState,
    log.destinationPostcode,
    log.destinationCountry,
  ]
    .filter(Boolean)
    .join(", ");

  const modalId = `shipping-log-${log.id}`;

  return (
    <s-table-row>
      {/* Date */}
      <s-table-cell>
        <s-text>
          {formatDate(log.createdAt)}
        </s-text>

        {log.requestId && (
          <s-text tone="subdued">
            ID: {log.requestId.substring(0, 18)}...
          </s-text>
        )}
      </s-table-cell>

      {/* Destination */}
      <s-table-cell>
        {destination || "-"}
      </s-table-cell>

      {/* Weight */}
      <s-table-cell>
        {formatWeight(
          log.totalWeightGrams,
          log.totalWeightKg,
        )}
      </s-table-cell>

      {/* Items */}
      <s-table-cell>
        {log.itemCount ?? "-"}
      </s-table-cell>

      {/* Provider */}
      <s-table-cell>
        {log.provider || "-"}
      </s-table-cell>

      {/* Quotes */}
      <s-table-cell>
        {log.totalQuoteCount ?? 0}
      </s-table-cell>

      {/* Returned rates */}
      <s-table-cell>
        {log.returnedRateCount ?? 0}
      </s-table-cell>

      {/* HTTP */}
      <s-table-cell>
        {log.providerHttpStatus ?? "-"}
      </s-table-cell>

      {/* Status */}
      <s-table-cell>
        <s-badge tone={statusTone(log.status)}>
          {statusLabel(log.status)}
        </s-badge>
      </s-table-cell>

      {/* Duration */}
      <s-table-cell>
        {log.durationMs != null
          ? `${log.durationMs} ms`
          : "-"}
      </s-table-cell>

      {/* Details */}
      <s-table-cell>
        <s-button
          command="--show"
          commandFor={modalId}
        >
          View
        </s-button>

        <s-modal
          id={modalId}
          heading={`Shipping Request - ${formatDate(
            log.createdAt,
          )}`}
        >
          {/* Summary */}
          <s-section heading="Request Summary">
            <s-description-list>
              <s-description-list-item term="Date">
                {formatDate(log.createdAt)}
              </s-description-list-item>

              <s-description-list-item term="Status">
                <s-badge
                  tone={statusTone(log.status)}
                >
                  {statusLabel(log.status)}
                </s-badge>
              </s-description-list-item>

              <s-description-list-item term="Provider">
                {log.provider || "-"}
              </s-description-list-item>

              <s-description-list-item term="Currency">
                {log.currency || "-"}
              </s-description-list-item>

              <s-description-list-item term="Destination">
                {destination || "-"}
              </s-description-list-item>

              <s-description-list-item term="Weight">
                {formatWeight(
                  log.totalWeightGrams,
                  log.totalWeightKg,
                )}
              </s-description-list-item>

              <s-description-list-item term="Items">
                {log.itemCount ?? "-"}
              </s-description-list-item>

              <s-description-list-item term="Provider HTTP status">
                {log.providerHttpStatus ?? "-"}
              </s-description-list-item>

              <s-description-list-item term="Quotes received">
                {log.totalQuoteCount ?? 0}
              </s-description-list-item>

              <s-description-list-item term="Rates returned">
                {log.returnedRateCount ?? 0}
              </s-description-list-item>

              <s-description-list-item term="Duration">
                {log.durationMs != null
                  ? `${log.durationMs} ms`
                  : "-"}
              </s-description-list-item>

              <s-description-list-item term="Request ID">
                {log.requestId || "-"}
              </s-description-list-item>

              <s-description-list-item term="Checkout token">
                {log.checkoutToken || "-"}
              </s-description-list-item>
            </s-description-list>
          </s-section>

          {/* Error reason */}
          {log.errorMessage && (
            <s-section heading="Reason">
              <s-callout-banner tone="critical">
                {log.errorMessage}
              </s-callout-banner>
            </s-section>
          )}

          {/* Quote breakdown */}
          {log.quoteBreakdownJson && (
            <s-section heading="Quote Breakdown">
              <pre className="json-viewer">
                {prettyJson(
                  log.quoteBreakdownJson,
                )}
              </pre>
            </s-section>
          )}

          {/* Shopify request */}
          <s-section heading="Shopify Request">
            <pre className="json-viewer">
              {prettyJson(log.requestJson)}
            </pre>
          </s-section>

          {/* Cart items */}
          <s-section heading="Cart Items">
            <pre className="json-viewer">
              {prettyJson(log.itemsJson)}
            </pre>
          </s-section>

          {/* Provider request */}
          <s-section heading="Provider Request">
            <pre className="json-viewer">
              {prettyJson(
                log.providerRequestJson,
              )}
            </pre>
          </s-section>

          {/* Provider response */}
          <s-section heading="Provider Response">
            <pre className="json-viewer">
              {prettyJson(
                log.providerResponseJson,
              )}
            </pre>
          </s-section>

          {/* Returned rates */}
          <s-section heading="Returned Rates">
            <pre className="json-viewer">
              {prettyJson(
                log.returnedRatesJson,
              )}
            </pre>
          </s-section>

          <s-button
            slot="secondary-actions"
            command="--hide"
            commandFor={modalId}
          >
            Close
          </s-button>
        </s-modal>
      </s-table-cell>
    </s-table-row>
  );
}