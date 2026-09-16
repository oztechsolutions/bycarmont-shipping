import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// Keep this name stable — it's how we find the existing carrier service to
// update, rather than accidentally creating duplicates on every auth.
const CARRIER_SERVICE_NAME = "BYC Fast Courier Shipping";

/**
 * Ensures a Carrier Service pointing at this app's shipping-rates endpoint
 * exists and is up to date. Safe to call every time the app authenticates —
 * if a service with CARRIER_SERVICE_NAME already exists it updates the
 * callback_url (handles dev tunnel URLs changing between sessions); if not,
 * it creates one.
 */
export async function registerCarrierService(admin: AdminApiContext) {
  const appUrl = process.env.SHOPIFY_APP_URL;

  if (!appUrl) {
    console.error("SHOPIFY_APP_URL is not set — skipping carrier service registration");
    return;
  }

  const callbackUrl = `${appUrl}/api/shipping-rates`;

  const existing = await admin.graphql(
    `#graphql
    query FindCarrierService {
      carrierServices(first: 10) {
        edges {
          node {
            id
            name
            callbackUrl
          }
        }
      }
    }`,
  );

  const existingJson = await existing.json();
  const services = existingJson.data?.carrierServices?.edges ?? [];
  const match = services.find(
    (edge: { node: { name: string } }) => edge.node.name === CARRIER_SERVICE_NAME,
  );

  if (match) {
    if (match.node.callbackUrl === callbackUrl) {
      // Already pointing at the right URL — nothing to do.
      return;
    }

    const updateResponse = await admin.graphql(
      `#graphql
      mutation UpdateCarrierService($id: ID!, $callbackUrl: URL!) {
        carrierServiceUpdate(id: $id, carrierService: { callbackUrl: $callbackUrl }) {
          carrierService {
            id
            callbackUrl
          }
          userErrors {
            field
            message
          }
        }
      }`,
      { variables: { id: match.node.id, callbackUrl } },
    );

    const updateJson = await updateResponse.json();
    const userErrors = updateJson.data?.carrierServiceUpdate?.userErrors ?? [];

    if (userErrors.length) {
      console.error("Failed to update carrier service:", userErrors);
    } else {
      console.log(`Carrier service callback URL updated to ${callbackUrl}`);
    }

    return;
  }

  const createResponse = await admin.graphql(
    `#graphql
    mutation CreateCarrierService($name: String!, $callbackUrl: URL!) {
      carrierServiceCreate(
        carrierService: {
          name: $name
          callbackUrl: $callbackUrl
          supportsServiceDiscovery: true
          active: true
        }
      ) {
        carrierService {
          id
          callbackUrl
        }
        userErrors {
          field
          message
        }
      }
    }`,
    { variables: { name: CARRIER_SERVICE_NAME, callbackUrl } },
  );

  const createJson = await createResponse.json();
  const userErrors = createJson.data?.carrierServiceCreate?.userErrors ?? [];

  if (userErrors.length) {
    console.error("Failed to create carrier service:", userErrors);
  } else {
    console.log(`Carrier service created with callback URL ${callbackUrl}`);
  }
}
