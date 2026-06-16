# SMS and Calling System Audit

## Root cause summary

- The application had Twilio helper functions for one-way order notifications, but no staff-facing conversation-thread send endpoint. This meant a CSR could not send a plain message from a thread; any reply workflow had to be improvised outside the app or encoded as command text.
- No persisted SMS thread/message model existed for inbound/outbound operational messages, so there was no reliable thread lookup, delivery status update target, or error trail for failed dispatches.
- Google Contacts had no OAuth, sync, cache, or lookup path in the app. Incoming SMS messages therefore had no cache to resolve contact names from.
- The staff navigation did not include a native phone/SMS workspace. Browser or OS tel handlers could surface third-party handlers such as Quo or Zoiper because the app was delegating the workflow to the device instead of providing a first-party business-calling UI.
- The admin settings payment processor picker contained a malformed nested map that prevented the platform TypeScript build from parsing that file.

## Completed repairs

### SMS reply and rendering

- Added a `POST /api/communications/sms/send` endpoint that accepts either `threadId` plus `body`, or `to` plus `body`. Staff can now send a normal message from the selected conversation thread without command syntax.
- Added SMS thread lookup and upsert logic keyed by staff owner and E.164 contact phone.
- Added message rendering with `whitespace-pre-wrap`, `break-words`, and normal line height so message text wraps by words instead of rendering one character per line.

### Google Contacts integration

- Added Google Contacts OAuth URL generation and callback handling.
- Added sync execution through the Google People API.
- Added a local `contact_cache` table populated from synced Google phone numbers.
- Added contact search endpoints and PWA search UI.
- Added inbound SMS name resolution from `contact_cache` before recording inbound threads.

### Phone icon workflow replacement

- Added a native `Phone & SMS` staff workspace.
- Added dial pad, manual number entry, contact search, recent calls, missed calls, and voicemail placeholder sections.
- Added business call logging and Twilio Voice dispatch when voice webhook configuration is present.
- Added a manual `tel:` fallback only after the native workflow logs the call attempt, preventing third-party handlers from being the primary app workflow.

### Outbound calling audit

- Quo, Zoiper, and Phone were likely presented by the OS/browser because the application had no native calling workflow and delegated calls directly to device-level phone URI handlers.
- The new workflow uses Twilio Voice when `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`/`BUSINESS_PHONE_NUMBER`, and `TWILIO_VOICE_TWIML_URL` or `TWILIO_CALL_HANDLER_URL` are configured.
- The caller ID used for native Twilio calls is the configured business number.

### SMS send pipeline audit

- Thread lookup: implemented through `sms_threads` by `threadId` or by normalized recipient number.
- Company/business lookup: outbound SMS and calls use `TWILIO_PHONE_NUMBER` with `BUSINESS_PHONE_NUMBER` fallback for display.
- Twilio dispatch: outbound SMS now calls `sendSmsDetailed`, captures the Twilio SID, and stores dispatch metadata.
- Error handling/logging: invalid numbers, missing Twilio config, empty messages, and Twilio API failures are returned to the PWA and logged server-side.
- Delivery status updates: added `/api/communications/twilio/status`, updating `sms_messages.status` by Twilio message SID.

## Affected files

- `artifacts/api-server/src/lib/sms.ts` — normalized phone numbers, detailed Twilio dispatch results, business number export, and status-callback support.
- `artifacts/api-server/src/routes/communications.ts` — new communications API, runtime schema bootstrap, Google Contacts OAuth/sync/cache/search, SMS threads/messages, inbound/status webhooks, and native call logging/dispatch.
- `artifacts/api-server/src/routes/index.ts` — mounted the communications router.
- `artifacts/platform/src/pages/communications.tsx` — new staff PWA workspace for SMS, contacts, dial pad, recent/missed calls, and voicemail.
- `artifacts/platform/src/App.tsx` — added the `/communications` route for staff roles.
- `artifacts/platform/src/components/layout.tsx` — replaced the prior implicit phone path with a visible `Phone & SMS` navigation item.
- `artifacts/platform/src/pages/admin/settings-page.tsx` — repaired malformed payment processor rendering that blocked platform typecheck/build.

## Operational follow-up

- Point Twilio Messaging webhooks to `/api/communications/twilio/incoming` and status callbacks can be supplied automatically by outbound sends through `/api/communications/twilio/status`.
- Configure Google OAuth credentials with the redirect URI returned by `/api/communications/google/oauth-url`.
- Configure Twilio Voice with `TWILIO_VOICE_TWIML_URL` or `TWILIO_CALL_HANDLER_URL` for fully native outbound call initiation; otherwise the app logs the call and falls back to the device dialer.
