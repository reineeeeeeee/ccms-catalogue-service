import { json, route } from 'ccms-shared';

export const dynamic = 'force-dynamic';

export const GET = route(async () => json({ status: 'ok', service: 'core' }));
