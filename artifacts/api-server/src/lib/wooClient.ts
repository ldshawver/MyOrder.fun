import { logger } from "./logger";

interface WooOrderLine {
  product_id: string;
  variation_id?: string;
  name: string;
  quantity: number;
  unit_price: number;
}

interface CreateWooOrderParams {
  orderId: number;
  lines: WooOrderLine[];
}

function getWooCredentials(): { storeUrl: string; consumerKey: string; consumerSecret: string } | null {
  // Use WC_* vars (matching the existing woocommerce route) with WOO_* as fallback
  const storeUrl = process.env.WC_STORE_URL ?? process.env.WOO_STORE_URL;
  const consumerKey = process.env.WC_CONSUMER_KEY ?? process.env.WOO_CONSUMER_KEY;
  const consumerSecret = process.env.WC_CONSUMER_SECRET ?? process.env.WOO_CONSUMER_SECRET;
  if (!storeUrl || !consumerKey || !consumerSecret) return null;
  return { storeUrl, consumerKey, consumerSecret };
}

export async function createWooOrder(params: CreateWooOrderParams): Promise<string | null> {
  const creds = getWooCredentials();
  if (!creds) {
    logger.info({ orderId: params.orderId }, "WooCommerce credentials not configured — skipping woo order dispatch");
    return null;
  }

  const base = creds.storeUrl.replace(/\/$/, "");
  const auth = Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString("base64");

  const payload = {
    status: "processing",
    line_items: params.lines.map(l => ({
      product_id: parseInt(l.product_id, 10),
      variation_id: l.variation_id ? parseInt(l.variation_id, 10) : undefined,
      quantity: l.quantity,
    })),
    meta_data: [
      { key: "platform_order_id", value: String(params.orderId) },
      { key: "merchant_names", value: params.lines.map(l => l.name).join(", ") },
    ],
  };

  const res = await fetch(`${base}/wp-json/wc/v3/orders`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WooCommerce create order failed: ${res.status} ${text.substring(0, 200)}`);
  }

  const created = await res.json() as { id?: number };
  const wooOrderId = String(created.id ?? "");

  logger.info(
    { orderId: params.orderId, wooOrderId, lineCount: params.lines.length },
    "WOO_ORDER_DISPATCH: WooCommerce order created for CJ Dropshipping sync"
  );

  return wooOrderId;
}
