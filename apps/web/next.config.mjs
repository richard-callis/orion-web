/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Disable font optimization so builds succeed without internet access to fonts.gstatic.com
  optimizeFonts: false,
  experimental: {
    instrumentationHook: true,
    serverComponentsExternalPackages: ['@kubernetes/client-node', '@prisma/client', 'ws', '@anthropic-ai/claude-code']
  },
  env: {
    NEXT_TELEMETRY_DISABLED: '1'
  }
}

export default nextConfig
