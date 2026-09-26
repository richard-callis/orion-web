'use client'

import { SessionProvider } from 'next-auth/react'
import { SWRConfig } from 'swr'
import { swrFetcher } from '@/lib/api'
import { ToastProvider } from '@/components/ui/Toast'
import { ConfirmProvider } from '@/components/ui/ConfirmDialog'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <SWRConfig
        value={{
          fetcher: swrFetcher,
          // Pollers stop while the tab is hidden and refresh when it regains focus.
          refreshWhenHidden: false,
          revalidateOnFocus: true,
          dedupingInterval: 2000,
          errorRetryCount: 3,
        }}
      >
        <ToastProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
        </ToastProvider>
      </SWRConfig>
    </SessionProvider>
  )
}
