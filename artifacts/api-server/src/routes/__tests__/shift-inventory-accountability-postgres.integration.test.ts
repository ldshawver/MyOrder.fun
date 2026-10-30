import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MYORDER_CSR_CLOSEOUT_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("CSR inventory accountability PostgreSQL constraints", () => {
  let client: Client;

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !parsed.pathname.includes("myorder_csr_closeout_test")) {
      throw new Error("CSR closeout integration tests require the disposable local test database");
    }
    client = new Client({ connectionString: databaseUrl, ssl: false });
    await client.connect();
    await client.query(`
      INSERT INTO tenants (id,name,slug,status) VALUES (901,'CSR test A','csr-test-a','active'),(902,'CSR test B','csr-test-b','active');
      INSERT INTO users (id,clerk_id,tenant_id,role,status) VALUES (901,'csr-test-user-a',901,'csr','approved'),(902,'csr-test-user-b',902,'csr','approved');
      INSERT INTO lab_tech_shifts (id,tenant_id,tech_id,status,clocked_in_at,clocked_out_at) VALUES
        (901,901,901,'finalized',now()-interval '2 hours',now()-interval '1 hour'),
        (902,902,902,'finalized',now()-interval '2 hours',now()-interval '1 hour');
      INSERT INTO inventory_locations (id,tenant_id,type,name) VALUES (901,901,'csr_box','A box'),(902,902,'csr_box','B box');
      INSERT INTO catalog_items (id,tenant_id,name,category,price) VALUES (901,901,'Variant A','Test',12.50),(902,902,'Variant B','Test',14.00);
      INSERT INTO shift_inventory_items (id,shift_id,catalog_item_id,item_name,location_id,quantity_start,quantity_sold,quantity_end,quantity_end_actual,discrepancy)
        VALUES (77,901,901,'Variant A',901,10,2,8,6,2);
      INSERT INTO shift_closeout_packages (id,tenant_id,shift_id,supervisor_user_id,idempotency_key,snapshot_json,source_max_updated_at) VALUES
        (901,901,901,901,'csr-test-package-a','{}',now()),(902,902,902,902,'csr-test-package-b','{}',now());
      INSERT INTO inventory_movements (id,tenant_id,inventory_entity_type,catalog_item_id,location_id,movement_type,quantity_delta,unit_of_measure,pre_quantity,post_quantity,source_type,idempotency_key,movement_index,correlation_id,actor_user_id)
        VALUES (901,901,'catalog',901,901,'shrinkage',-2,'each',8,6,'shift_inventory_shortage','csr-test-movement-a',0,'csr-test-package-a',901);
      INSERT INTO contractor_inventory_adjustments (id,tenant_id,source_closeout_package_id,source_shift_id,csr_user_id,original_amount,reason,remainder_policy,confirmed_by_user_id)
        VALUES (901,901,901,901,901,20.00,'Supervisor verified count shortage','carry_forward_to_future_shift_payout',901);
      INSERT INTO shift_inventory_shortage_lines (tenant_id,closeout_package_id,adjustment_id,shift_id,csr_user_id,shift_inventory_item_id,catalog_item_id,location_id,inventory_movement_id,item_name_snapshot,unit_of_measure_snapshot,opening_quantity,non_sale_movement_delta,recorded_sales_quantity,expected_quantity,counted_quantity,missing_quantity,retail_price_snapshot,discount_rate,unit_replacement_value,line_total)
        VALUES (901,901,901,901,901,77,901,901,901,'Variant A','each',10,0,2,8,6,2,12.50,0.2,10.00,20.00);
    `);
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  it("rejects cross-tenant catalog and movement references", async () => {
    await expect(client.query(`
      INSERT INTO shift_inventory_shortage_lines (tenant_id,closeout_package_id,adjustment_id,shift_id,csr_user_id,shift_inventory_item_id,catalog_item_id,location_id,inventory_movement_id,item_name_snapshot,unit_of_measure_snapshot,opening_quantity,non_sale_movement_delta,recorded_sales_quantity,expected_quantity,counted_quantity,missing_quantity,retail_price_snapshot,discount_rate,unit_replacement_value,line_total)
      VALUES (901,901,901,901,901,78,902,901,901,'Wrong tenant','each',10,0,2,8,6,2,12.50,0.2,10.00,20.00)
    `)).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects overages/zero shortages and non-80-percent snapshots", async () => {
    await expect(client.query(`
      INSERT INTO shift_inventory_shortage_lines (tenant_id,closeout_package_id,adjustment_id,shift_id,csr_user_id,shift_inventory_item_id,catalog_item_id,location_id,inventory_movement_id,item_name_snapshot,unit_of_measure_snapshot,opening_quantity,non_sale_movement_delta,recorded_sales_quantity,expected_quantity,counted_quantity,missing_quantity,retail_price_snapshot,discount_rate,unit_replacement_value,line_total)
      VALUES (901,901,901,901,901,79,901,901,901,'Bad shortage','each',10,0,2,8,9,0,12.50,0.2,10.00,0)
    `)).rejects.toMatchObject({ code: "23514" });
    await expect(client.query("UPDATE shift_inventory_shortage_lines SET discount_rate=0.1 WHERE tenant_id=901")).rejects.toMatchObject({ code: "55000" });
  });

  it("keeps adjustments, applications, and price snapshots append-only and idempotent", async () => {
    await client.query("INSERT INTO contractor_inventory_adjustment_applications (tenant_id,adjustment_id,applied_closeout_package_id,applied_shift_id,csr_user_id,amount,source_key) VALUES (901,901,901,901,901,5,'csr-test-apply')");
    await expect(client.query("INSERT INTO contractor_inventory_adjustment_applications (tenant_id,adjustment_id,applied_closeout_package_id,applied_shift_id,csr_user_id,amount,source_key) VALUES (901,901,901,901,901,5,'csr-test-apply')")).rejects.toMatchObject({ code: "23505" });
    await expect(client.query("UPDATE contractor_inventory_adjustments SET original_amount=1 WHERE id=901")).rejects.toMatchObject({ code: "55000" });
    await expect(client.query("DELETE FROM contractor_inventory_adjustment_applications WHERE source_key='csr-test-apply'")).rejects.toMatchObject({ code: "55000" });
  });
});
