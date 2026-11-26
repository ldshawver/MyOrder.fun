# Lucifer Cruz installation branding and customer receipts

This change needs a newly reviewed API/platform release. It is not included in
the previously approved print-operations image pins and does not change them.

## Public identity

The manifest is served by `/api/public/manifest.webmanifest` using the existing
exact-host tenant resolver. Browser tenant IDs and forwarding headers cannot
select a tenant. Unknown domains fail closed; responses are not shared-cacheable.
The install name is **Lucifer Cruz Order**, short name **LC Order**, with the
unchanged approved 1024px LC artwork. Apple title/icon and favicon use public
host identity rather than the signed-in user's platform branding.

Production currently has the canonical storefront `shop.lucifercruz.com` for
tenant 1. The additional main-site alias needs these non-secret settings in the
protected production environment when the reviewed release is promoted:

```
PUBLIC_STOREFRONT_HOST=myorder.fun
PUBLIC_STOREFRONT_TENANT_ID=1
```

These settings have NOT been applied to production. They do not replace the
canonical storefront, relax authentication, or select signup tenants. The alias
cannot override a configured domain owner. Staging keeps its separate staging
alias mechanism. Verify the public manifest/name/icon before install testing.
Existing installed shortcuts may require removal/reinstallation after release;
do this only after completing any active checkout. No service-worker cache
purge or customer storage reset is introduced.

## Receipt layout

The exact approved black-on-transparent logo is included in API assets and its
hash is checked before rendering. Its new width is 50% of the earlier renderer's
printable width, with original proportions and horizontal centering. The text
body is centered as a block so item/amount columns stay aligned; long lines wrap.

Only Lucifer Cruz customer receipts routed to a Brightek through the bridge use
the image PDF. Other tenants/printers, compact style, and disabled logos retain
their text paths. Automatic receipts and reprints share the same render pipeline.
Reprints do not request a drawer opening. Text and monetary calculations are not
changed. A one-line null-check correction in the merged commission document
renderer is included because its existing expression failed strict typechecking;
it changes no financial calculation or displayed value.

PDF cash receipts require a companion raw pulse because the PDF bypasses the
original text stream. The existing pulse bytes and destination are retained.
An attempted marker is persisted before sending; confirmed pulses are not
repeated on receipt retry. Uncertain pulse outcomes stop for staff verification.
The existing atomic job claim and tenant/printer scope checks remain in place.

## Acceptance gates

The user approved the generated centered sample. The sample is not a receipt,
payment, or hardware test. Before production promotion, verify installation on
iOS/Android, then perform a controlled physical Brightek sample/receipt test,
confirm margins/cutting, and verify cash pulse and reprint behavior. Retain
current production rollback images and follow the guarded release process.
No migration is needed by this feature. No deployment or hardware action is
authorized by opening its PR.
