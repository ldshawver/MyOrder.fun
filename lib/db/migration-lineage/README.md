# Non-executable migration lineage

Files in this directory are provenance artifacts, not executable Drizzle migrations.
They must never be copied into `drizzle/`, added to its journal, or executed on a
new database.

`0038_general_queue_cash_sessions.legacy-dev.sql` contains the exact bytes of an
uncommitted historical 0038 variant applied only to the DEV database. Its
SHA-256 is `dfa97bc77b06b927c5744957df530e4844a312fc9b90d61f335b31bfb97245b6`.
Canonical migration `0039_general_queue_cash_schema_reconciliation` supersedes
and reconciles that historical DEV shape. The artifact is retained solely for
provenance and strict migration-lineage validation.
