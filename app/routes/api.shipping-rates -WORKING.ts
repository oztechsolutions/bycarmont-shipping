import type { ActionFunctionArgs } from "react-router";

type ShopifyRateRequest = {
  rate?: {
    currency?: string;
  };
};

export async function action({ request }: ActionFunctionArgs) {
  const body = (await request.json()) as ShopifyRateRequest;
  const currency = body.rate?.currency;

  if (!currency) {
    return Response.json({ rates: [] });
  }

  return Response.json({
    rates: [
      {
        service_name: "CCS",
        service_code: "ccs",
        description: "Fixed CCS shipping rate",
        total_price: "1000",
        currency,
      },
    ],
  });
}