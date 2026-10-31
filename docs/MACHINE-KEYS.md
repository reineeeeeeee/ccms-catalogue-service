# Machine keys (EB7)

Keys for systems that call CCMS. Today: FMS pulling `GET /api/declarations`. Later: SMS (EB19). Built as our own keys, NOT Clerk machine keys. The task says "to decide: Clerk or our own"; this is the "own" option, chosen so it could be built and tested now. PM/developers can still switch.

## Rules (from the task)
- One active key per caller (FMS, SMS) and environment (development, test, staging, production).
- Expires 90 days after it is issued.
- Rotation: a new key is issued; the old one keeps working for 0 to 7 days (default 7), never past its own expiry; then only the new one works.
- Revocation takes effect on the next request.
- An expired, revoked, wrong or missing key gets the same 401 (`INVALID_MACHINE_KEY`).
- The key is shown once, in the reply that creates it. Only a SHA-256 hash is stored. Audit events (`MACHINE_KEY_ISSUED`, `MACHINE_KEY_ROTATED`, `MACHINE_KEY_REVOKED`) hold metadata only.

## API (Super Admin only; browsers reach it under `/api/calendar/machine-keys` through the Gateway)
| Call | Effect |
|---|---|
| `POST /machine-keys` `{caller, environment}` | Issue. 201 with `key` (once). 409 if that caller already has an active key there. |
| `POST /machine-keys/:id/rotate` `{overlap_days?}` | New key (201, `key` once); old key expires after the overlap. |
| `POST /machine-keys/:id/revoke` | Revoke now. |
| `GET /machine-keys` | Metadata only. |

The caller sends `Authorization: Bearer ccms_mk_<ref>.<secret>` (PROPOSED header, FMS to confirm).

## Not done / open
- Clerk vs our own: undecided.
- The other direction (the key FMS issues for our push) is an environment secret on our side. Nothing to build; it must be set in the environment, never in code or chat.
- The pull route (`GET /api/declarations`) accepts only keys issued to FMS: a key issued to SMS gets the same 401. Other routes for SMS (EB19) are not built yet; they should pass `'SMS'` to `requireMachineKey`.
- Run `npm run migrate:sprint4` to create the `machine_keys` table.
