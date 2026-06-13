/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // Disable font optimization so builds succeed without internet access to fonts.gstatic.com
  optimizeFonts: false,
  serverExternalPackages: ['@kubernetes/client-node', '@prisma/client', 'ws', '@anthropic-ai/claude-code', 'pg'],
  env: {
    NEXT_TELEMETRY_DISABLED: '1'
  }
}

export default nextConfig
