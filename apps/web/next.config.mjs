/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  // Next 16 no longer lints during `next build` (the `eslint` option was
  // removed); linting runs as its own CI step via the root eslint.config.mjs.
  serverExternalPackages: ['@kubernetes/client-node', '@prisma/client', 'ws', '@anthropic-ai/claude-code', 'pg'],
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  env: {
    NEXT_TELEMETRY_DISABLED: '1'
  }
}

export default nextConfig
