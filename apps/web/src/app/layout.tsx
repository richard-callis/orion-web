import type { Metadata } from 'next'
import { headers } from 'next/headers'
// Bundled woff2 fonts — no CDN dependency at build time
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './globals.css'
import { Providers } from '@/components/Providers'

export const metadata: Metadata = {
  title: 'ORION',
  description: 'K3s Homelab Dashboard',
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = headers().get('x-nonce') ?? ''

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col h-[100dvh] overflow-hidden bg-bg-page text-text-primary">
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  )
}
