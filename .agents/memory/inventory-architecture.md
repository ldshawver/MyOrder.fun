---
name: Inventory architecture
description: Per-location inventory model — 4 standard locations, API shape, test mock queue order for GET /api/admin/inventory
---

## 4 Standard Locations
Backstock (type=backstock), Storefront (type=storefront), CSR Sales Box 1 (type=csr_box, csrBoxId=box1.id), CSR Sales Box 2 (type=csr_box, csrBoxId=box2.id).
Created idempotently by `ensureStandardLocations(tenantId)` in inventory.ts.

## GET /api/admin/inventory — DB call order
The route calls `ensureStandardLocations` before its 4 parallel queries.
Total `db.select()` call sequence (n = call number, n=1 is always loadDbUser):

| n  | What                                                        |
|----|-------------------------------------------------------------|
| 1  | loadDbUser (auth middleware)                                |
| 2  | ensureStandardBoxes → csrBoxesTable (skip if non-empty)     |
| 3  | csrBoxes list for slug matching                             |
| 4–7| 4× location-exists checks (1 per standard location)        |
| 8  | products (catalogItemsTable)                                |
| 9  | locations (inventoryLocationsTable)                         |
| 10 | balances (inventoryBalancesTable)                           |
| 11 | admin settings (adminSettingsTable)                         |

**Why this matters:** test mocks using `configureDb(queue)` must supply all 10 post-auth entries or products/locations will be empty arrays.

## Response shape (GET /api/admin/inventory)
```json
{
  "items": [{
    "id": 1, "name": "...", "totalStock": 8,
    "stockQuantity": 8,        // same as totalStock — kept for catalog compat
    "parLevel": 2,             // parsed float
    "locations": [{ "locationId": 1, "name": "Backstock", "type": "backstock", "qty": 5, "par": 2 }, ...]
  }],
  "locations": [{ "id": 1, "name": "Backstock", "type": "backstock", ... }],
  "pettyCash": 100.00
}
```

## Per-location balance upsert
`PATCH /api/admin/inventory/balance/:productId/:locationId`
Body: `{ qty: number, par: number }`

## Test mock pattern
```typescript
configureDb([
  [{ id: 1 }],                  // n=2 ensureStandardBoxes (existing box → skip insert)
  [{ id: 1, slug: "sales-box-1" }, { id: 2, slug: "sales-box-2" }], // n=3 boxes list
  [{ id: 1 }], [{ id: 2 }], [{ id: 3 }], [{ id: 4 }],             // n=4–7 location checks
  [ /* products */ ],            // n=8
  [ /* locations */ ],           // n=9
  [ /* balances */ ],            // n=10
  [{ pettyCash: "100.00" }],    // n=11 settings
]);
```

**Why:** `configureDb` uses a positional queue; if queue entries are missing, extra calls return `[]`. Providing too few entries means the products array is empty.
