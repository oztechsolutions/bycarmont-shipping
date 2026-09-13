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

function isCcsRequiredError(userErrors: Array<{ message: string }>) {
  return userErrors.some((error) =>
    error.message.toLowerCase().includes("carrier calculated shipping must be enabled"),
  );
}

export async function registerTestShippingService(
  admin: AdminClient,
  shop: string,
  force = false,
) {
  const registration = await prisma.shippingRegistration.findUnique({
    where: { shop },
  });
  if (registration?.ccsRequired && !force) {
    return { ccsRequired: true, message: registration.message ?? CCS_REQUIRED_MESSAGE };
  }

  const appUrl = process.env.SHOPIFY_APP_URL;
  if (!appUrl) {
    console.error("Cannot register CCS: SHOPIFY_APP_URL is not set");
    return { ccsRequired: false };
  }

  const callbackUrl = new URL("/api/shipping-rates", appUrl).toString();
  const existingResponse = await admin.graphql(`#graphql
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
  const existingData = await existingResponse.json();
  const existingService = existingData.data?.carrierServices?.nodes?.find(
    (service: { name: string }) => service.name === SHIPPING_SERVICE_NAME,
  );

  if (existingService) {
    if (!existingService.active || existingService.callbackUrl !== callbackUrl) {
      await admin.graphql(`#graphql
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
        }
      `, {
        variables: {
          input: {
            id: existingService.id,
            callbackUrl,
            active: true,
          },
        },
      });
    }
    await prisma.shippingRegistration.upsert({
      where: { shop },
      update: { ccsRequired: false, message: null },
      create: { shop, ccsRequired: false },
    });
    return;
  }

  const createResponse = await admin.graphql(`#graphql
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
    }
  `, {
    variables: {
      input: {
        name: SHIPPING_SERVICE_NAME,
        callbackUrl,
        supportsServiceDiscovery: true,
        active: true,
      },
    },
  });
  const createData = await createResponse.json();
  const userErrors = createData.data?.carrierServiceCreate?.userErrors ?? [];

  if (userErrors.length > 0) {
    console.error("Failed to register CCS:", userErrors);
    if (isCcsRequiredError(userErrors)) {
      await prisma.shippingRegistration.upsert({
        where: { shop },
        update: { ccsRequired: true, message: CCS_REQUIRED_MESSAGE },
        create: { shop, ccsRequired: true, message: CCS_REQUIRED_MESSAGE },
      });
      return { ccsRequired: true, message: CCS_REQUIRED_MESSAGE };
    }
  }

  await prisma.shippingRegistration.upsert({
    where: { shop },
    update: { ccsRequired: false, message: null },
    create: { shop, ccsRequired: false },
  });
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
      await registerTestShippingService(admin, session.shop);
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
