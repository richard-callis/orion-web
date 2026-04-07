import type { Metadata } from 'next'
import '../globals.css'

export const metadata: Metadata = { title: 'ORION — Setup' }

export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-[100dvh] bg-bg-page text-text-primary flex flex-col items-center justify-center p-4">
        {children}
      </body>
    </html>
  )
}
