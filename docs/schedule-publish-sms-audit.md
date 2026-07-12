# Schedule Publish SMS Notification Flow Audit

## Scope

This audit is limited to employee schedule publishing notifications. It is **not** a marketing campaign feature, and it must not create campaign tables, campaign recipient tables, or campaign routes.

## Current traced execution path

1. **Publish Schedule button:** no employee schedule publishing page, button, or client mutation exists under `artifacts/platform/src`. The only schedule-related frontend code found is role permission labels and unrelated staff/shift/visual-editor UI.
2. **Frontend API request:** no frontend call to a schedule publish endpoint exists.
3. **Backend publish route:** no backend schedule publish route exists under `artifacts/api-server/src/routes`; the only schedule permission string is `schedules.publish` in the RBAC permission list.
4. **Schedule persistence:** no schedule persistence model/table for employee schedules exists in `lib/db/src/schema`; shift/timeclock tables exist, but they are not employee schedule publishing tables.
5. **Notification generation:** no schedule-change notification generation function exists.
6. **Twilio send:** no schedule-publish execution path calls a Twilio SMS sender.
7. **`sms_messages` insert:** no `sms_messages` or `sms_threads` schema/model references exist in this repository, so no schedule-publish path can insert SMS audit records.

## Where execution stops

Execution stops before the first application call: there is no repository implementation of the **Publish Schedule button** or its API request. Consequently, the backend schedule publish route, changed-employee diffing, transactional SMS send, and `sms_messages` insert are all absent from this repository.

## Findings requested

- **Call stack:** none exists in this repository for schedule publish SMS. The expected stack would be `Publish Schedule button -> schedule publish API request -> backend publish route -> save schedule -> determine changed employees -> generate notification events -> send transactional SMS -> insert sms_messages`, but no concrete implementation of that stack is present.
- **Missing function call:** the missing call is from the schedule publish backend handler to a transactional notification function, for example `notifyEmployeesOfScheduleChanges(changedEmployees, scheduleContext)`. The backend handler itself is also absent.
- **Conditional preventing sends:** no conditional is preventing sends; the send path is unreachable because the schedule publish flow is not implemented.
- **Exception swallowed:** no schedule notification exception is swallowed in this repository because there is no schedule notification send block.
- **Notification preference issue:** the reusable notification preference helper supports checking `notificationPreferences.smsTexts`, but no schedule publish flow calls it for affected employees.
- **Minimal code fix:** implement the missing schedule publish notification hook at the existing schedule publish boundary once that boundary exists: after schedule persistence succeeds and changed employees are known, iterate affected employees, skip users without `notificationPreferences.smsTexts`, send one transactional SMS per opted-in employee, insert one `sms_messages` record per send attempt, and catch/log per-recipient failures without aborting publish.

## Campaign cleanup

The previous SMS campaign implementation was removed from this branch because campaign tables/routes are unrelated to employee schedule publishing and violate this audit scope.
