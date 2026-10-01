import '@shopify/ui-extensions/preact';
import {render} from 'preact';

const APP_HANDLE = 'bycshipping';

export default async () => {
  render(<FulfilByFastCourierAction />, document.body);
};

function FulfilByFastCourierAction() {
  // e.g. "gid://shopify/Order/11618435498347" -> "11618435498347"
  const gid = shopify.data.selected?.[0]?.id;
  const orderId = gid?.split('/').pop();
  console.log('FulfilByFastCourierAction orderId:', orderId);
  //const orderUrl = `shopify:admin/apps/${APP_HANDLE}/app/orders/${orderId}`;
  const handleOpenOrders = () => {
    // Navigate to your embedded app
    window.open(`apps/${APP_HANDLE}/app/orders/${orderId}`, '_self');
  };

  return (
    <s-admin-action heading="Fulfil by BYCShipping">
      <s-text>
        Review and fulfil this order.
      </s-text>

      <s-button
        slot="primary-action"
        variant="primary"
        onClick={handleOpenOrders}
        disabled={!orderId}
      >
        Review this Order
      </s-button>

      <s-button slot="secondary-actions" onClick={() => shopify.close()}>
        Cancel
      </s-button>
    </s-admin-action>
  );
}