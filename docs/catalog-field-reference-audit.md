# Catalog field reference audit

Command:

```bash
rg -n customer_safe_name|customer_safe_description|merchant_category|lucifer_cruz_category|display_category|merchant_image|display_image|safe_name|safe_description|safe_category|safe_image_url artifacts lib scripts deploy --glob !node_modules --glob !dist --glob !build --glob !docs
```

Results:

```text
scripts/src/repair-duplicate-safe-products.ts:25:    ci.customer_safe_name,
scripts/src/repair-duplicate-safe-products.ts:29:    lower(regexp_replace(coalesce(nullif(ci.sku, ''), nullif(ci.merchant_sku, ''), nullif(ci.alavont_id, ''), ci.name, ci.customer_safe_name, ''), '[^a-zA-Z0-9]+', ' ', 'g')) AS sku_key,
scripts/src/repair-duplicate-safe-products.ts:30:    lower(regexp_replace(coalesce(nullif(ci.name, ''), nullif(ci.customer_safe_name, ''), ''), '[^a-zA-Z0-9]+', ' ', 'g')) AS name_key,
scripts/src/repair-duplicate-safe-products.ts:31:    lower(regexp_replace(coalesce(nullif(ci.customer_safe_name, ''), nullif(ci.name, ''), ''), '[^a-zA-Z0-9]+', ' ', 'g')) AS customer_key,
scripts/src/repair-duplicate-safe-products.ts:58:  'same tenant and normalized sku/name/customer_safe_name; canonical prefers inventory, order refs, oldest id' AS reason,
lib/db/src/schema/settings.ts:23:  merchantImageEnabled: boolean("merchant_image_enabled").notNull().default(true),
lib/db/src/schema/catalog.ts:63:  luciferCruzCategory: text("lucifer_cruz_category"),
lib/db/src/schema/catalog.ts:68:  displayCategory: text("display_category"),
lib/db/src/schema/catalog.ts:69:  displayImage: text("display_image"),
lib/db/src/schema/catalog.ts:72:  customerSafeName: text("customer_safe_name"),
lib/db/src/schema/catalog.ts:73:  customerSafeDescription: text("customer_safe_description"),
lib/db/src/schema/catalog.ts:96:  merchantImage: text("merchant_image"),
lib/db/src/schema/catalog.ts:98:  merchantCategory: text("merchant_category"),
lib/db/drizzle/0000_dual_brand_columns.sql:39:ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lucifer_cruz_category" text;
lib/db/drizzle/0008_menu_import_columns.sql:11:ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_image" text;
lib/db/drizzle/0008_menu_import_columns.sql:15:ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_category" text;
lib/db/drizzle/meta/0000_snapshot.json:549:        "lucifer_cruz_category": {
lib/db/drizzle/meta/0000_snapshot.json:550:          "name": "lucifer_cruz_category",
lib/db/drizzle/meta/0000_snapshot.json:2574:        "merchant_image_enabled": {
lib/db/drizzle/meta/0000_snapshot.json:2575:          "name": "merchant_image_enabled",
lib/db/drizzle/0012_product_conversion_fields.sql:31:ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "display_category" text;
lib/db/drizzle/0012_product_conversion_fields.sql:33:ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "display_image" text;
lib/db/drizzle/0012_product_conversion_fields.sql:39:ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "customer_safe_name" text;
lib/db/drizzle/0012_product_conversion_fields.sql:41:ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "customer_safe_description" text;
deploy/vps-database.sql:13:    merchant_image_enabled boolean DEFAULT true NOT NULL,
artifacts/api-server/src/lib/checkoutNormalizer.ts:35:  display_category: string;
artifacts/api-server/src/lib/checkoutNormalizer.ts:36:  display_image: string | null;
artifacts/api-server/src/lib/checkoutNormalizer.ts:39:  customer_safe_name: string;
artifacts/api-server/src/lib/checkoutNormalizer.ts:40:  customer_safe_description: string;
artifacts/api-server/src/lib/checkoutNormalizer.ts:41:  customer_safe_category: string;
artifacts/api-server/src/lib/checkoutNormalizer.ts:47:  merchant_image_url: string | null;
artifacts/api-server/src/lib/checkoutNormalizer.ts:108:  customer_safe_name: string | null;
artifacts/api-server/src/lib/checkoutNormalizer.ts:109:  customer_safe_description: string | null;
artifacts/api-server/src/lib/checkoutNormalizer.ts:110:  customer_safe_category: string | null;
artifacts/api-server/src/lib/checkoutNormalizer.ts:206:        ["customer_safe_name"],
artifacts/api-server/src/lib/checkoutNormalizer.ts:212:    const merchant_image_url =
artifacts/api-server/src/lib/checkoutNormalizer.ts:227:    const display_category = firstNonEmpty(ci.alavontCategory, ci.displayCategory, ci.category) ?? ci.category;
artifacts/api-server/src/lib/checkoutNormalizer.ts:228:    const display_image = firstNonEmpty(ci.alavontImageUrl, ci.displayImage, ci.imageUrl);
artifacts/api-server/src/lib/checkoutNormalizer.ts:236:    const customer_safe_name = branded_name;
artifacts/api-server/src/lib/checkoutNormalizer.ts:237:    const customer_safe_description = firstNonEmpty(
artifacts/api-server/src/lib/checkoutNormalizer.ts:243:    const customer_safe_category = firstNonEmpty(
artifacts/api-server/src/lib/checkoutNormalizer.ts:251:        customer_safe_name: customerSafeName,
artifacts/api-server/src/lib/checkoutNormalizer.ts:252:        customer_safe_description: customerSafeDescription,
artifacts/api-server/src/lib/checkoutNormalizer.ts:253:        customer_safe_category,
artifacts/api-server/src/lib/checkoutNormalizer.ts:277:      display_category,
artifacts/api-server/src/lib/checkoutNormalizer.ts:278:      display_image,
artifacts/api-server/src/lib/checkoutNormalizer.ts:281:      customer_safe_name: customer_safe_name ?? merchant_name,
artifacts/api-server/src/lib/checkoutNormalizer.ts:282:      customer_safe_description: customer_safe_description ?? marketing_copy,
artifacts/api-server/src/lib/checkoutNormalizer.ts:283:      customer_safe_category: customer_safe_category ?? "Safe Checkout",
artifacts/api-server/src/lib/checkoutNormalizer.ts:289:      merchant_image_url,
artifacts/api-server/src/lib/checkoutNormalizer.ts:348:    name: line.customer_safe_name ?? line.merchant_name,
artifacts/api-server/src/lib/checkoutNormalizer.ts:349:    image_url: merchantImageEnabled ? (line.customer_safe_image || line.merchant_image_url) : null,
artifacts/api-server/src/lib/checkoutNormalizer.ts:350:    description: line.customer_safe_description,
artifacts/api-server/src/lib/checkoutNormalizer.ts:351:    category: line.customer_safe_category,
artifacts/api-server/src/lib/stripePayload.ts:38:  return lines.map(l => `${l.customer_safe_name} x${l.quantity}`).join(", ");
artifacts/api-server/src/lib/__tests__/checkoutConversionGate.test.ts:7:  catalog_item_id: 1, source_type: "local_mapped", merchant_brand: "alavont", catalog_display_name: "Alavont OG", merchant_name: "Safe Name", merchant_sku: "SAFE-1", display_name: "Alavont OG", display_description: "Alavont private desc", display_category: "Alavont private cat", display_image: "alavont.png", merchant_brand_name: "Safe", marketing_copy: "Safe copy", customer_safe_name: "Safe Name", customer_safe_description: "Safe Description", customer_safe_category: "Safe Category", customer_safe_image: "safe.png", upsell_copy: null, promo_badges: [], receipt_alavont_name: "Alavont OG", receipt_lucifer_name: "Safe Name", merchant_image_url: "safe.png", unit_price: 10, quantity: 2, line_subtotal: 20, alavont_id: "ALV-1", woo_product_id: null, woo_variation_id: null, lab_name: null, receipt_name: null, label_name: null,
artifacts/api-server/src/lib/__tests__/checkoutConversionGate.test.ts:37:    expect(() => assertSafeMerchantLines([{ ...safeLine, customer_safe_category: "", customer_safe_image: "" }])).toThrow("Missing safe merchant field: customer_safe_category");
artifacts/api-server/src/lib/__tests__/checkoutConversionGate.test.ts:39:      assertSafeMerchantLines([{ ...safeLine, customer_safe_category: "", customer_safe_image: "" }]);
artifacts/api-server/src/lib/__tests__/checkoutConversionGate.test.ts:41:      expect(error).toMatchObject({ missingSafeFields: ["customer_safe_category"] });
artifacts/api-server/src/lib/__tests__/checkoutConversionGate.test.ts:46:    const payload = buildSafeMerchantPayloadLines([{ ...safeLine, customer_safe_name: "Safe Only" }]);
artifacts/api-server/src/lib/__tests__/itemConversion.test.ts:91:  display_category: "Premium Goods",
artifacts/api-server/src/lib/__tests__/itemConversion.test.ts:92:  display_image: null,
artifacts/api-server/src/lib/__tests__/itemConversion.test.ts:95:  customer_safe_name: "LC Premium Tee",
artifacts/api-server/src/lib/__tests__/itemConversion.test.ts:96:  customer_safe_description: "Customer-safe description",
artifacts/api-server/src/lib/__tests__/itemConversion.test.ts:97:  customer_safe_category: "Premium Goods",
artifacts/api-server/src/lib/__tests__/itemConversion.test.ts:178:        merchant_image_url: null,
artifacts/api-server/src/lib/__tests__/itemConversion.test.ts:249:      customer_safe_name: "Customer Safe Tee",
artifacts/api-server/src/lib/__tests__/itemConversion.test.ts:250:      customer_safe_description: "Customer-safe production description",
artifacts/api-server/src/lib/__tests__/itemConversion.test.ts:251:      customer_safe_category: "Production Safe Category",
artifacts/api-server/src/lib/__tests__/itemConversion.test.ts:272:      missingSafeFields: ["customer_safe_name", "customer_safe_description"],
artifacts/api-server/src/lib/__tests__/itemConversion.test.ts:299:      missingSafeFields: ["customer_safe_category"],
artifacts/api-server/src/lib/__tests__/itemConversion.test.ts:362:        merchant_image_url: null,
artifacts/api-server/src/lib/__tests__/itemConversion.test.ts:385:      customer_safe_name: "Safe Tee",
artifacts/api-server/src/lib/__tests__/itemConversion.test.ts:386:      customer_safe_description: "Safe description",
artifacts/api-server/src/lib/__tests__/itemConversion.test.ts:387:      customer_safe_category: "Safe category",
artifacts/api-server/src/lib/__tests__/itemConversion.test.ts:412:      customer_safe_name: "Safe 410",
artifacts/api-server/src/lib/__tests__/itemConversion.test.ts:432:        merchant_image_url: null,
artifacts/api-server/src/lib/__tests__/checkoutNormalizer.test.ts:143:      expect(line.display_category).toBe("Customer category");
artifacts/api-server/src/lib/__tests__/checkoutNormalizer.test.ts:188:          merchant_image_url: "https://img.com/lc.jpg",
artifacts/api-server/src/lib/__tests__/checkoutNormalizer.test.ts:213:          merchant_image_url: null,
artifacts/api-server/src/lib/__tests__/checkoutNormalizer.test.ts:239:        merchant_image_url: null,
artifacts/api-server/src/lib/__tests__/checkoutNormalizer.test.ts:343:          merchant_image_url: "https://img.com/woo.jpg",
artifacts/api-server/src/lib/__tests__/checkoutNormalizer.test.ts:370:          merchant_image_url: null,
artifacts/api-server/src/lib/merchantPayloadValidator.ts:13:      customer_safe_name: line.customer_safe_name,
artifacts/api-server/src/lib/merchantPayloadValidator.ts:14:      customer_safe_description: line.customer_safe_description,
artifacts/api-server/src/lib/merchantPayloadValidator.ts:15:      customer_safe_category: line.customer_safe_category,
artifacts/api-server/src/lib/merchantPayloadValidator.ts:23:    const forbidden = [line.receipt_alavont_name, line.display_description, line.display_category].filter(Boolean).map(String);
artifacts/api-server/src/lib/merchantPayloadValidator.ts:24:    const safe = [line.customer_safe_name, line.customer_safe_description, line.customer_safe_category].join("\n").toLowerCase();
artifacts/api-server/src/lib/merchantPayloadValidator.ts:25:    for (const f of forbidden) if (f && ![line.customer_safe_name,line.customer_safe_description,line.customer_safe_category].includes(f) && safe.includes(f.toLowerCase())) throw new MerchantPayloadValidationError();
artifacts/api-server/src/lib/merchantPayloadValidator.ts:30:  return lines.map(line => ({ name: line.customer_safe_name, description: line.customer_safe_description, category: line.customer_safe_category, image_url: line.customer_safe_image ?? null, quantity: line.quantity, unit_price: line.unit_price, total_price: Number((line.unit_price * line.quantity).toFixed(2)), source_type: line.source_type, merchant_sku: line.merchant_sku, woo_product_id: line.woo_product_id, woo_variation_id: line.woo_variation_id }));
artifacts/api-server/src/routes/shifts.ts:406:    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lucifer_cruz_category" text`,
artifacts/api-server/src/routes/shifts.ts:409:    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "display_category" text`,
artifacts/api-server/src/routes/shifts.ts:410:    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "display_image" text`,
artifacts/api-server/src/routes/shifts.ts:413:    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "customer_safe_name" text`,
artifacts/api-server/src/routes/shifts.ts:414:    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "customer_safe_description" text`,
artifacts/api-server/src/routes/shifts.ts:421:    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_image" text`,
artifacts/api-server/src/routes/shifts.ts:423:    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_category" text`,
artifacts/api-server/src/routes/import.ts:92:  lucifer_cruz_category: "Safe Category",
artifacts/api-server/src/routes/settings.ts:44:    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "merchant_image_enabled" boolean NOT NULL DEFAULT true`,
artifacts/api-server/src/routes/woocommerce.ts:39:    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lucifer_cruz_category" text`,
artifacts/api-server/src/routes/orders.ts:242:        customerSafeName: line.customer_safe_name,
artifacts/api-server/src/routes/orders.ts:244:        customerSafeDescription: line.customer_safe_description,
artifacts/api-server/src/routes/orders.ts:247:        originalInternalCategory: line.display_category,
artifacts/api-server/src/routes/orders.ts:248:        customerSafeCategory: line.customer_safe_category,
artifacts/api-server/src/routes/orders.ts:250:        displayCategory: line.customer_safe_category,
artifacts/api-server/src/routes/orders.ts:320:    name: line.customer_safe_name,
artifacts/api-server/src/routes/orders.ts:325:    special_instructions: line.customer_safe_category,
artifacts/api-server/src/routes/catalog.ts:143:    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lucifer_cruz_category" text`,
artifacts/api-server/src/routes/catalog.ts:146:    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "display_category" text`,
artifacts/api-server/src/routes/catalog.ts:147:    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "display_image" text`,
artifacts/api-server/src/routes/catalog.ts:150:    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "customer_safe_name" text`,
artifacts/api-server/src/routes/catalog.ts:151:    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "customer_safe_description" text`,
artifacts/api-server/src/routes/catalog.ts:169:    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_image" text`,
artifacts/api-server/src/routes/catalog.ts:171:    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_category" text`,
artifacts/api-server/src/routes/__tests__/payments-server-amount.test.ts:74:        display_category: "Safe category",
artifacts/api-server/src/routes/__tests__/payments-server-amount.test.ts:75:        display_image: "safe-tee.png",
artifacts/api-server/src/routes/__tests__/payments-server-amount.test.ts:78:        customer_safe_name: "Safe Tee",
artifacts/api-server/src/routes/__tests__/payments-server-amount.test.ts:79:        customer_safe_description: "Safe tee description",
artifacts/api-server/src/routes/__tests__/payments-server-amount.test.ts:80:        customer_safe_category: "Safe category",
artifacts/api-server/src/routes/__tests__/payments-server-amount.test.ts:86:        merchant_image_url: null,
artifacts/api-server/src/routes/__tests__/order-endpoints-sse.test.ts:115:        display_category: "Safe category",
artifacts/api-server/src/routes/__tests__/order-endpoints-sse.test.ts:116:        display_image: "safe.png",
artifacts/api-server/src/routes/__tests__/order-endpoints-sse.test.ts:119:        customer_safe_name: "Safe Item",
artifacts/api-server/src/routes/__tests__/order-endpoints-sse.test.ts:120:        customer_safe_description: "Safe description",
artifacts/api-server/src/routes/__tests__/order-endpoints-sse.test.ts:121:        customer_safe_category: "Safe category",
artifacts/api-server/src/routes/__tests__/order-endpoints-sse.test.ts:127:        merchant_image_url: null,
```
