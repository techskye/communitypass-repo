import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
const here = path.dirname(fileURLToPath(import.meta.url));

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(here, '../..'),
  poweredByHeader: false,
  transpilePackages: ['@communitypass/shared'],
  // Same-origin API proxy for local development. In production, Caddy routes /api/* straight
  // to the API (keeps client IPs for rate limiting and raw bodies for webhook signatures).
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
