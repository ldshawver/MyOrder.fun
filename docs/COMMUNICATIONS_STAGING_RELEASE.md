# Communications Admin + Platform Integrations Staging Release Notes

## Merge decision

- **Staging:** YES
- **Production:** NO, unless the feature remains visibly marked as a UI shell / beta-only experience.

The admin communications and global-admin integrations screens are approved for staging validation only. They must not be presented as production-complete communications functionality until the backend gaps below are implemented, tested, and the visible UI-only labels are removed feature-by-feature.

## Production backend gaps

Before production, add and test backend APIs for:

- Communications settings persistence.
- SMS campaign draft/save/send persistence.
- Auto-reply rule persistence.
- Call settings persistence.
- Number ownership and permissions persistence.
- Call log filtering/actions.
- Voicemail playback/status/assignment/archive actions.
- Platform integration settings persistence.

## UI shell labels that must remain visible

- The admin communications page must keep the **Staging beta · UI-only shell pending communications APIs** label visible until communications persistence and action APIs are wired.
- The global-admin integrations page must keep the **Staging beta · settings forms UI-only until persistence APIs are connected** label visible until integration settings persistence APIs are wired.

## Staging QA evidence to collect before production

Attach evidence to the staging release ticket before production approval:

1. Browser QA screenshot for `/admin/communications` on desktop.
2. Browser QA screenshot for `/global-admin/integrations` on desktop.
3. Role-based access screenshots showing:
   - `global_admin` can see **Platform Integrations**.
   - `admin` / supervisor-equivalent roles can see **SMS & Calls**.
   - non-global-admin roles cannot see **Platform Integrations**.
4. Mobile/responsive screenshots for both new pages.
5. Confirmation screenshot or test recording that existing account phone/PWA route behavior still works, including the account phone input.

## Current automated evidence

The reconciliation test suite guards the source-level expectations for route visibility, duplicate nav prevention, filters, tabs, call log actions, voicemail actions, and existing account phone route preservation in `artifacts/api-server/src/routes/__tests__/communications-admin-nav.test.ts`.
