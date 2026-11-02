import { useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useFetcher,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSearchParams,
} from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

// ---------- Constants ----------

const UNIT_OPTIONS = ["CENTIMETERS", "INCHES"] as const;

const PACKAGE_TYPE_OPTIONS = [
  "Carton",
  "Satchel/Bag",
  "Tube",
  "Skid",
  "Pallet",
  "Crate",
  "Flat Pack",
  "Roll",
  "Length",
  "Tyre/Wheel",
  "Envelope",
] as const;

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "draft", label: "Draft" },
  { value: "archived", label: "Archived" },
] as const;

const DIMENSION_OPTIONS = [
  { value: "all", label: "All variants" },
  { value: "missing", label: "Missing dimensions" },
  { value: "complete", label: "Dimensions complete" },
] as const;

type StatusFilter = (typeof STATUS_OPTIONS)[number]["value"];
type DimensionFilter = (typeof DIMENSION_OPTIONS)[number]["value"];

const PAGE_SIZE = 10;

// When filtering by dimensions we can't ask Shopify (the data lives in our DB),
// so we keep pulling Shopify pages until we've collected PAGE_SIZE matching
// products. This caps how many Shopify pages one request will scan.
const MAX_SCANS = 8;

// Shopify variant gids look like "gid://shopify/ProductVariant/123";
// VariantPackage.variantId is stored as the bare numeric id ("123").
function toNumericVariantId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

// weightKg/length/width/height can come back from Prisma as a Decimal
// (not a plain number) depending on the column type. Coerce safely to a
// display string instead of interpolating the object directly.
function toDisplayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  return String(value);
}

// A dimension counts as missing if it's empty, not a number, or zero/negative.
function isMissingValue(value: string): boolean {
  if (value === "") {
    return true;
  }

  return !(Number(value) > 0);
}

function hasMissingDimensions(row: {
  id: string | null;
  weightKg: string;
  length: string;
  width: string;
  height: string;
}): boolean {
  // No saved row at all means nothing has been entered yet.
  if (!row.id) {
    return true;
  }

  return [row.weightKg, row.length, row.width, row.height].some(
    isMissingValue,
  );
}

