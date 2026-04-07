import { Sidebar } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { StatusBar } from '@/components/layout/StatusBar'
import { BottomNav } from '@/components/layout/BottomNav'
import { prisma } from '@/lib/db'
import type { Metadata } from 'next'

export async function generateMetadata(): Promise<Metadata> {
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'app.name' } })
    const name = (setting?.value as string) || 'ORION'
    return { title: name }
  } catch {
    return { title: 'ORION' }
  }
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Header />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <Sidebar />
        <main className="flex-1 min-h-0 overflow-auto relative">
          {children}
        </main>
      </div>
      <StatusBar />
      <BottomNav />
    </>
  )
}
