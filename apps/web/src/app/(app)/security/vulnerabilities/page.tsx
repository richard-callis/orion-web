export const dynamic = 'force-dynamic'
import { requireAuth } from '@/lib/auth'
import { redirect } from 'next/navigation'
import VulnerabilityDashboard from '@/components/security/VulnerabilityDashboard'

export default async function VulnerabilitiesPage() {
  try { await requireAuth() } catch { redirect('/login') }
  return <VulnerabilityDashboard />
}
