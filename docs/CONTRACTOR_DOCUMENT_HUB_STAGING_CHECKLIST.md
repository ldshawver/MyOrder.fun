# Contractor Hub / Document Hub Staging Validation Checklist

Status: **code-complete candidate / staging verification required**

Do **not** mark this feature production-ready until every required staging check below is completed against a real Postgres database and live Documenso/LUXit environment.

## Required Environment

Set these variables in staging/VPS runtime configuration. Do not commit secret values.

- `MYPAYLINK_DOCUMENSO_API_KEY`
- `MYPAYLINK_DOCUMENSO_BASE_URL=https://document.luxit.app`
- `MYPAYLINK_DOCUMENSO_ENABLED=true`
- Legacy fallback still supported: `MyPayLink_DOCUMENSO_API_KEY`

## 1. Database Migration Verification

Run from the deployed project directory on staging/VPS:

```bash
cd /home/paylinkssh/paylink-app/PayLink
printenv DATABASE_URL
pnpm db:migrate
```

If this repo uses a different migration command in staging, record the exact command here:

- Actual migration command used: `____________________________`

### Fresh DB Check

If practical, run migration 0022 against a freshly provisioned Postgres database.

- [ ] Fresh DB migration completed successfully.
- [ ] No SQL errors.
- [ ] No missing extension/schema errors.

### Existing DB Check

Run migration against the staging database that already has app data.

- [ ] Existing DB migration completed successfully.
- [ ] No destructive table rewrites.
- [ ] No data loss in existing production tables.
- [ ] Existing app login/order/core flows still load after migration.

### Table Existence Checks

Run:

```bash
psql "$DATABASE_URL" -c "\dt *document*"
psql "$DATABASE_URL" -c "\dt *contract*"
psql "$DATABASE_URL" -c "\dt *documenso*"
```

Confirm these tables exist:

- [ ] `document_assets`
- [ ] `document_asset_metadata`
- [ ] `document_asset_permissions`
- [ ] `document_asset_versions`
- [ ] `document_asset_audit_logs`
- [ ] `contracts`
- [ ] `contract_signers`
- [ ] `contract_audit_logs`
- [ ] `documenso_webhook_events`

## 2. Post-Migration Validation Commands

Run after migration on staging/VPS:

```bash
pnpm --filter @workspace/api-server typecheck
pnpm --filter @workspace/platform typecheck
pnpm --filter @workspace/api-server test -- --runInBand
pnpm lint:ratchet
```

Record results:

- [ ] API server typecheck passed.
- [ ] Platform typecheck passed.
- [ ] API tests passed.
- [ ] Lint ratchet passed.

## 3. Live Documenso Signing Test

Use the live staging environment with Documenso enabled.

1. [ ] Create a contractor proposal.
2. [ ] Approve the proposal.
3. [ ] Confirm approval creates or links a contract.
4. [ ] Confirm the contractor from the approved proposal is an eligible signer.
5. [ ] Add an assigned signer.
6. [ ] Add an additional delegated signer.
7. [ ] Add a replacement signer.
8. [ ] Send signing email.
9. [ ] Open the email link at `/sign/contracts/:token` in a signed-out/private browser session.
10. [ ] Confirm the public signing page loads without 404 or blank screen.
11. [ ] Complete signing through Documenso/LUXit.
12. [ ] Confirm Documenso status becomes completed.
13. [ ] Confirm MyPayLink receives `POST /api/contractor-hub/documenso/webhook`.
14. [ ] Confirm MyPayLink downloads the final signed PDF from Documenso.
15. [ ] Confirm signed PDF appears in Document Hub.
16. [ ] Confirm signed PDF can be viewed.
17. [ ] Confirm signed PDF can be downloaded.
18. [ ] Confirm signed PDF can be printed.
19. [ ] Confirm contract status is `fully_signed`.
20. [ ] Confirm duplicate webhook delivery returns success without creating duplicate archives or mutating state again.

## 4. Proposal Approval Integration

Verify the full business workflow:

- [ ] Proposal approval creates or links the correct contract.
- [ ] Approved proposal contractor is authorized to sign.
- [ ] Admin/global admin signer authorization works.
- [ ] Additional delegated signer works.
- [ ] Replacement signer works.
- [ ] Public token signer works without `user_company_access` failure.
- [ ] Documenso recipient signer works.
- [ ] Final signed contract can trigger the next workflow step.
- [ ] Invoice creation is triggered if that is current product behavior.

## 5. Frontend Manual QA

Verify these routes and states in staging:

- [ ] `/contractor-hub`
- [ ] `/document-hub`
- [ ] `/sign/contracts/:token`
- [ ] Authenticated contract signing route.
- [ ] Contract list loads persisted contracts.
- [ ] Resend signing email works.
- [ ] Expired token state displays a clear message.
- [ ] Completed contract state displays a clear message.
- [ ] Signed document view route works.
- [ ] Signed document download route works.
- [ ] Signed document print route works.
- [ ] No console errors during normal flow.
- [ ] No network 404s during normal flow.

## 6. Audit Log Verification

Confirm audit trail entries exist for:

- [ ] Proposal approved.
- [ ] Contract generated.
- [ ] Signer assigned.
- [ ] Signing email sent.
- [ ] Documenso sent.
- [ ] Signer viewed/opened.
- [ ] Signer completed.
- [ ] Contract fully signed.
- [ ] Final PDF archived.
- [ ] Duplicate webhook received and ignored/idempotent.

## 7. Final Verdict

- Database migration result: `PASS / FAIL / BLOCKED`
- Documenso live signing result: `PASS / FAIL / BLOCKED`
- Webhook receipt result: `PASS / FAIL / BLOCKED`
- Document Hub archive result: `PASS / FAIL / BLOCKED`
- Audit log result: `PASS / FAIL / BLOCKED`
- Full validation result: `PASS / FAIL / BLOCKED`

Final production-readiness verdict:

- [ ] PASS — production-ready.
- [ ] FAIL — do not release.
- [ ] BLOCKED — staging/VPS/live Documenso access required.

Reviewer notes:

```text

```
