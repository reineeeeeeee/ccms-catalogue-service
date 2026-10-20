# Sprint 4 Core fixes implementation record

**Date:** October 20, 2026

**Repository:** `ccms-catalogue-service`

**Source:** `CCMS_SPRINT4_PROGRESS_AUDIT_10202026.md`

**Scope:** Finding 1 and Finding 2 / TT3 only

## Summary

The two Core integration gaps identified in the Sprint 4 progress audit have been implemented locally:

1. The service-standard lookup now returns `office_code` and `classification`, which Operations requires when starting a transaction.
2. Core now provides `POST /api/add-working-minutes`, which Operations requires when computing compliance for standards with a working-days component.

No Identity, Gateway, Frontend, Operations or Oversight production code was changed as part of this work.

## Finding 1: complete the standard lookup response

### Audit finding

Operations calls `GET /api/services/:id/standard?asOf=YYYY-MM-DD` before starting a transaction. Its Core client requires the response to include:

- `standard_id`
- `duration_days`
- `duration_hours`
- `duration_minutes`
- `service_code`
- `service_name`
- `office_id`
- `office_code`
- `classification`

Core previously omitted `office_code` and `classification`. Operations therefore rejected the real Core response as an unreadable standard, even though its tests passed against a fake Core that supplied both fields.

### Implementation

`src/lib/catalogue/standards.js` was updated so the as-of lookup:

- joins the `offices` table using the service's `office_id`;
- selects `o.office_code`;
- selects `s.classification`; and
- returns both fields in the response DTO.

The response now has the contract expected by Operations:

```json
{
  "standard_id": "00000000-0000-4000-8000-000000000001",
  "duration_days": 3,
  "duration_hours": 0,
  "duration_minutes": 0,
  "service_code": "PUP-OSAS-CNS-001",
  "service_name": "Example service",
  "office_id": "00000000-0000-4000-8000-000000000002",
  "office_code": "PUP-OSAS",
  "classification": "COMPLEX"
}
```

### Test changes

`test/services.test.js` now verifies that the exact transaction-side response includes the service's `office_code` and `classification`. Existing service-key and office-access tests continue to cover this endpoint.

## Finding 2 / TT3: add working minutes

### Audit finding

Operations calls `POST /api/add-working-minutes` while computing compliance for a standard containing working days plus an hours/minutes component. Core previously provided `/working-minutes` and `/deadline`, but not `/add-working-minutes`.

### Endpoint implemented

```text
POST /api/add-working-minutes
```

Request:

```json
{
  "datetime": "2026-10-09T19:00:00+08:00",
  "minutes": 120,
  "officeId": "00000000-0000-4000-8000-000000000002"
}
```

Response:

```json
{
  "datetime": "2026-10-10T10:00:00+08:00"
}
```

### Implemented behavior

- `datetime` must be an ISO-8601 timestamp containing a timezone offset.
- `minutes` must be a whole number of zero or more.
- `officeId` is optional, but must be a valid UUID when supplied.
- The calculation moves forward only through configured working windows.
- Non-working days, holidays and applicable suspensions are skipped.
- Office-specific calendar entries apply only to that office.
- A result exactly at closing time remains at that closing time.
- Zero minutes returns the same instant, formatted with the Manila `+08:00` offset.
- The endpoint is callable with the shared service key or a signed-in token.
- Office Head and Office Staff callers cannot calculate against another office.

### Code changes

- Added `src/app/api/add-working-minutes/route.js`.
- Exposed the calendar engine's forward-working-time calculation as `computeAddedWorkingMinutes`.
- Added the `addWorkingMinutes` service method in `src/lib/calendar/engine-service.js`.
- Reused the existing Calendar authentication and office-boundary checks.
- Documented the endpoint and request/response example in `README.md`.

No database schema change was required.

## Files changed

| File | Change |
|---|---|
| `src/lib/catalogue/standards.js` | Added `office_code` and `classification` to the as-of standard lookup. |
| `src/lib/calendar/engine/working-time.js` | Exposed and validated the add-working-minutes calculation. |
| `src/lib/calendar/engine-service.js` | Added the API-facing add-working-minutes service method. |
| `src/lib/calendar/engine-auth.js` | Clarified that calculation POST endpoints are read-only computations. |
| `src/app/api/add-working-minutes/route.js` | Added the new TT3 route. |
| `test/services.test.js` | Added Finding 1 contract assertions. |
| `test/calendar-engine/working-time.test.js` | Added pure-engine TT3 tests. |
| `test/calendar-engine-api.test.js` | Added TT3 API, validation, authentication and boundary tests. |
| `README.md` | Documented the new endpoint. |

## Verification results

### Passed

- Calendar API suite: **40/40 passed**.
- Finding 1 standard-response tests passed against PostgreSQL.
- Catalogue suite: **119/121 passed**; both failures were outside Findings 1 and 2.
- Full repository test run: **372/374 passed**.
- Source syntax checks passed for all changed production files.
- `git diff --check` passed.
- The time-safety source scan passed.

### Unrelated full-suite failures

The two remaining failures are Windows test-harness failures in existing test paths:

1. A source-tree scanning test constructs a malformed path similar to `C:\C:\...` from a `file:` URL.
2. A seed CLI test fails while spawning `C:\Program Files\nodejs\node.exe` with `ENOENT` in the test environment.

Neither failure exercises the standard-response change or the add-working-minutes implementation.

### Checks that did not complete

- The cross-time-zone wrapper timed out while its spawned UTC test run was still executing.
- ESLint timed out in this environment without emitting a lint violation.

These incomplete checks are recorded and are not presented as passing.

## Current status and release steps

The two audit blockers are implemented and covered locally. They are not a complete Sprint 4 implementation.

1. Review and publish these changes through the team's branch process.
2. Run a live Operations-to-Core transaction-start test.
3. Run a live completion test for a standard containing working days plus an hours/minutes component.

## Explicitly outside this implementation

- Identity sign-in limiting and refresh-token rotation.
- TT6 institution and office codes.
- TT7 Calendar `applies_to` and `class_mode`.
- TT8 system-built service codes.
- TT9 add-step behavior.
- TT10 date and time presentation.
- Sprint 4 frontend screens.
- Gateway Operations-route tests.
- Carry-over `GET /public/offices`.
- PM decisions B15, who may hold a transaction, and auto-close threshold values.
