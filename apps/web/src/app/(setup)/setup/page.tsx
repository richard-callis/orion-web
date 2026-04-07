import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db'
import SetupWizard from './SetupWizard'

export default async function SetupPage() {
  const setting = await prisma.systemSetting.findUnique({ where: { key: 'setup.completed' } })
  if (setting?.value === true) redirect('/login')
  return <SetupWizard />
}
