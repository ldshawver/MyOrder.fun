# Inventory history baseline repair

This maintenance path repairs a missing canonical opening baseline without changing physical inventory. It is intended for a reviewed mismatch where `inventory_balances.quantity_on_hand` is supported by a fresh physical count but `SUM(inventory_movements.quantity_delta)` is not.

The evidence file is a JSON array. Every mismatched inventory-item/location pair must be present:

```json
[
  {
    "inventoryItemId": 123,
    "locationId": 1,
    "verifiedPhysicalQuantity": "10.000000",
    "documentedUnitCost": "2.50",
    "physicalCountNote": "Count sheet reference and witnesses",
    "costBasisNote": "Supplier invoice or receiving record reference"
  }
]
```

Preview is the default and never writes:

```sh
pnpm --filter @workspace/api-server inventory-history-repair --tenant-id=1 --product-id=123 --input=/path/to/reviewed-evidence.json
```

Execution must use the unchanged fingerprint returned by preview and requires all of the following: an approved tenant administrator, a UUID idempotency key, the exact confirmation phrase, a reviewed reason, no active reservation or open committed order blockers, unchanged stored physical quantities, unknown baseline valuation, and documented positive unit cost.

```sh
pnpm --filter @workspace/api-server inventory-history-repair --tenant-id=1 --product-id=123 --input=/path/to/reviewed-evidence.json --execute --confirm=INVENTORY_HISTORY_BASELINE_REPAIR --fingerprint=<preview-fingerprint> --idempotency-key=<uuid> --actor-id=<tenant-admin-id> --reason="Reviewed missing opening inventory baseline"
```

Apply appends immutable `correction` movements with source type `verified_physical_count_history_bridge`, records immutable repair evidence and an audit event, and establishes valuation from the documented unit cost. It does not update `inventory_balances`, cancel or alter orders/reservations, update/delete prior movement rows, or bypass catalogue reconciliation guards.
