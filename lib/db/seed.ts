import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq } from "drizzle-orm";
import { tenantsTable, usersTable, catalogItemsTable, ordersTable, orderItemsTable, onboardingRequestsTable } from "./src/schema/index";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

async function main() {
  console.log("Seeding database...");

  // Create demo tenants
  const [tenant1] = await db.insert(tenantsTable).values({
    name: "Acme Corp",
    slug: "acme-corp",
    status: "active",
    plan: "pro",
    contactEmail: "admin@acme.com",
    settings: { allowCustomerSelfSignup: true, maxUsers: 50 },
  }).onConflictDoNothing().returning();

  const [tenant2] = await db.insert(tenantsTable).values({
    name: "TechFlow Solutions",
    slug: "techflow",
    status: "active",
    plan: "enterprise",
    contactEmail: "admin@techflow.com",
    settings: { allowCustomerSelfSignup: false, maxUsers: 200 },
  }).onConflictDoNothing().returning();

  // Pending onboarding request
  await db.insert(onboardingRequestsTable).values({
    companyName: "StartupX Inc",
    contactName: "Jane Startup",
    contactEmail: "jane@startupx.com",
    contactPhone: "+1-555-0123",
    businessType: "Technology / SaaS",
    website: "https://startupx.com",
    description: "We are a fast-growing SaaS startup needing an ordering platform for our procurement team.",
    expectedOrderVolume: "500-1000 orders/month",
    status: "pending_review",
  }).onConflictDoNothing();

  // If tenant already exists, look it up
  const activeTenant1 = tenant1 ?? (await db.select().from(tenantsTable).where(eq(tenantsTable.slug, "acme-corp")).limit(1))[0];
  const activeTenant2 = tenant2 ?? (await db.select().from(tenantsTable).where(eq(tenantsTable.slug, "techflow")).limit(1))[0];

  if (!activeTenant1) {
    console.log("Could not find or create Acme Corp tenant");
    await pool.end();
    return;
  }

  // Check if catalog already seeded
  const existingItems = await db.select({ id: catalogItemsTable.id }).from(catalogItemsTable).where(eq(catalogItemsTable.tenantId, activeTenant1.id)).limit(1);
  if (existingItems.length > 0) {
    console.log("Catalog already seeded");
    await pool.end();
    return;
  }

  // Seed catalog for Acme Corp
  const catalogItems = [
    {
      tenantId: activeTenant1.id,
      name: "Enterprise Server Rack",
      description: "42U enterprise-grade server rack with cable management and airflow optimization. Supports up to 2000 lbs.",
      category: "Infrastructure",
      sku: "SRV-RACK-42U",
      price: "2499.99",
      compareAtPrice: "2999.99",
      stockQuantity: 15,
      isAvailable: true,
      tags: ["server", "rack", "infrastructure", "enterprise"],
    },
    {
      tenantId: activeTenant1.id,
      name: "10GbE Network Switch",
      description: "24-port managed 10 Gigabit Ethernet switch with advanced QoS and VLAN support.",
      category: "Networking",
      sku: "NET-SW-10G-24",
      price: "1299.00",
      compareAtPrice: null,
      stockQuantity: 42,
      isAvailable: true,
      tags: ["networking", "switch", "10gbe"],
    },
    {
      tenantId: activeTenant1.id,
      name: "UPS Power Module 3000VA",
      description: "3000VA/2700W uninterruptible power supply with pure sine wave output and network monitoring.",
      category: "Power",
      sku: "PWR-UPS-3000",
      price: "899.95",
      compareAtPrice: "1099.95",
      stockQuantity: 28,
      isAvailable: true,
      tags: ["power", "ups", "backup"],
    },
    {
      tenantId: activeTenant1.id,
      name: "SSD Storage Array 48TB",
      description: "Enterprise NVMe SSD storage array with 48TB raw capacity, RAID 6 support, and hot-swap drives.",
      category: "Storage",
      sku: "STR-SSD-48T",
      price: "7499.00",
      compareAtPrice: null,
      stockQuantity: 8,
      isAvailable: true,
      tags: ["storage", "ssd", "nvme", "enterprise"],
    },
    {
      tenantId: activeTenant1.id,
      name: "Fiber Optic Patch Panel",
      description: "24-port LC duplex fiber optic patch panel for single-mode and multimode installations.",
      category: "Networking",
      sku: "NET-FPP-24LC",
      price: "189.99",
      compareAtPrice: null,
      stockQuantity: 100,
      isAvailable: true,
      tags: ["fiber", "networking", "patch-panel"],
    },
    {
      tenantId: activeTenant1.id,
      name: "Hardware Security Module",
      description: "FIPS 140-2 Level 3 certified HSM for key management, PKI operations, and cryptographic acceleration.",
      category: "Security",
      sku: "SEC-HSM-L3",
      price: "12999.00",
      compareAtPrice: null,
      stockQuantity: 5,
      isAvailable: true,
      tags: ["security", "hsm", "cryptography", "fips"],
    },
    {
      tenantId: activeTenant1.id,
      name: "Dual 25GbE NIC Card",
      description: "PCIe Gen4 dual-port 25GbE network adapter with RDMA/RoCE support for high-performance computing.",
      category: "Networking",
      sku: "NET-NIC-25G-D",
      price: "399.00",
      compareAtPrice: "499.00",
      stockQuantity: 67,
      isAvailable: true,
      tags: ["networking", "nic", "25gbe", "rdma"],
    },
    {
      tenantId: activeTenant1.id,
      name: "Legacy SCSI Controller",
      description: "Discontinued product - for legacy system maintenance only.",
      category: "Legacy",
      sku: "LEG-SCSI-CTRL",
      price: "149.99",
      compareAtPrice: null,
      stockQuantity: 3,
      isAvailable: false,
      tags: ["legacy", "scsi"],
    },
  ];

  const insertedItems = await db.insert(catalogItemsTable).values(catalogItems as any).returning();

  // Also seed TechFlow catalog
  if (tenant2) {
    await db.insert(catalogItemsTable).values([
      {
        tenantId: activeTenant2!.id,
        name: "Cloud Management Platform License",
        description: "Annual enterprise license for multi-cloud orchestration and cost optimization platform.",
        category: "Software",
        sku: "SW-CMP-ENT-1Y",
        price: "24999.00",
        stockQuantity: null,
        isAvailable: true,
        tags: ["software", "cloud", "enterprise"],
      },
      {
        tenantId: activeTenant2!.id,
        name: "Professional Services Package",
        description: "40-hour block of professional services including architecture review, implementation, and training.",
        category: "Services",
        sku: "SVC-PRO-40H",
        price: "9999.00",
        stockQuantity: null,
        isAvailable: true,
        tags: ["services", "consulting"],
      },
    ] as any).onConflictDoNothing();
  }

  console.log(`Seeded ${insertedItems.length} catalog items for Acme Corp`);
  console.log("Database seeding complete!");
  await pool.end();
}

main().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
