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

const PAGE_SIZE = 10;

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

// ---------- Loader ----------

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const searchTerm = url.searchParams.get("q")?.trim() ?? "";
  const cursor = url.searchParams.get("cursor") || null;
  const direction =
    url.searchParams.get("direction") === "prev" ? "prev" : "next";

  // Shopify search syntax: wrap in wildcards to match anywhere in the title.
  const queryFilter = searchTerm ? `title:*${searchTerm}*` : null;

  const variables: Record<string, unknown> = { query: queryFilter };

  if (direction === "prev" && cursor) {
    variables.last = PAGE_SIZE;
    variables.before = cursor;
  } else {
    variables.first = PAGE_SIZE;
    variables.after = cursor;
  }

  const productsResponse = await admin.graphql(
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

  const productsJson = await productsResponse.json();

  const productsConnection = productsJson.data?.products;
  const productEdges: Array<{ node: any }> = productsConnection?.edges ?? [];
  const pageInfo = productsConnection?.pageInfo ?? {
    hasNextPage: false,
    hasPreviousPage: false,
    startCursor: null,
    endCursor: null,
  };

  // Collect every variant's numeric id (matching how VariantPackage.variantId
  // is stored) so existing packages for just THIS page can be fetched in one
  // query — this is what keeps the page fast even on large catalogues.
  const allNumericVariantIds: string[] = [];

  for (const { node: product } of productEdges) {
    for (const { node: variant } of product.variants.edges) {
      allNumericVariantIds.push(toNumericVariantId(variant.id));
    }
  }

  const existingPackages = await prisma.variantPackage.findMany({
    where: {
      shop: session.shop,
      variantId: { in: allNumericVariantIds },
    },
    orderBy: {
      updatedAt: "asc",
    },
  });

  // ---- TEMP DEBUG: delete this block once the mismatch is found ----
  const debugTotalPackageRows = await prisma.variantPackage.count();
  const debugSamplePackages = await prisma.variantPackage.findMany({
    take: 5,
    select: { id: true, shop: true, variantId: true, packageType: true },
  });
  const debugSampleShopifyVariantIds = allNumericVariantIds.slice(0, 5);
  const debugCurrentShop = session.shop;
  // ---- END TEMP DEBUG ----

  // One package row per variant — if a variant somehow has more than one
  // saved row, the most recently updated one wins (findMany above is
  // ordered asc, so later entries overwrite earlier ones in the map).
  const packageByVariant = new Map<string, (typeof existingPackages)[number]>();

  for (const pkg of existingPackages) {
    packageByVariant.set(pkg.variantId, pkg);
  }

  const products = productEdges.map(({ node: product }) => {
    const variants = product.variants.edges
      .map(({ node: variant }: any) => {
        const numericVariantId = toNumericVariantId(variant.id);
        const pkg = packageByVariant.get(numericVariantId);

        const row = pkg
          ? {
              id: pkg.id,
              variantId: pkg.variantId,
              packageType: pkg.packageType,
              weightKg: toDisplayValue(pkg.weightKg),
              length: toDisplayValue(pkg.length),
              width: toDisplayValue(pkg.width),
              height: toDisplayValue(pkg.height),
              unit: pkg.unit,
            }
          : {
              id: null,
              variantId: numericVariantId,
              packageType: "",
              weightKg: "",
              length: "",
              width: "",
              height: "",
              unit: UNIT_OPTIONS[0] as string,
            };

        return {
          id: variant.id,
          numericVariantId,
          title: variant.title,
          sku: variant.sku,
          createdAt: variant.createdAt as string | null,
          package: row,
        };
      })
      .sort((a: any, b: any) => {
        if (!a.createdAt || !b.createdAt) {
          return 0;
        }

        return (
          new Date(b.createdAt).getTime() -
          new Date(a.createdAt).getTime()
        );
      });

    return {
      id: product.id,
      title: product.title,
      createdAt: product.createdAt as string,
      variants,
    };
  });

  return {
    products,
    pageInfo,
    searchTerm,
    debug: {
      currentShop: debugCurrentShop,
      totalPackageRowsInTable: debugTotalPackageRows,
      samplePackages: debugSamplePackages,
      sampleShopifyVariantIds: debugSampleShopifyVariantIds,
      matchedCount: existingPackages.length,
      totalVariantsFetched: allNumericVariantIds.length,
    },
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

export default function VariantPackagesPage() {
  const { products, pageInfo, searchTerm, debug } =
    useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

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

  return (
    <s-page heading="Variant Packages">
      {/* ---- TEMP DEBUG: delete this s-section once sorted ---- */}
      {/* ---- END TEMP DEBUG --- <s-section heading="Debug: id matching">
        <s-paragraph>
          Current shop: {debug.currentShop} · Total rows in
          VariantPackage table (all shops): {debug.totalPackageRowsInTable}
          · Variants fetched this page: {debug.totalVariantsFetched}
          · Matched packages: {debug.matchedCount}
        </s-paragraph>

        <s-paragraph>
          Sample Shopify variant ids (numeric):{" "}
          {debug.sampleShopifyVariantIds.join(", ") || "(none)"}
        </s-paragraph>

        <s-paragraph>
          Sample VariantPackage rows in DB (any shop):{" "}
          {debug.samplePackages
            .map(
              (p) =>
                `[shop=${p.shop} variantId=${p.variantId} type=${p.packageType}]`,
            )
            .join(", ") || "(table is empty)"}
        </s-paragraph>
      </s-section>
     - */}

      <s-section heading="Search">
        <Form method="get">
          <s-text-field
            type="search"
            name="q"
            label="Search products"
            labelHidden
            placeholder="Search by product title…"
            defaultValue={searchTerm}
          />
          <s-button type="submit" variant="primary">
            Search
          </s-button>
        </Form>
      </s-section>

      {products.length === 0 ? (
        <s-section>
          <s-empty-state heading="No products found">
            <s-paragraph>
              {searchTerm
                ? `No products match "${searchTerm}".`
                : "No products were returned from the store."}
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
        <s-text fontWeight="bold">{variant.title}</s-text>

        {variant.sku && (
          <s-text tone="subdued">SKU: {variant.sku}</s-text>
        )}
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