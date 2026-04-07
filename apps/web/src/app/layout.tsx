import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import './globals.css'
import { Sidebar } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { StatusBar } from '@/components/layout/StatusBar'
import { BottomNav } from '@/components/layout/BottomNav'
import { Providers } from '@/components/Providers'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains' })

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
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable}`}>
      <body className="flex flex-col h-[100dvh] overflow-hidden bg-bg-page text-text-primary">
        <Providers>
          {/* Header spans full width */}
          <Header />
          {/* Sidebar + content row */}
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <Sidebar />
            <main className="flex-1 min-h-0 overflow-auto relative">
              {children}
            </main>
          </div>
          {/* Status bar spans full width — hidden on mobile */}
          <StatusBar />
          {/* Mobile-only bottom nav */}
          <BottomNav />
        </Providers>
      </body>
    </html>
  )
}
