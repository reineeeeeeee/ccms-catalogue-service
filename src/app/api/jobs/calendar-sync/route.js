import { cronRoute } from 'ccms-shared';
import { runCalendarSync } from '../../../../jobs/calendar-sync.js';

export const dynamic = 'force-dynamic';

// Vercel Cron calls this (see vercel.json) with "Authorization: Bearer $CRON_SECRET".
// It pushes due calendar and term changes to FMS and Audit and retries the ones that failed.
export const GET = cronRoute('calendar-sync', () => runCalendarSync());
