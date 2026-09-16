import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import "@shopify/app-bridge-react";
import db from "../db.server";
import {
  authenticate,
  registerTestShippingService,
} from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

const CCS_REQUIRED_MESSAGE =
  "Carrier Calculated Shipping must be enabled for this store before CCS can be registered.";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const registration = await db.shippingRegistration.findUnique({
    where: { shop: session.shop },
  });

  return {
    shippingRegistration: registration
      ? {
          ccsRequired: registration.ccsRequired,
          message: registration.message,
        }
      : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  if (formData.get("intent") === "retry-shipping") {
    return registerTestShippingService(admin, session.shop, true);
  }
  return null;
};

export default function Index() {
  const { shippingRegistration } = useLoaderData<typeof loader>();
  const shippingFetcher = useFetcher<{
    ccsRequired: boolean;
    message?: string;
  }>();
  const registration = shippingFetcher.data ?? shippingRegistration;
  const isRetrying = shippingFetcher.state === "submitting";

  return (
    <s-page heading="CCS">
      {registration?.ccsRequired ? (
        <s-banner tone="warning" heading="Carrier registration blocked">
          <s-paragraph>
            {registration.message ?? CCS_REQUIRED_MESSAGE}
          </s-paragraph>
          <s-button
            onClick={() =>
              shippingFetcher.submit(
                { intent: "retry-shipping" },
                { method: "POST" },
              )
            }
            {...(isRetrying ? { loading: true } : {})}
          >
            Retry registration
          </s-button>
        </s-banner>
      ) : registration ? (
        <s-banner tone="success" heading="Carrier registered">
          <s-paragraph>
            CCS is active.
          </s-paragraph>
        </s-banner>
      ) : (
        <s-banner heading="Carrier registration pending">
          <s-paragraph>
            CCS will be registered automatically after app
            authentication.
          </s-paragraph>
        </s-banner>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