// Builds the Shopify product search string from the filters.
// Each search word must match the product title OR any variant SKU.
function buildShopifyQuery(
  searchTerm: string,
  status: StatusFilter,
): string | null {
  const parts: string[] = [];

  const words = searchTerm
    .split(/\s+/)
    .map((word) => word.replace(/["():\\*]/g, ""))
    .filter(Boolean);

  for (const word of words) {
    parts.push(`(title:*${word}* OR sku:${word}*)`);
  }

  if (status !== "all") {
    parts.push(`status:${status}`);
  }

  return parts.length > 0 ? parts.join(" AND ") : null;
}

type AdminClient = Awaited<ReturnType<typeof authenticate.admin>>["admin"];

async function fetchProductsPage(
  admin: AdminClient,
  options: {
    query: string | null;
    cursor: string | null;
    direction: "next" | "prev";
  },
) {
  const variables: Record<string, unknown> = { query: options.query };

  if (options.direction === "prev" && options.cursor) {
    variables.last = PAGE_SIZE;
    variables.before = options.cursor;
  } else {
    variables.first = PAGE_SIZE;
    variables.after = options.cursor;
  }

  const response = await admin.graphql(
    `#graphql
    query VariantPackagesList(
      $first: Int
      $after: String
      $last: Int
      $before: String
      $query: String
    ) {
      products(
        first: $first
        after: $after
        last: $last
        before: $before
        sortKey: CREATED_AT
        reverse: true
        query: $query
      ) {
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
        edges {
          node {
            id
            title
            status
            createdAt

            variants(first: 100) {
              edges {
                node {
                  id
                  title
                  sku
                  createdAt
                }
              }
            }
          }
        }
      }
    }`,
    { variables },
  );

  const json = await response.json();
  const connection = json.data?.products;

  return {
    edges: (connection?.edges ?? []) as Array<{ node: any }>,
    pageInfo: (connection?.pageInfo ?? {
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    }) as {
      hasNextPage: boolean;
      hasPreviousPage: boolean;
      startCursor: string | null;
      endCursor: string | null;
    },
  };
}

// Turns raw Shopify product edges into UI rows, merged with saved packages.
async function buildProducts(
  edges: Array<{ node: any }>,
  shop: string,
) {
  // Collect every variant's numeric id so existing packages for just THIS
  // page can be fetched in one query.
  const allNumericVariantIds: string[] = [];

  for (const { node: product } of edges) {
    for (const { node: variant } of product.variants.edges) {
      allNumericVariantIds.push(toNumericVariantId(variant.id));
    }
  }

  const existingPackages =
    allNumericVariantIds.length > 0
      ? await prisma.variantPackage.findMany({
          where: {
            shop,
            variantId: { in: allNumericVariantIds },
          },
          orderBy: { updatedAt: "asc" },
        })
      : [];

  // One package row per variant — if a variant somehow has more than one
  // saved row, the most recently updated one wins.
  const packageByVariant = new Map<string, (typeof existingPackages)[number]>();

  for (const pkg of existingPackages) {
    packageByVariant.set(pkg.variantId, pkg);
  }

  return edges.map(({ node: product }) => {
    const variants = product.variants.edges
      .map(({ node: variant }: any) => {
        const numericVariantId = toNumericVariantId(variant.id);
        const pkg = packageByVariant.get(numericVariantId);

        const row = pkg
          ? {
              id: pkg.id as string | null,
              variantId: pkg.variantId,
              packageType: pkg.packageType ?? "",
              weightKg: toDisplayValue(pkg.weightKg),
              length: toDisplayValue(pkg.length),
              width: toDisplayValue(pkg.width),
              height: toDisplayValue(pkg.height),
              unit: pkg.unit as string,
            }
          : {
              id: null as string | null,
              variantId: numericVariantId,
              packageType: "",
              weightKg: "",
              length: "",
              width: "",
              height: "",
              unit: UNIT_OPTIONS[0] as string,
            };

        return {
          id: variant.id as string,
          numericVariantId,
          title: variant.title as string,
          sku: variant.sku as string | null,
          createdAt: variant.createdAt as string | null,
          missingDimensions: hasMissingDimensions(row),
          package: row,
        };
      })
      .sort((a: any, b: any) => {
        if (!a.createdAt || !b.createdAt) {
          return 0;
        }

        return (
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      });

    return {
      id: product.id as string,
      title: product.title as string,
      status: product.status as string,
      createdAt: product.createdAt as string,
      variants: variants as Array<{
        id: string;
        numericVariantId: string;
        title: string;
        sku: string | null;
        createdAt: string | null;
        missingDimensions: boolean;
        package: {
          id: string | null;
          variantId: string;
          packageType: string;
          weightKg: string;
          length: string;
          width: string;
          height: string;
          unit: string;
        };
      }>,
    };
  });
}

// ---------- Loader ----------

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const searchTerm = url.searchParams.get("q")?.trim() ?? "";
  const cursor = url.searchParams.get("cursor") || null;
  const direction =
    url.searchParams.get("direction") === "prev" ? "prev" : "next";

  const rawStatus = url.searchParams.get("status");
  const status: StatusFilter = STATUS_OPTIONS.some((o) => o.value === rawStatus)
    ? (rawStatus as StatusFilter)
    : "all";

  const rawDimensions = url.searchParams.get("dimensions");
  const dimensionFilter: DimensionFilter = DIMENSION_OPTIONS.some(
    (o) => o.value === rawDimensions,
  )
    ? (rawDimensions as DimensionFilter)
    : "all";

  const queryFilter = buildShopifyQuery(searchTerm, status);
  const needsDimensionScan = dimensionFilter !== "all";
  const maxScans = needsDimensionScan ? MAX_SCANS : 1;

  const pageInfos: Array<Awaited<ReturnType<typeof fetchProductsPage>>["pageInfo"]> = [];
  let products: Awaited<ReturnType<typeof buildProducts>> = [];
  let nextCursor = cursor;
  let exhausted = false;

  for (let scan = 0; scan < maxScans; scan++) {
    const page = await fetchProductsPage(admin, {
      query: queryFilter,
      cursor: nextCursor,
      direction,
    });

    pageInfos.push(page.pageInfo);

    const built = await buildProducts(page.edges, session.shop);

    // Keep only the variants that match the dimension filter, and drop
    // products left with no variants.
    const filtered = built
      .map((product) => ({
        ...product,
        variants: product.variants.filter((variant) => {
          if (dimensionFilter === "missing") return variant.missingDimensions;
          if (dimensionFilter === "complete") return !variant.missingDimensions;
          return true;
        }),
      }))
      .filter((product) => product.variants.length > 0);

    // Walking backwards? Earlier pages go on top.
    products =
      direction === "prev" ? [...filtered, ...products] : [...products, ...filtered];

    const hasMore =
      direction === "prev"
        ? page.pageInfo.hasPreviousPage
        : page.pageInfo.hasNextPage;

    nextCursor =
      direction === "prev" ? page.pageInfo.startCursor : page.pageInfo.endCursor;

    if (!hasMore) {
      exhausted = true;
      break;
    }

    if (products.length >= PAGE_SIZE) {
      break;
    }
  }

  // Stitch the scanned pages back into a single pageInfo.
  const firstFetched = pageInfos[0];
  const lastFetched = pageInfos[pageInfos.length - 1];

  const pageInfo =
    direction === "prev"
      ? {
          hasNextPage: firstFetched.hasNextPage,
          hasPreviousPage: lastFetched.hasPreviousPage,
          startCursor: lastFetched.startCursor,
          endCursor: firstFetched.endCursor,
        }
      : {
          hasNextPage: lastFetched.hasNextPage,
          hasPreviousPage: firstFetched.hasPreviousPage,
          startCursor: firstFetched.startCursor,
          endCursor: lastFetched.endCursor,
        };

  return {
    products,
    pageInfo,
    searchTerm,
    status,
    dimensionFilter,
    // True when we stopped scanning before finding a full page of matches.
    scanLimitReached:
      needsDimensionScan && !exhausted && products.length < PAGE_SIZE,
  };
}

type LoaderData = Awaited<ReturnType<typeof loader>>;

type ProductGroup = LoaderData["products"][number];

type VariantRow = ProductGroup["variants"][number];

// ---------- Action ----------

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "save") {
    const id = formData.get("id") as string | null;
    const variantId = formData.get("variantId") as string;
    const packageType = formData.get("packageType") as string;
    const unit = formData.get("unit") as string;

    const weightKg = parseNumber(formData.get("weightKg"));
    const length = parseNumber(formData.get("length"));
    const width = parseNumber(formData.get("width"));
    const height = parseNumber(formData.get("height"));

    const data = {
      shop: session.shop,
      variantId,
      packageType,
      unit,
      weightKg,
      length,
      width,
      height,
    };

    const saved =
      id && id !== "new"
        ? await prisma.variantPackage.update({
            where: { id },
            data,
          })
        : await prisma.variantPackage.create({ data });

    return { ok: true, package: saved };
  }

  throw new Response("Unknown intent", { status: 400 });
}

function parseNumber(value: FormDataEntryValue | null): number | null {
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number(value);

  return Number.isNaN(parsed) ? null : parsed;
}

// ---------- UI ----------

function statusTone(status: string): "success" | "caution" | "neutral" {
  if (status === "ACTIVE") return "success";
  if (status === "DRAFT") return "caution";
  return "neutral";
}

function statusLabel(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

export default function VariantPackagesPage() {
  const {
    products,
    pageInfo,
    searchTerm,
    status,
    dimensionFilter,
    scanLimitReached,
  } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  const hasActiveFilters =
    searchTerm !== "" || status !== "all" || dimensionFilter !== "all";

  // Pagination keeps q / status / dimensions because it copies the
  // current search params.
  function goToPage(direction: "next" | "prev") {
    const params = new URLSearchParams(searchParams);

    if (direction === "next" && pageInfo.endCursor) {
      params.set("cursor", pageInfo.endCursor);
      params.set("direction", "next");
    } else if (direction === "prev" && pageInfo.startCursor) {
      params.set("cursor", pageInfo.startCursor);
      params.set("direction", "prev");
    }

    navigate(`?${params.toString()}`);
  }

  function emptyMessage(): string {
    if (!hasActiveFilters) {
      return "No products were returned from the store.";
    }

    const parts: string[] = [];

    if (searchTerm) parts.push(`matching "${searchTerm}"`);
    if (status !== "all") parts.push(`with status ${status}`);
    if (dimensionFilter === "missing") parts.push("with missing dimensions");
    if (dimensionFilter === "complete") parts.push("with complete dimensions");

    return `No products ${parts.join(", ")}.`;
  }

  return (
    <s-page heading="Variant Packages">
      {/* ---- Search + filters ---- */}
      <s-section heading="Search and filter">
        <Form method="get">
          <s-stack gap="base">
            <s-grid
              gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))"
              gap="base"
            >
              <s-text-field
                type="search"
                name="q"
                label="Search"
                placeholder="Product title or SKU…"
                defaultValue={searchTerm}
              />

              <s-select name="status" label="Status" value={status}>
                {STATUS_OPTIONS.map((option) => (
                  <s-option key={option.value} value={option.value}>
                    {option.label}
                  </s-option>
                ))}
              </s-select>

              <s-select
                name="dimensions"
                label="Dimensions"
                value={dimensionFilter}
              >
                {DIMENSION_OPTIONS.map((option) => (
                  <s-option key={option.value} value={option.value}>
                    {option.label}
                  </s-option>
                ))}
              </s-select>
            </s-grid>

            <s-stack direction="inline" gap="base">
              <s-button type="submit" variant="primary">
                Apply
              </s-button>

              {hasActiveFilters && (
                <s-button type="button" onClick={() => navigate("?")}>
                  Clear filters
                </s-button>
              )}
            </s-stack>
          </s-stack>
        </Form>
      </s-section>

      {products.length === 0 ? (
        <s-section>
          <s-empty-state heading="No products found">
            <s-paragraph>
              {scanLimitReached
                ? "None of the products checked so far matched. Select Next to keep looking."
                : emptyMessage()}
            </s-paragraph>
          </s-empty-state>
        </s-section>
      ) : (
        products.map((product) => (
          <ProductSection key={product.id} product={product} />
        ))
      )}

      <s-section>
        <s-stack direction="inline" gap="base" alignment="center">
          <s-button
            disabled={!pageInfo.hasPreviousPage || isLoading}
            onClick={() => goToPage("prev")}
          >
            Previous
          </s-button>
          <s-button
            disabled={!pageInfo.hasNextPage || isLoading}
            onClick={() => goToPage("next")}
          >
            Next
          </s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}

interface ProductSectionProps {
  product: ProductGroup;
}

function ProductSection({ product }: ProductSectionProps) {
  return (
    <s-section heading={product.title}>
      <s-stack gap="base">
        <s-stack direction="inline" gap="small">
          <s-badge tone={statusTone(product.status)}>
            {statusLabel(product.status)}
          </s-badge>
        </s-stack>

        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Variant</s-table-header>

            <s-table-header>Package type</s-table-header>

            <s-table-header>Weight (kg)</s-table-header>

            <s-table-header>Length</s-table-header>

            <s-table-header>Width</s-table-header>

            <s-table-header>Height</s-table-header>

            <s-table-header>Unit</s-table-header>

            <s-table-header>Action</s-table-header>
          </s-table-header-row>

          <s-table-body>
            {product.variants.map((variant) => (
              <PackageRowItem key={variant.id} variant={variant} />
            ))}
          </s-table-body>
        </s-table>
      </s-stack>
    </s-section>
  );
}

interface PackageRowItemProps {
  variant: VariantRow;
}

function PackageRowItem({ variant }: PackageRowItemProps) {
  const saveFetcher = useFetcher();
  const pkg = variant.package;

  const [fields, setFields] = useState({
    packageType: pkg.packageType,
    weightKg: pkg.weightKg,
    length: pkg.length,
    width: pkg.width,
    height: pkg.height,
    unit: pkg.unit,
  });

  const saving = saveFetcher.state !== "idle";

  function update(field: keyof typeof fields) {
    return (event: any) => {
      setFields((prev) => ({
        ...prev,
        [field]: event.target.value,
      }));
    };
  }

  function handleSave() {
    saveFetcher.submit(
      {
        intent: "save",
        id: pkg.id ?? "new",
        variantId: variant.numericVariantId,
        ...fields,
      },
      { method: "post" },
    );
  }

  return (
    <s-table-row>
      <s-table-cell>
        <s-stack gap="small">
          <s-text fontWeight="bold">{variant.title}</s-text>

          {variant.sku && <s-text tone="neutral">SKU: {variant.sku}</s-text>}

          {variant.missingDimensions && (
            <s-badge tone="warning">Missing dimensions</s-badge>
          )}
        </s-stack>
      </s-table-cell>

      <s-table-cell>
        <s-select
          value={fields.packageType}
          onChange={update("packageType")}
        >
          <s-option value="">Select…</s-option>

          {PACKAGE_TYPE_OPTIONS.map((option) => (
            <s-option key={option} value={option}>
              {option}
            </s-option>
          ))}
        </s-select>
      </s-table-cell>

      <s-table-cell>
        <s-text-field
          type="number"
          step="0.01"
          value={fields.weightKg}
          onChange={update("weightKg")}
        />
      </s-table-cell>

      <s-table-cell>
        <s-text-field
          type="number"
          step="0.1"
          value={fields.length}
          onChange={update("length")}
        />
      </s-table-cell>

      <s-table-cell>
        <s-text-field
          type="number"
          step="0.1"
          value={fields.width}
          onChange={update("width")}
        />
      </s-table-cell>

      <s-table-cell>
        <s-text-field
          type="number"
          step="0.1"
          value={fields.height}
          onChange={update("height")}
        />
      </s-table-cell>

      <s-table-cell>
        <s-select value={fields.unit} onChange={update("unit")}>
          {UNIT_OPTIONS.map((option) => (
            <s-option key={option} value={option}>
              {option}
            </s-option>
          ))}
        </s-select>
      </s-table-cell>

      <s-table-cell>
        <s-button
          variant="primary"
          loading={saving || undefined}
          onClick={handleSave}
        >
          Save
        </s-button>
      </s-table-cell>
    </s-table-row>
  );
}