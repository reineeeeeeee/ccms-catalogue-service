# ccms-core-service (Catalogue + Calendar)

Part of the Citizen's Charter Compliance/Monitoring System (CCMS). One service = one repository = one database (`ccms_core`).
This service is **Core**: it holds the **Catalogue** (offices, services, standards, checklists, fees and who may avail) and the
**Calendar** (working hours, holidays and suspensions, academic terms, the working-time and deadline engine, and the push of
calendar changes to FMS and Audit). It was `ccms-catalogue-service`; the former `ccms-calendar-service` is merged in.

**API only.** This repository has no screens. Every screen lives in `ccms-frontend`, and the browser reaches this service only
through `ccms-api-gateway` (`/api/catalogue/*` and `/api/calendar/*` both arrive here as `/api/*`).

Stack: Next.js Route Handlers (plain JavaScript, no TypeScript) · TypeORM · PostgreSQL (Neon when deployed; 15+ because the Calendar's
`NULLS NOT DISTINCT` index needs it). Deployed as its own Vercel project.

```
ccms-core-service/
├── src/
│   ├── app/api/            # Route Handlers (the whole API) + jobs/ (cron routes)
│   ├── jobs/               # outbox-dispatch.js, calendar-sync.js: run once, then return
│   └── lib/
│       ├── catalogue/      # offices, services, standards, documents, public-catalogue, seed, catalogue-rules
│       ├── calendar/       # schedule, exceptions, terms, holiday-import, sync, sync-dispatch, engine/, engine-*.js
│       ├── entities/       # TypeORM entities (tables are created from these)
│       ├── data-source.js  # one pooled connection per instance (see below)
│       └── outbox.js         # "send now, after the response" helper
├── vendor/ccms-shared/     # the shared library, vendored (see the root README)
├── mocks/                  # mock FMS and mock Audit (npm run mocks)
├── scripts/                # sync-db.js, seed.js, seed-holidays.js, test-engine-tz.mjs
├── seed/sample.json        # invented placeholder rows only
├── test/                   # node:test tests
├── vercel.json             # cron schedule
└── next.config.js
```

## Run it

```bash
cp .env.example .env.local     # or use ccms-local-stack, which does this for every service
npm install
npm run db:sync                # creates the tables
npm run dev                    # http://127.0.0.1:3003/api/health
npm run mocks                  # optional: mock FMS (4101) and mock Audit (4102) for the Calendar pushes
```

Open the system through the frontend (`http://localhost:3000`), not this port.

## Serverless rules (Vercel)

There is no long-running process on Vercel, so nothing here uses `setInterval` or a background thread.

- **Scheduled work is a route.** Vercel Cron calls `GET /api/jobs/outbox` and `GET /api/jobs/calendar-sync` with
  `Authorization: Bearer $CRON_SECRET`. Each route checks the secret (no secret configured = it never runs, wrong secret = 401),
  runs the job **once** and returns `{ job, sent, failed }`. The schedule is in `vercel.json`.
- **Send right away, safely.** After a change commits, `kickOutbox()` / `kickSync()` ask Next.js to run one dispatch
  *after the response is sent* (`after()`); if that does not happen, the cron job sends it later. Nothing is lost either way,
  because the audit event and the sync rows are written in the same transaction as the change.
- **Overlapping runs are safe.** Both dispatchers claim their rows atomically (`FOR UPDATE SKIP LOCKED` with a short lease), so two
  runs at the same moment never send the same event twice.
- **The public rate limit counts in the database** (table `rate_limit_hits`), because in-memory counters mean nothing when every
  request can land on a different instance. If the table is unreachable, requests are allowed (and a warning is logged) rather than
  taking the public page down.
- **One small pool per instance.** `DATABASE_URL` should be Neon's *pooled* (`-pooler`) host; `DB_POOL_MAX` (default 3) keeps each
  instance's pool small; TLS turns on from `sslmode=require` or `DATABASE_SSL=true`.
- **Cron frequency depends on your Vercel plan.** `vercel.json` uses once-a-day times so it deploys on any plan (the Hobby plan only
  allows daily cron). Because of `after()`, the daily run is only the safety net. On a plan that allows it, change the schedules to
  `*/5 * * * *` to retry failed pushes sooner. Check Vercel's current cron limits before relying on a frequency.

