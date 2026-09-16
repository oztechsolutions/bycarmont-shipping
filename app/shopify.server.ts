import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

const SHIPPING_SERVICE_NAME = "CCS";
export const CCS_REQUIRED_MESSAGE =
  "Carrier Calculated Shipping must be enabled for this store before CCS can be registered.";

type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

type GraphQLResult<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

type UserError = { field?: string[] | null; message: string };

function isCcsRequiredError(userErrors: UserError[]) {
  return userErrors.some((error) =>
    error.message.toLowerCase().includes("carrier calculated shipping must be enabled"),
  );
}

/** Parses a GraphQL Response, logging (rather than throwing on) malformed JSON. */
async function parseGraphQLResponse<T>(
  response: Response,
  context: string,
): Promise<GraphQLResult<T> | null> {
  try {
    const json = (await response.json()) as GraphQLResult<T>;
    if (json.errors?.length) {
      console.error(`[registerTestShippingService] GraphQL errors during ${context}:`, json.errors);
    }
    return json;
  } catch (err) {
    console.error(
      `[registerTestShippingService] Failed to parse GraphQL response during ${context}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Wraps a Prisma call so a DB failure is logged clearly instead of throwing out of the auth hook. */
async function safePrismaCall<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(
      `[registerTestShippingService] Database call failed (${label}). ` +
        `If this is the first time you're seeing this, check that the ShippingRegistration ` +
        `model exists in schema.prisma and that you've run "npx prisma migrate dev" / "npx prisma generate".`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function registerTestShippingService(
  admin: AdminClient,
  shop: string,
  force = false,
) {
  const registration = await safePrismaCall("findUnique", () =>
    prisma.shippingRegistration.findUnique({ where: { shop } }),
  );

  if (registration?.ccsRequired && !force) {
    return { ccsRequired: true, message: registration.message ?? CCS_REQUIRED_MESSAGE };
  }

  const appUrl = process.env.SHOPIFY_APP_URL;
  if (!appUrl) {
    console.error("[registerTestShippingService] Cannot register CCS: SHOPIFY_APP_URL is not set");
    return { ccsRequired: false };
  }

  const callbackUrl = new URL("/api/shipping-rates", appUrl).toString();

  type CarrierServiceNode = {
    id: string;
    name: string;
    active: boolean;
    callbackUrl: string;
  };

  let existingResponse: Response;
  try {
    existingResponse = await admin.graphql(`#graphql
      query TestShippingCarrierService {
        carrierServices(first: 25) {
          nodes {
            id
            name
            active
            callbackUrl
          }
        }
      }
    `);
  } catch (err) {
    console.error(
      "[registerTestShippingService] GraphQL request failed while listing carrier services:",
      err instanceof Error ? err.message : err,
    );
    return { ccsRequired: false };
  }

  const existingData = await parseGraphQLResponse<{
    carrierServices: { nodes: CarrierServiceNode[] };
  }>(existingResponse, "listing carrier services");

  const existingService = existingData?.data?.carrierServices?.nodes?.find(
    (service) => service.name === SHIPPING_SERVICE_NAME,
  );

  if (existingService) {
    if (!existingService.active || existingService.callbackUrl !== callbackUrl) {
      let updateResponse: Response;
      try {
        updateResponse = await admin.graphql(
          `#graphql
          mutation UpdateTestShippingCarrierService($input: DeliveryCarrierServiceUpdateInput!) {
            carrierServiceUpdate(input: $input) {
              carrierService {
                id
                active
                callbackUrl
              }
              userErrors {
                field
                message
              }
            }
          }`,
          {
            variables: {
              input: {
                id: existingService.id,
                callbackUrl,
                active: true,
              },
            },
          },
        );
      } catch (err) {
        console.error(
          "[registerTestShippingService] GraphQL request failed while updating carrier service:",
          err instanceof Error ? err.message : err,
        );
        return { ccsRequired: false };
      }

      const updateData = await parseGraphQLResponse<{
        carrierServiceUpdate: { userErrors: UserError[] };
      }>(updateResponse, "updating carrier service");

      const updateErrors = updateData?.data?.carrierServiceUpdate?.userErrors ?? [];
      if (updateErrors.length > 0) {
        console.error("[registerTestShippingService] Failed to update CCS:", updateErrors);

        if (isCcsRequiredError(updateErrors)) {
          await safePrismaCall("upsert (update path, ccs required)", () =>
            prisma.shippingRegistration.upsert({
              where: { shop },
              update: { ccsRequired: true, message: CCS_REQUIRED_MESSAGE },
              create: { shop, ccsRequired: true, message: CCS_REQUIRED_MESSAGE },
            }),
          );
          return { ccsRequired: true, message: CCS_REQUIRED_MESSAGE };
        }

        // Some other error occurred — do NOT mark this as a success.
        return { ccsRequired: false, message: "Failed to update carrier service. Check server logs." };
      }
    }

    await safePrismaCall("upsert (update path, success)", () =>
      prisma.shippingRegistration.upsert({
        where: { shop },
        update: { ccsRequired: false, message: null },
        create: { shop, ccsRequired: false },
      }),
    );
    return { ccsRequired: false };
  }

  let createResponse: Response;
  try {
    createResponse = await admin.graphql(
      `#graphql
      mutation CreateTestShippingCarrierService($input: DeliveryCarrierServiceCreateInput!) {
        carrierServiceCreate(input: $input) {
          carrierService {
            id
            name
            active
            callbackUrl
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          input: {
            name: SHIPPING_SERVICE_NAME,
            callbackUrl,
            supportsServiceDiscovery: true,
            active: true,
          },
        },
      },
    );
  } catch (err) {
    console.error(
      "[registerTestShippingService] GraphQL request failed while creating carrier service:",
      err instanceof Error ? err.message : err,
    );
    return { ccsRequired: false };
  }

  const createData = await parseGraphQLResponse<{
    carrierServiceCreate: { userErrors: UserError[] };
  }>(createResponse, "creating carrier service");

  const createErrors = createData?.data?.carrierServiceCreate?.userErrors ?? [];

  if (createErrors.length > 0) {
    console.error("[registerTestShippingService] Failed to register CCS:", createErrors);

    if (isCcsRequiredError(createErrors)) {
      await safePrismaCall("upsert (create path, ccs required)", () =>
        prisma.shippingRegistration.upsert({
          where: { shop },
          update: { ccsRequired: true, message: CCS_REQUIRED_MESSAGE },
          create: { shop, ccsRequired: true, message: CCS_REQUIRED_MESSAGE },
        }),
      );
      return { ccsRequired: true, message: CCS_REQUIRED_MESSAGE };
    }

    // Some other error occurred (bad input, permissions, etc.) — do NOT
    // fall through and mark this as a success in the database.
    return { ccsRequired: false, message: "Failed to create carrier service. Check server logs." };
  }

  await safePrismaCall("upsert (create path, success)", () =>
    prisma.shippingRegistration.upsert({
      where: { shop },
      update: { ccsRequired: false, message: null },
      create: { shop, ccsRequired: false },
    }),
  );
  return { ccsRequired: false };
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    afterAuth: async ({ admin, session }) => {
      try {
        await registerTestShippingService(admin, session.shop);
      } catch (err) {
        // Belt-and-suspenders: registerTestShippingService already catches
        // its own errors, but if something unexpected still throws here we
        // don't want it to break the rest of the OAuth callback.
        console.error("[afterAuth] registerTestShippingService threw unexpectedly:", err);
      }
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;