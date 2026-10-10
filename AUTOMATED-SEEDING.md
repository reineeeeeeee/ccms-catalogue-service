# Automated Development Seeding

## Goal

Allow a developer to clone or pull this repository and prepare the local Catalogue database automatically when running:

```bash
npm install
npm run dev
```

The automated process should:

1. Synchronize the database schema.
2. Import the reviewed Citizen's Charter seed files.
3. Start the Next.js development server.

## Recommended approach

Add a development-only bootstrap script and run it through npm's `predev` lifecycle hook. npm automatically executes `predev` before `dev` when a developer runs `npm run dev`.

Suggested `package.json` scripts:

```json
{
  "scripts": {
    "predev": "npm run db:bootstrap",
    "db:bootstrap": "node --env-file-if-exists=.env.local scripts/bootstrap.js",
    "dev": "next dev -p 3003"
  }
}
```

The proposed `scripts/bootstrap.js` should:

1. Apply the same database synchronization performed by `npm run db:sync`.
2. Seed these reviewed datasets in order:

   - `seed/CCMS_SEED_CAMPADMIN_10062026.json`
   - `seed/CCMS_SEED_CAMPACAD_10062026.json`
   - `seed/CCMS_SEED_CAMPSAS_10062026.json`
   - `seed/CCMS_SEED_CAMPACCT_10062026.json`

3. Stop with a non-zero exit code if database synchronization or any seed import fails.
4. Close the database connection before the development server starts.

Do not include `seed/sample.json` in the automated import. It contains placeholder data, not reviewed Citizen's Charter records.

## Why rerunning is safe

The existing seed implementation is idempotent for its supported records. It skips:

- An office when its office code already exists.
- A service when the same office already has a service with the same normalized name.

Therefore, running `npm run dev` again should report existing records as duplicates instead of inserting another copy.

## Developer prerequisites

Before running the service, each developer must:

1. Have PostgreSQL running.
2. Copy `.env.example` to `.env.local` or let `ccms-local-stack` create it.
3. Ensure `DATABASE_URL` points to the developer's local Catalogue database.
4. Install dependencies with `npm install`.

After that, the normal command is:

```bash
npm run dev
```

The database bootstrap will run first, followed by the service at `http://127.0.0.1:3003`.

## Safety rules

- Attach automatic seeding to `predev` only. Do not attach it to `start`, `build`, or `ci`.
- Do not use `postinstall` for database seeding. Package installation also runs in CI and deployment environments and could write to a production database.
- Never commit `.env.local` or database credentials.
- Commit all seed JSON files required by the bootstrap; untracked files are not included when another developer pulls the repository.
- Keep production and shared-database seeding explicit, reviewed, and performed with the responsible Super Admin actor ID.

## Explicit alternative

If the team does not want database work to run before every development start, expose the same bootstrap as a manual setup command without adding `predev`:

```bash
npm run db:bootstrap
npm run dev
```

This requires one extra command but makes the database write explicit.

