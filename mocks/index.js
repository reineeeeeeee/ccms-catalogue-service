// `npm run mocks` starts a mock FMS (port 4101) and a mock Audit (port 4102).
import { createMockServer } from './mock-server.js';

const serviceKey = process.env.SERVICE_KEY || 'change-me-dev-service-key';
const ccmsUrl = process.env.CCMS_CALENDAR_URL || 'http://127.0.0.1:3003';
const fmsPort = Number(process.env.MOCK_FMS_PORT) || 4101;
const auditPort = Number(process.env.MOCK_AUDIT_PORT) || 4102;

const fms = createMockServer({ name: 'FMS', serviceKey, ccmsUrl });
const audit = createMockServer({ name: 'AUDIT', serviceKey, ccmsUrl });

await fms.listen(fmsPort);
await audit.listen(auditPort);
console.log(`Mock FMS   http://127.0.0.1:${fmsPort}   GET /received, POST /mode {fail}`);
console.log(`Mock Audit http://127.0.0.1:${auditPort}   GET /received, POST /mode {fail}, POST /ack {sync_id} -> ${ccmsUrl}/api/sync/ack`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await Promise.all([fms.close(), audit.close()]);
    process.exit(0);
  });
}
