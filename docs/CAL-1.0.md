# Calendar message cal-1.0 — Core side (BE Dev 1)

Status: built in Core, tested only against Core's own test suite. NOT yet tested against FMS. Field names marked PROPOSED must be confirmed against the FMS contract document.

## 1. Sample message (EB8)

**These samples were generated from Core's message builder (`src/lib/calendar/message.js`) with made-up IDs. They are NOT captured from a real feed.** A real captured message needs a running stack and a real FMS receiver; that has not been done.

Part-day suspension, revision 2 (the effect switch is ON in this sample, so `effect` is present):

```json
{
  "messageId": "7d0c1a52-8f3e-4b0a-a1f4-5e2b9c3d4e11",
  "schemaVersion": "cal-1.0",
  "entityId": "0b6f6b0e-4c1e-4f3a-9d57-2f1d6a9c1e01",
  "entityRevision": 2,
  "changeKind": "UPSERT",
  "entryType": "SUSPENSION",
  "date": "2026-10-07",
  "description": "Power outage",
  "officeId": null,
  "appliesTo": [
    "CLASSES",
    "WORK"
  ],
  "interval": {
    "start": "2026-10-07T13:00:00+08:00",
    "end": "2026-10-07T17:00:00+08:00",
    "allDay": false
  },
  "mode": null,
  "effect": "SUSPENDED"
}
```

The same entry removed (tombstone), revision 3:

```json
{
  "messageId": "9a1e2b33-6c4d-4e5f-8a7b-1c2d3e4f5a66",
  "schemaVersion": "cal-1.0",
  "entityId": "0b6f6b0e-4c1e-4f3a-9d57-2f1d6a9c1e01",
  "entityRevision": 3,
  "changeKind": "REMOVE",
  "entryType": "SUSPENSION",
  "date": "2026-10-07",
  "description": "Power outage",
  "officeId": null,
  "appliesTo": [
    "CLASSES",
    "WORK"
  ],
  "interval": {
    "start": "2026-10-07T13:00:00+08:00",
    "end": "2026-10-07T17:00:00+08:00",
    "allDay": false
  },
  "mode": null,
  "effect": "SUSPENDED"
}
```

Envelope fields named in the FMS brief: `messageId`, `schemaVersion` ("cal-1.0"), `entityId`, `entityRevision`, `changeKind` (UPSERT | REMOVE), `appliesTo`, `interval {start,end,allDay}`, `effect`, `mode`.
PROPOSED by Core (not named in the brief): `entryType`, `date`, `description`, `officeId`.
Open points: whole day is written `00:00` to `T24:00:00` (confirm FMS accepts 24:00); `mode` is always null; `effect` appears only while `CAL_EFFECT_ENABLED=true` and is null on WORK-only and one-office entries.
`messageId` is the sync row's own ID, so every retry of the same message repeats it.

## 2. Migration plan to cal-1.0

1. Deploy the Core code, then run `npm run migrate:sprint4` (additive and repeatable). It adds `suspended_until`, `revision` (starts at 1), `removed_at`, three checks, and replaces the one-entry-per-date index with one that ignores removed entries. No existing row is changed or deleted.
2. Old part-day entries (a start but no end) keep their old effect (suspended until closing) but are NOT sent: they must be given an end time first. `npm run readiness` lists them.
3. Old one-office entries that affect classes break rule C42. They are not rewritten; the check is created NOT VALID so old rows stay, and every new or changed row must obey it. `npm run readiness` lists them for the PM to decide.
4. Cutoff: messages already queued in the old shape are not converted. Before switching FMS to cal-1.0, let the queue drain (or mark old PENDING/FAILED FMS rows) so FMS never receives a mix. `WORKING_HOURS_UPDATED` is no longer sent to FMS at all (SMS/audit only).
5. After FMS is ready, FMS pulls `GET /declarations` for 2026-08-17 to 2026-12-12 to get the full current picture, then follows pushes.

## 3. Pull route (EB6)

