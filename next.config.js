// Services are only reachable through the API gateway. The gateway serves this app's static
// assets under /_ccms/catalogue so several Next.js apps can share one browser origin.
const assetPrefix = process.env.ASSET_PREFIX ?? '/_ccms/catalogue';

// The pages in this repo sign people in through the Identity service. Behind the gateway
// /api/identity/* is routed for us; when this app runs on its own port, set IDENTITY_SERVICE_URL
// (e.g. http://127.0.0.1:3001/api) and this forwards the session calls (refresh, logout) to it.
const identityUrl = (process.env.IDENTITY_SERVICE_URL ?? '').replace(/\/$/, '');

// The browser calls /api/catalogue/* and /api/calendar/*. Behind the gateway those are mapped to
// /api/*; on its own port these rewrites do the same, so the pages work both ways.
/** @type {import('next').NextConfig} */
const nextConfig = {
  assetPrefix: assetPrefix || undefined,
  serverExternalPackages: ['pg', 'typeorm'],
  poweredByHeader: false,
  reactStrictMode: true,
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  async rewrites() {
    const rules = [
      { source: '/api/catalogue/:path*', destination: '/api/:path*' },
      { source: '/api/calendar/:path*', destination: '/api/:path*' },
    ];
    if (identityUrl) rules.push({ source: '/api/identity/:path*', destination: `${identityUrl}/:path*` });
    return rules;
  },
};

export default nextConfig;
