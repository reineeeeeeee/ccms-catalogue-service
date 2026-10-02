export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Connect and create the tables as soon as the service starts.
  try {
    const { getDb } = await import('./lib/data-source.js');
    await getDb();
    console.log('[catalogue] database ready');
  } catch (err) {
    console.error('[catalogue] database is not ready:', err.message);
  }

  const { startDispatcher } = await import('./lib/outbox.js');
  startDispatcher();

  // Pushes calendar and term changes to FMS and Audit (and retries failed pushes).
  const { startSyncRuntime } = await import('./lib/sync-runtime.js');
  startSyncRuntime();
}
