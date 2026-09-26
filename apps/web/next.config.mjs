/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // Disable font optimization so builds succeed without internet access to fonts.gstatic.com
  optimizeFonts: false,
  // Linting runs as its own CI step (root eslint.config.mjs); don't let
  // `next build` lint (or fail) the production image build.
  eslint: { ignoreDuringBuilds: true },
  serverExternalPackages: ['@kubernetes/client-node', '@prisma/client', 'ws', '@anthropic-ai/claude-code', 'pg'],
  env: {
    NEXT_TELEMETRY_DISABLED: '1'
  }
}

export default nextConfig