`GET /api/declarations?from=YYYY-MM-DD&to=YYYY-MM-DD&cursor=&limit=` (browsers/Gateway: `/api/calendar/declarations`). Machine key only: `Authorization: Bearer ccms_mk_...` with the read-calendar scope (EB7, see `docs/MACHINE-KEYS.md`). A user token, the shared service key, a missing, expired or revoked key all get 401. PROPOSED: the Bearer header; FMS to confirm.
PROPOSAL for FMS: default page size 100, maximum 500; the reply is `{ schemaVersion, from, to, items, nextCursor }`; send `nextCursor` back unchanged until it is null. Items are cal-1.0 bodies without a messageId; removals appear as REMOVE. Range at most one year. The Gateway route for the machine caller is NOT done here (Gateway repo not in scope); the Gateway must pass the Authorization header through unchanged.

## 4. Switches (all default OFF or unset)

| Variable | Meaning |
| --- | --- |
| `CAL_EFFECT_ENABLED` | `true` = send `effect` and ONLINE entries to FMS (EB5) |
| `SMS_SYNC_ENABLED` | `true` = the SMS (AUDIT) receiver gets pushes (EB16) |
| `CAL_WINDOW_FROM`, `CAL_WINDOW_TO` | dates a recurring entry is expanded for; default 2026-08-17 to 2026-12-12 (PM to confirm) |

## 5. EB2 — PUP setup and office list (operations step, not yet run)

Tell QA first: setup changes default behaviour that TC4-OPS-010, TC4-TXN-020 and TC4-CAL-012 test. Either let QA test the default state first, or keep a database copy.
1. `npm run setup:pup -- --actor <super-admin-account-id>` (sets institution PUP and turns class/office suspensions on).
2. Confirm the settings read back (`GET /catalogue/settings`).
3. `npm run readiness -- --offices > offices.csv` gives active offices as ID, code, name for FMS. Save one export BEFORE the PUP- re-coding; afterwards `npm run readiness -- --baseline offices-before.csv` fails if an office ID is gone or a saved code now belongs to a different ID, and lists re-coded offices as INFO.
   Audit log append-only is NOT checked here: the audit log lives in the Logs service (Core only keeps an outbox), so that check belongs to the Logs service.

## 6. Readiness (EB15)

`npm run readiness` prints PASS / FAIL / INFO per check and exits 1 on any FAIL. It is read-only (constraint probes are rolled back). INFO lines (terms, inactive offices, tombstone count) need a person to read them.

## 7. EB17 — Term snapshot for SMS (built against a stand-in; SMS names NOT confirmed)

Nothing leaves CCMS while `SMS_SYNC_ENABLED` is off. Everything SMS-specific is in `src/lib/calendar/sms-snapshot.js` and marked PROPOSED.
- A snapshot is the full state of one term: every live entry that falls in the term's dates, with `type`, `appliesTo`, `interval` (part-day suspensions carry start and end) and `effect`. Entries that were withdrawn are simply absent. Part-day entries with no end time are listed under `skipped`.
- A new snapshot is queued in the same transaction as every added, corrected or withdrawn entry, for each term the entry falls in. A newer snapshot marks any undelivered older one of that term `SUPERSEDED`, so SMS never gets an older snapshot after a newer one.
- `syncId` is the sync row's ID and does not change on a retry.
- The reply is stored in `sync_log.reply`. PROPOSED reply: `{ status: "SUCCESS" | "FAILED", termId, applied: {...}, reason }`. A `FAILED` reply is retried like any failed push and its reason is kept in `last_error`.
- Open with SMS: exact field and type names (`SMS_TYPE_MAP`), how a withdrawn entry should be shown (question 1), and the term code (EB18). Until EB18, the term name is used as a TEST term code.
- The per-entry SMS messages of EB16 are still queued as before. Decide with SMS whether they want both.
- Existing databases: run `npm run db:sync` once. It adds `sync_log.reply` and replaces the `sync_log_status_ck` check so it allows `SUPERSEDED`.
