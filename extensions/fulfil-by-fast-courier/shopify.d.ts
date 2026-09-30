import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/OrderDetailsAction.tsx' {
  const shopify: import('@shopify/ui-extensions/admin.order-details.action.render').Api;
  const globalThis: { shopify: typeof shopify };
}
