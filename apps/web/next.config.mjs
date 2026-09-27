/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  // Linting runs as its own CI step (root eslint.config.mjs); don't let
  // `next build` lint (or fail) the production image build.
  eslint: { ignoreDuringBuilds: true },
  serverExternalPackages: ['@kubernetes/client-node', '@prisma/client', 'ws', 'pg'],
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  env: {
    NEXT_TELEMETRY_DISABLED: '1'
  }
}

export default nextConfig
