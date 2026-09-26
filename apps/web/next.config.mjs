/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ['@kubernetes/client-node', '@prisma/client', 'ws', '@anthropic-ai/claude-code', 'pg'],
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  env: {
    NEXT_TELEMETRY_DISABLED: '1'
  }
}

export default nextConfig