## Database (TypeORM, auto-created)

Tables are created from the entities in `src/lib/entities/` when the service first connects, so you only need an empty database
(`ccms_core`). `npm run db:sync` does it without starting the app. This repository keeps the auto-create behaviour on purpose
(no migration files). On Vercel every cold start would re-check the schema, so after the first deploy you may set
`DB_SYNCHRONIZE=false` and run `npm run db:sync` yourself whenever the entities change.

When upgrading a database created before the three-part duration and multiple-transaction-type model, `npm run db:sync`
preserves and converts those old values before synchronizing the schema. Existing service scope must be classified manually as
`INTERNAL` or `EXTERNAL`; the command stops with a count of unclassified rows because scope cannot be inferred from transaction type.

## Environment

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL`, `DB_SYNCHRONIZE`, `DB_POOL_MAX`, `DATABASE_SSL` | database (see `.env.example`) |
| `IDENTITY_JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE` | token verification |
| `SERVICE_KEY` | shared service key (`x-service-key` header) |
| `CRON_SECRET` | secret Vercel Cron sends to `/api/jobs/*` |
| `LOGS_SERVICE_URL` | where audit events are delivered (outbox job) |
| `PUBLIC_RATE_LIMIT`, `PUBLIC_RATE_WINDOW_SECONDS` | public Catalogue endpoints rate limit (default 60 per 60 s per address) |
| `FMS_URL`, `AUDIT_URL` | Calendar: endpoints that receive calendar pushes (POSTed to exactly as written) |
| `SYNC_RETRY_INTERVAL_SECONDS` (60), `SYNC_MAX_ATTEMPTS` (20), `SYNC_TIMEOUT_SECONDS` (5) | Calendar: retry settings, team-set |
| `CCMS_CALENDAR_URL` (`http://127.0.0.1:3003`), `MOCK_FMS_PORT`, `MOCK_AUDIT_PORT` | used by `npm run mocks` |

## Auth

Every route uses `requirePermission(roles, officeScope)` from `ccms-shared`. Tokens are verified offline
against Identity's public keys (`IDENTITY_JWKS_URL`). Backend-only endpoints use the shared service key.
Errors always use `{ error: { code, message, details, correlation_id, timestamp } }`.

## Catalogue API (Sprint 2)

Served under `/api`; browsers reach it at `/api/catalogue/*` (the Calendar API below at `/api/calendar/*`). Writes are Super Admin only; reads need any signed-in role, narrowed by the access rules below.
Every write records an audit event (with `office_id`) in the same transaction.

| Endpoint | Notes |
| --- | --- |
| `GET /services?office_id&classification&service_scope&status&search&page&page_size` | `service_scope` is `INTERNAL` or `EXTERNAL`. Non-Super-Admin roles always see active services only; Office Head / Office Staff are forced to their own `office_id` (search, paging and `total` count only that office); asking for another office is `403` |
| `POST /services` | Service plus first standard in one transaction; `measurement_type` is always `TIMELINESS` |
| `GET /services/:id` | `{ service, standards, documents }`; inactive is 404 for non-Super-Admin; another office's service is `403` for Office Head / Office Staff |
| `PUT /services/:id`, `PATCH /services/:id/deactivate`, `PATCH /services/:id/reactivate` | Services are never deleted |
| `GET/POST /services/:id/standards`, `DELETE /services/:id/standards/:standardId` | GET: same 404/403 rules as `GET /services/:id`. New version from `effective_from` (not in the past); the previous version ends the day before; only a future version can be deleted |
| `GET /services/:id/standard?asOf=YYYY-MM-DD` | As-of lookup for Transaction; service key (any office) or signed-in token (Office Head / Office Staff: own office only, else `403`); 409 `Service inactive`, 404 unknown |
| `POST /services/:id/documents`, `PUT/DELETE /services/:id/documents/:documentId` | Checklist of document names only; there is no file upload |
| `GET /public/services?search&page&page_size`, `GET /public/services/:id` | No login, rate limited, public fields only (no ids beyond `service_id`, codes, timestamps or `is_active`) |

### Access rules (service catalogue reads)

Enforced on the server, not only in the UI. Everyone signed in can view the catalogue, but the office decides how much:

| Role | Services they can read |
| --- | --- |
| Super Admin | All offices, including inactive services; the only role that can write |
| Executive | All offices (active only); read-only |
| Office Head, Office Staff | Only services of the office in their token (`office_id`), active only |

- `GET /services`: Office Head / Office Staff always get their own office; an explicit `office_id` of another office is `403` (standard error format, no data).
- `GET /services/:id`, `GET /services/:id/standards`: another office's service is `403` with no data. An inactive service is `404` for everyone but Super Admin (checked first).
- `GET /services/:id/standard?asOf=`: the service key is unchanged (any office); a token caller who is Office Head / Office Staff gets `403` for another office's service.
- Writes stay Super Admin only (everyone else `403`). Public endpoints (`/public/services*`) stay open to all, no login, all offices.
- Calendar reads (`GET /schedule`, `/exceptions`, `/terms`, `/holidays`) stay readable by all four roles; `GET /sync/status` is Super Admin only (RBAC doc 4.3); exceptions and holidays for Office Head / Office Staff are campus-wide plus their own office.

Public rate limit: in-memory fixed window per client address (per process). Defaults to 60 requests per 60 seconds, shared by
both public endpoints; set `PUBLIC_RATE_LIMIT` and `PUBLIC_RATE_WINDOW_SECONDS` to change it. Over the limit the answer is
`429` with `Retry-After` (seconds) and the message "Too many requests. Please wait a moment and try again.".

## Seeding (deployment aid, not a system feature)

```bash
npm run seed -- --file seed/sample.json --dry-run   # validate and report only, writes nothing
npm run seed -- --file path/to/your-charter.json    # load it
```

The reviewed 2025 Charter datasets are also included in `seed/` for `CAMP-ADMIN`, `CAMP-ACAD`, `CAMP-OSAS` and
`CAMP-ACCT`. Always run each with `--dry-run` first, then run the real import with
`--actor <responsible-super-admin-account-id>`. `CAMP-OSAS-CRD-005` remains deliberately absent pending confirmation
of the conflicting printed processing totals.

The file has `offices` and `services` (each service: `office_code`, `service_code`, `service_name`, `classification`,
`service_scope`, `transaction_types`, optional `processing_steps`, optional `fees`, optional `who_may_avail`, `standard`, optional `documents`).
`service_scope` is `INTERNAL` or `EXTERNAL`; `transaction_types` is a non-empty list containing `G2C`, `G2G` and/or `G2B` without duplicates.
The `standard` stores `duration_days`, `duration_hours` and `duration_minutes` as non-negative whole numbers, with at least one part greater than zero. Rows go through the same validation
and audit as the API. A duplicate (existing office code, or office + normalised service name) is reported and skipped,
never inserted, so re-running a file adds nothing. A bad row is reported and skipped without stopping the others; the
exit code is 1 if any row had an error. `--actor <user-uuid>` sets the audit actor.

`seed/sample.json` contains invented placeholder rows only. It is not PUP Quezon City Citizen's Charter data: put the
real Charter content in your own file.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js (port 3003) |
| `npm run lint` | ESLint |
| `npm run check:time` | Fails on server-local date methods in `src`, `scripts` and `mocks` (use the Asia/Manila helpers in `ccms-shared`) |
| `npm test` | every test (Catalogue and Calendar), then the engine suite again with the server clock set to UTC and to America/Los_Angeles (`test:engine:tz`) |
| `npm run test:engine:tz` | only the repeated engine runs |
| `npm run db:sync` | Create/update tables from the entities |
| `npm run seed -- --file <path> [--dry-run]` | Load offices, services, first standards and checklists from a JSON file (see Seeding) |
| `npm run mocks` | mock FMS and mock Audit (Calendar) |
| `npm run seed:holidays -- --year 2026 [--dry-run]` | holiday import (deployment aid, see below) |
| `npm run ci` | lint, check:time, test, build |

`ccms-shared` is vendored in `vendor/ccms-shared` and installed as a copy (`install-links=true` in `.npmrc`).

Tests need a PostgreSQL server (`TEST_PG_URL`, default `postgres://postgres:postgres@127.0.0.1:55432/postgres`).

---

# Calendar

The Calendar half: the campus calendar API under `/api` (browsers reach it at `/api/calendar/*` through the gateway; other services call `http://127.0.0.1:3003/api/*` with the shared service key). It shares the database, the audit outbox and the auth helpers with the Catalogue. `GET /api/health` is the single liveness route for both halves (it answers `{ "status": "ok", "service": "core" }`).

PostgreSQL 15 or newer is required: the one-entry-per-date-and-scope rule uses a `NULLS NOT DISTINCT` unique index (the `postgres:16` image of the local stack is fine). The weekly schedule is seeded with Mon-Fri 08:00-17:00 working, Sat/Sun non-working.

Path check: the Catalogue uses `/health`, `/offices`, `/services`, `/public/...`; the Calendar uses `/schedule`, `/exceptions`, `/holidays`, `/terms`, `/working-minutes`, `/deadline`, `/is-working-day`, `/sync/...`. The only shared path was `/health`, which is now one route.

### Conventions

- Times are Asia/Manila (fixed UTC+08:00, no daylight saving). Dates are `YYYY-MM-DD`, times are 24-hour `HH:MM`.
- Errors always look like `{ "error": { "code", "message", "details", "correlation_id", "timestamp" } }`.
- **Auth.** "Signed in" = a valid token of any role. "Super Admin" = write access. "Service key" = header `x-service-key: <SERVICE_KEY>`.
  The engine endpoints and `GET /holidays` and `GET /schedule` accept the service key or any signed-in token (Executive included: they only read). Office Head and Office Staff tokens may only ask about their own `officeId`; the service key may ask about any.
- Every write runs in one transaction with its audit event (`recordAudit` outbox) and its sync rows.
- Catalogue and Calendar share one `audit_outbox` table and one outbox job (`src/jobs/outbox-dispatch.js`); the calendar sync job (`sync_log`, `src/jobs/calendar-sync.js`) is the second scheduled job. Both are cron routes, see "Serverless rules".

### Calendar API (all under `/api`)

| Method and path | Who | Purpose |
| --- | --- | --- |
| `GET /health` | anyone | liveness |
| `GET /schedule` | signed in or service key | the 7 weekday rows |
| `PUT /schedule` | Super Admin | replace the 7 weekday rows |
| `GET /exceptions` | signed in | holidays and suspensions (raw entries) |
| `POST /exceptions` | Super Admin | add one |
| `PUT /exceptions/:id` | Super Admin | replace one |
| `DELETE /exceptions/:id` | Super Admin | remove one (204) |
| `GET /holidays` | signed in or service key | entries effective in a range, recurring ones expanded |
| `GET /terms` | signed in | academic terms |
| `POST /terms` | Super Admin | add a term |
| `PUT /terms/:id` | Super Admin | edit a term |
| `POST /working-minutes` | signed in or service key | working minutes between two instants |
| `POST /deadline` | signed in or service key | working-day deadline |
| `GET /is-working-day` | signed in or service key | window of one date |
| `GET /sync/status` | Super Admin | when Audit last synced, last FMS push, recent pushes |
| `POST /sync/ack` | service key only | Audit's acknowledgment |

The examples use the service key. `$K` is the key, `$T` a Super Admin token.

```bash
K=change-me-dev-service-key
BASE=http://127.0.0.1:3003/api
```

#### Working hours (CC014)

`GET /schedule` always returns 7 rows, `day_of_week` 0 = Sunday ... 6 = Saturday.

```bash
curl -H "x-service-key: $K" $BASE/schedule
```
```json
{ "items": [
  { "day_of_week": 0, "is_working": false, "opening_time": null,    "closing_time": null },
  { "day_of_week": 1, "is_working": true,  "opening_time": "08:00", "closing_time": "17:00" },
  { "day_of_week": 2, "is_working": true,  "opening_time": "08:00", "closing_time": "17:00" },
  { "day_of_week": 3, "is_working": true,  "opening_time": "08:00", "closing_time": "17:00" },
  { "day_of_week": 4, "is_working": true,  "opening_time": "08:00", "closing_time": "17:00" },
  { "day_of_week": 5, "is_working": true,  "opening_time": "08:00", "closing_time": "17:00" },
  { "day_of_week": 6, "is_working": false, "opening_time": null,    "closing_time": null }
] }
```

`PUT /schedule` (Super Admin) takes all 7 days in any order and returns them Sunday first. Times are required on a working day and must be empty on a non-working day.

```bash
curl -X PUT -H "authorization: Bearer $T" -H "content-type: application/json" $BASE/schedule -d '{ "days": [
  { "day_of_week": 0, "is_working": false },
  { "day_of_week": 1, "is_working": false },
  { "day_of_week": 2, "is_working": true, "opening_time": "08:00", "closing_time": "19:00" },
  { "day_of_week": 3, "is_working": true, "opening_time": "08:00", "closing_time": "19:00" },
  { "day_of_week": 4, "is_working": true, "opening_time": "08:00", "closing_time": "19:00" },
  { "day_of_week": 5, "is_working": true, "opening_time": "08:00", "closing_time": "19:00" },
  { "day_of_week": 6, "is_working": true, "opening_time": "08:00", "closing_time": "17:00" } ] }'
```
Response `200 { "items": [ ...7 rows as above... ] }`.

Errors (`400`, code `VALIDATION_ERROR`, the text is in `error.message`): `Closing time must be after opening time`, `At least one working day is required`, `Times must be in 24-hour HH:MM format`, `Opening and closing times are required on a working day`, `Opening and closing times must be empty on a non-working day`, `days must list all 7 days of the week`, `Each day of the week must appear exactly once`. Other roles: `403`. Saving an unchanged schedule does nothing (no audit, no push). Audit action: `WORKING_HOURS_UPDATED` (before and after).

A schedule change applies to computations made afterwards; results a caller already stored are not recomputed.

#### Holidays and suspensions (CC015)

Entry shape: `{ exception_id, exception_date, exception_type, description, office_id, suspended_from, is_recurring, created_at }`.
`exception_type` is `REGULAR_HOLIDAY`, `SPECIAL_NON_WORKING`, `SUSPENSION` or `LOCAL_HOLIDAY`. `office_id` null = campus-wide. `suspended_from` null = the whole day; otherwise working time stops at that time. `is_recurring` (holidays only) repeats on the same month and day every year from the anchor year on (Feb 29 only in leap years). `description` is optional text up to 200 characters.

```bash
curl -X POST -H "authorization: Bearer $T" -H "content-type: application/json" $BASE/exceptions -d '{
  "exception_date": "2026-12-25", "exception_type": "REGULAR_HOLIDAY",
  "description": "Christmas Day", "is_recurring": true }'
```
```json
{ "exception": { "exception_id": "0d5a1b7e-0c3e-4a43-9a52-6f1d3a1d2c11", "exception_date": "2026-12-25",
  "exception_type": "REGULAR_HOLIDAY", "description": "Christmas Day", "office_id": null,
  "suspended_from": null, "is_recurring": true, "created_at": "2026-10-01T02:15:09.412Z" } }
```
`201`. A suspension for one office from 13:00:

```bash
curl -X POST -H "authorization: Bearer $T" -H "content-type: application/json" $BASE/exceptions -d '{
  "exception_date": "2026-10-07", "exception_type": "SUSPENSION", "description": "Power outage",
  "office_id": "11111111-1111-4111-8111-111111111111", "suspended_from": "13:00" }'
```

`PUT /exceptions/:id` takes the same body and replaces the entry. `DELETE /exceptions/:id` answers `204`; removing a recurring entry removes it for every year; the audit keeps the removed values. Audit actions: `CALENDAR_EXCEPTION_ADDED`, `CALENDAR_EXCEPTION_UPDATED`, `CALENDAR_EXCEPTION_REMOVED`, with the entry's `office_id` (null for campus-wide).

Rules and errors:

| Situation | Response |
| --- | --- |
| Same date and same scope (campus-wide, or the same office) already has an entry. A recurring entry also covers the same month and day in its anchor year and later. | `409` `An entry already exists for this date and scope` (enforced by the application check and by the unique index `(office_id, exception_date) NULLS NOT DISTINCT`) |
| `is_recurring: true` on a `SUSPENSION` | `400` `Suspensions cannot be recurring` |
| `suspended_from` outside that date's working hours (opening up to, not including, closing; or the date is not a working day) | `400` `Suspended from time must be within that day's working hours (08:00 to 19:00)` |
| bad date, type, UUID or time | `400` with `error.details.<field>` |
| unknown id | `404` |
| not Super Admin | `403` |

When several entries apply to a date, any whole-day entry wins, otherwise the earliest `suspended_from`. A recurring entry with `suspended_from` is checked against the anchor date's hours.

`GET /exceptions?from=2026-12-01&to=2026-12-31&office_id=&type=` (any signed-in user) returns `{ "items": [ entry, ... ] }` ordered by date. `office_id` matches that office's own entries only; `from`/`to` keep one-time entries dated in the range and recurring entries that occur in it. Office Head and Office Staff only see campus-wide entries and their own office's, and get `403` for another `office_id`.

`GET /holidays?from=&to=&officeId=` (service key or token) returns what is in force in the range, recurring entries expanded per year, never before their anchor year. Without `officeId` only campus-wide entries are listed; with it, campus-wide plus that office's. `from` and `to` are required (at most 3660 days apart).

```bash
curl -H "x-service-key: $K" "$BASE/holidays?from=2026-12-01&to=2027-12-31&officeId=11111111-1111-4111-8111-111111111111"
```
```json
{ "items": [
  { "date": "2026-12-25", "exception_type": "REGULAR_HOLIDAY", "description": "Christmas Day", "office_id": null, "suspended_from": null },
  { "date": "2027-12-25", "exception_type": "REGULAR_HOLIDAY", "description": "Christmas Day", "office_id": null, "suspended_from": null }
] }
```

#### Academic terms (CC016)

Term shape: `{ term_id, term_name, start_date, end_date, created_at, updated_at }`. `GET /terms` (any signed-in user) returns `{ "items": [...] }` by start date.

```bash
curl -X POST -H "authorization: Bearer $T" -H "content-type: application/json" $BASE/terms -d '{
  "term_name": "1st Semester 2026-2027", "start_date": "2026-08-17", "end_date": "2026-12-18" }'
```
`201 { "term": { "term_id": "...", "term_name": "1st Semester 2026-2027", "start_date": "2026-08-17", "end_date": "2026-12-18", ... } }`. `PUT /terms/:id` takes the same body and answers `200 { "term": ... }`.

Errors: `400` `End date must be after start date`; `409` `Term dates overlap an existing term` (terms sharing even one day overlap; also enforced by a database exclusion constraint); `404`; `403`. Audit actions `TERM_ADDED` and `TERM_UPDATED` (before and after). Term dates never affect CCMS's own compliance math.

#### Working-time and deadline engine (CC017, TT3)

Rules, in one place:

1. **Window of a date**: none when the schedule marks the weekday non-working or a whole-day entry applies (campus-wide, or that office's); otherwise opening to closing, cut at the earliest applicable `suspended_from`.
2. **Working minutes** = sum over each Manila date of the overlap of the span with that date's window; whole minutes, rounded down (the overlap is summed first, then rounded once).
3. **Deadline for N working days**: counting starts the day after the start date; the Nth date with a non-empty window is the deadline day; the deadline is that window's closing time. A partially suspended day counts as a working day and closes at the suspension time (team default, PM decision pending).
4. **Hold extension**: from that deadline, move forward through later working windows by the held working minutes; ending exactly at a closing time stays at that closing time.
5. `MINUTES` and `HOURS` standards use working minutes (HOURS x 60); `WORKING_DAYS` standards use `/deadline`. Days are never converted into minutes.

`start`/`end` are ISO-8601 timestamps **with an offset** (`+08:00`, `Z`, `-05:00` ...); a timestamp without an offset is refused, because it would depend on the server's clock. `officeId` is optional: without it only campus-wide entries apply.

`POST /working-minutes`

```bash
curl -X POST -H "x-service-key: $K" -H "content-type: application/json" $BASE/working-minutes \
  -d '{ "start": "2026-10-09T18:00:00+08:00", "end": "2026-10-13T09:00:00+08:00", "officeId": "11111111-1111-4111-8111-111111111111" }'
```
With the schedule Tue-Fri 08:00-19:00, Sat 08:00-17:00, Sun/Mon off: `200 { "working_minutes": 660 }` (Fri 60 + Sat 540 + Tue 60). An end that is not after the start: `400` with message `End must be after start`.

`POST /deadline`

```bash
curl -X POST -H "x-service-key: $K" -H "content-type: application/json" $BASE/deadline \
  -d '{ "start": "2026-10-06T15:00:00+08:00", "workingDays": 3, "heldMinutes": 120, "officeId": null }'
```
`200 { "deadline": "2026-10-10T10:00:00+08:00" }`. `workingDays` is a whole number from 1 to 3000; `heldMinutes` a whole number of 0 or more (default 0). The deadline is always given with `+08:00`.

`GET /is-working-day?date=2026-10-07&officeId=...`

```json
{ "is_working_day": true, "window": { "opening_time": "08:00", "closing_time": "13:00" } }
```
A non-working day gives `{ "is_working_day": false, "window": null }`. `closing_time` is the suspension time on a partly suspended day.

Engine errors are `400` in the standard format (bad timestamp, bad `officeId`, span longer than 3660 days, `End must be after start`). Spans up to 60 days are computed in milliseconds (tested against the 2 second limit).

`GET /schedule` and `GET /holidays` (above) complete the set for Transaction and Reports; all five are callable with the service key.

#### Calendar sharing (CC018, TT2)

Every schedule, holiday/suspension and term change creates sync rows **in the same transaction as the change**: one for FMS and one for Audit for schedule and entry changes, and one for Audit only for term changes (FMS receives calendar data; Audit receives calendar and term data). The calendar sync job (run right after the change, and by cron) POSTs each due row to `FMS_URL` / `AUDIT_URL` with `x-service-key`, marks it `SENT`, and retries `FAILED` rows that are older than `SYNC_RETRY_INTERVAL_SECONDS`, up to `SYNC_MAX_ATTEMPTS` (each cron run is one retry round). A failed push never blocks or undoes the save.

Row status: `PENDING` (created, not sent yet; internal, goes to `SENT` within moments) then `SENT` or `FAILED`; Audit rows become `ACKNOWLEDGED` after `POST /sync/ack`. FMS has no acknowledgment, so FMS rows end `SENT` or `FAILED`.

What FMS and Audit receive (`POST`, JSON):

```json
{ "sync_id": "6e0f4c1a-...", "consumer_system": "FMS", "event_type": "CALENDAR_EXCEPTION_ADDED",
  "entity_type": "calendar_exception", "entity_id": "0d5a1b7e-...", "occurred_at": "2026-10-01T02:15:09.412Z",
  "data": { "exception": { "exception_id": "0d5a1b7e-...", "exception_date": "2026-12-25", "...": "..." } } }
```
`event_type` is one of `WORKING_HOURS_UPDATED` (`data.items`), `CALENDAR_EXCEPTION_ADDED|UPDATED|REMOVED` (`data.exception`, plus `previous` on update and `removed: true` on removal) and `TERM_ADDED|TERM_UPDATED` (`data.term`). The payload and endpoints are still to be agreed with the FMS and Audit teams.

`POST /sync/ack` (service key only)

```bash
curl -X POST -H "x-service-key: $K" -H "content-type: application/json" $BASE/sync/ack -d '{ "sync_id": "6e0f4c1a-..." }'
```
`200 { "sync_id": "6e0f4c1a-...", "status": "ACKNOWLEDGED", "last_synced_at": "2026-10-01T02:15:11.090Z" }`. Missing or wrong key: `401`, nothing changes. Unknown `sync_id`: `404`, nothing changes. An FMS row: `409` (FMS has no acknowledgment). Acknowledging twice keeps the first time.

`GET /sync/status` (Super Admin only)

```json
{ "audit_last_synced": "2026-10-01T02:15:11.090Z",
  "fms_last_push": { "status": "FAILED", "at": "2026-10-01T02:15:09.600Z" },
  "recent": [
    { "sync_id": "6e0f4c1a-...", "consumer_system": "AUDIT", "event_type": "CALENDAR_EXCEPTION_ADDED", "status": "ACKNOWLEDGED", "last_synced_at": "2026-10-01T02:15:11.090Z", "attempts": 1 },
    { "sync_id": "9a3b7d20-...", "consumer_system": "FMS",   "event_type": "CALENDAR_EXCEPTION_ADDED", "status": "FAILED", "last_synced_at": null, "attempts": 2 }
  ] }
```
`audit_last_synced` is the latest Audit acknowledgment (null if none); `fms_last_push` is the latest FMS row; `recent` lists the newest 20 rows.

#### Mocks (`npm run mocks`)

Mock FMS on `4101`, mock Audit on `4102`; both record the pushes they accept and answer `401` to a wrong service key. Point `FMS_URL` / `AUDIT_URL` at them (any path is accepted for a push).

```bash
curl localhost:4101/received                                   # { system, fail, rejected, count, items: [{ received_at, path, body }] }
curl -X POST localhost:4101/mode -d '{"fail":true}'            # the mock now answers 503 (switch back with false)
curl -X DELETE localhost:4101/received                         # forget recorded pushes
curl -X POST localhost:4102/ack -d '{"sync_id":"6e0f4c1a-..."}'  # Audit only: POSTs the acknowledgment to $CCMS_CALENDAR_URL/api/sync/ack with the service key
```

End-to-end check by hand: save a holiday, `GET :4101/received` and `GET :4102/received` each show one push, `POST :4102/ack` turns the Audit row to `ACKNOWLEDGED` and `GET /api/sync/status` shows `audit_last_synced`. Switch FMS to fail, save another holiday (it still saves), see the FMS row `FAILED`, switch it back and watch it become `SENT` on the next retry.

#### Holiday import (deployment aid, not a feature)

```bash
npm run seed:holidays -- --year 2026 --dry-run    # shows what would be added, writes nothing
npm run seed:holidays -- --year 2026              # adds them
npm run seed:holidays -- --year 2026 --actor <super admin user id>   # audit actor (default: a fixed system id)
```
It fetches `https://date.nager.at/api/v3/PublicHolidays/{year}/PH` and maps each holiday (`date`, `name`) to an ordinary campus-wide `REGULAR_HOLIDAY` entry with `is_recurring` false; the Super Admin can edit, delete or mark them recurring afterwards. Dates that already have a campus-wide entry (one-time or recurring) are skipped, so running it again adds nothing. Imported entries are audited and pushed like any other.
Needs internet access to `date.nager.at`. **The development sandbox cannot reach that API, so the importer is tested only with an injected `fetch`** (`test/calendar-holiday-import.test.js`); the first real run should be a `--dry-run`. Holidays that move each year and proclaimed special non-working days are entered per year by the Super Admin.

### Data rules in the database

`working_hours` (7 rows, CHECK on times), `calendar_exceptions` (unique `(office_id, exception_date) NULLS NOT DISTINCT`, CHECKs on type, time format and "no recurring suspension"), `term_dates` (CHECK `end_date > start_date`, exclusion constraint against overlapping ranges), `sync_log` (CHECKs on consumer and status). `office_id` values are not validated against the Catalogue's office list (there is deliberately no foreign key from `calendar_exceptions.office_id` to `offices`).

### Calendar tests

`npm test` runs everything: the engine suite with fixed expected values for CC017 AC1-AC15 and the TT1 extras (same non-working day = 0, before opening to after closing = the full window, a span across a year end), a minute-by-minute cross-check, the CC014-CC018 acceptance criteria, the office-boundary suite (`runBoundarySuite`) and the TT2 end-to-end runs against the mocks. The engine suite and the engine endpoints then run again with `TZ=UTC` and `TZ=America/Los_Angeles` (`scripts/test-engine-tz.mjs`; files `test/calendar-*.test.js` and `test/calendar-engine/`), so any dependence on the server clock fails CI. The engine itself (`src/lib/engine/`) is a pure module: the schedule and the exceptions are injected, it does no I/O and never reads the clock.
