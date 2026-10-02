// Starts this service together with its embedded gateway: one command, one address.
//   npm run dev     Next.js in development mode
//   npm start       Next.js production server (run `npm run build` first)
//
// The Next.js server of this app runs privately on PORT + 10000 and the gateway listens on the public
// PORT. The gateway sends this app's own pages and APIs to that private server and passes everything
// that belongs to another service (Identity, Catalogue and Calendar, Logs) to that service's address,
// so the browser sees ONE address for the whole system. If another service is down, only its own
// pages and APIs stop working here.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createTokenCheck } from './gateway/auth.js';
import { serviceTargets } from './gateway/routes.js';
import { createGateway } from './gateway/server.js';

const mode = process.argv[2] === 'start' ? 'start' : 'dev';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const { service, port: defaultPort } = pkg.ccms;

// Load .env.local / .env first (values already set in the shell win), like Next.js does.
for (const file of ['.env.local', '.env']) {
  let text;
  try {
    text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  } catch {
    continue; // file not present
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

// Services this app owns (the Calendar lives in the Catalogue repo).
const OWNS = { identity: ['identity'], catalogue: ['catalogue', 'calendar'], logs: ['logs'] }[service] ?? [service];

const publicPort = Number(process.env.PORT || defaultPort);
const innerPort = publicPort + 10_000;
const self = `http://127.0.0.1:${innerPort}`;

const targets = serviceTargets();
for (const name of OWNS) targets[name] = self;

const flag = (name, fallback) => {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : ['true', '1', 'yes'].includes(value.toLowerCase());
};

const tokenCheck = flag('VERIFY_TOKENS', true)
  ? createTokenCheck({
      jwksUrl: process.env.IDENTITY_JWKS_URL || `${targets.identity}/api/auth/jwks`,
      issuer: process.env.JWT_ISSUER || 'ccms-identity',
      audience: process.env.JWT_AUDIENCE || 'ccms',
    })
  : undefined;

// Start this app's own Next.js server on the private port.
const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');
const child = spawn(process.execPath, [nextBin, mode, '-H', '127.0.0.1', '-p', String(innerPort)], {
  stdio: 'inherit',
  env: { ...process.env, PORT: String(innerPort) },
});
child.on('exit', (code) => process.exit(code ?? 0));

const gateway = createGateway({ targets, self, tokenCheck, requireTls: flag('REQUIRE_TLS', false), trustProxy: flag('TRUST_PROXY', false) });
const host = process.env.HOST || '127.0.0.1';
gateway.listen(publicPort, host, () => {
  console.log(`[${service}] open http://localhost:${publicPort}  (gateway embedded; app runs privately on ${innerPort})`);
});

const stop = () => {
  child.kill();
  gateway.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
