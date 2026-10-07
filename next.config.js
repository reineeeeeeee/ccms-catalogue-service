// Core (Catalogue + Calendar) is an API-only service: no pages, no static assets. The browser never
// calls it directly; every request arrives through ccms-api-gateway, the only public entry point.
/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['pg', 'typeorm'],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
