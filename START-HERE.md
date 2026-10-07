# ccms-core-service — quick start

1. `cp .env.example .env.local` (fill `DATABASE_URL`; the other values work as they are for local use).
2. `npm install`
3. `npm run db:sync` creates the tables.
4. `npm run seed -- --file seed/sample.json` (optional placeholder data)
5. `npm run dev` and check http://127.0.0.1:3003/api/health

This service has **no pages**. To use the system, run `ccms-local-stack` (`npm run dev`) and open http://localhost:3000.
More in README.md.
