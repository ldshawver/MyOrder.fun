# Archived catalog purge dry-run

Archived catalog rows preserve order, inventory, receipt, option, and audit history. They must not be physically deleted merely because the current database has no immediately visible references.

Run the read-only inventory against an isolated PostgreSQL copy:

```sh
DATABASE_URL=postgresql://... pnpm --filter @workspace/scripts catalog:archive-dry-run --tenant-id=123 > catalog-archive-report.json
```

The command starts a PostgreSQL `READ ONLY` transaction, discovers catalog-reference columns from database metadata, counts tenant-matched references for every archived row, and labels referenced rows `blocked_historical_references`. Columns named `catalog_item_id` without a discovered foreign key are reported explicitly because they need schema-owner review and likely historical-reference rehoming before any purge can be designed.

`requires_manual_review` is not approval to delete. Before a future destructive change, retain immutable order/receipt display snapshots, rehome every required historical reference, add validated foreign keys where appropriate, capture a reviewed report from the exact release schema, rehearse backup/restore and rollback, and obtain separate owner approval. Purge execution is outside the supervised development worker policy.
