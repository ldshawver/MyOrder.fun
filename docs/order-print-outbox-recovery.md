# Order print outbox recovery

Order creation writes one durable outbox row per tenant and order. A unique
constraint prevents duplicate outbox rows. The worker leases a row for 90
seconds, retries after a worker crash or enqueue failure, and stops after eight
attempts. Retry delay grows exponentially and is capped at five minutes.

The worker schedules the consolidated receipt, expo, and work documents through
the existing print-job service. Each document uses a tenant/order-scoped
idempotency key, so recovery does not create duplicate database print jobs.
Failed bridge submissions remain in the print-job queue for the existing retry
and operator review workflow.

This provides durable, at-least-once scheduling with idempotent database job
creation. It cannot guarantee exactly-once paper output: if a printer accepts a
job but its acknowledgment is lost, retrying may print the same document again.
Operators should inspect the job's bridge status before retrying an uncertain
submission; an intentional second physical copy must use the labeled reprint
workflow.
