import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'
import LoginForm from './LoginForm'

export const dynamic = 'force-dynamic'

export default async function LoginPage() {
  // If setup hasn't been completed, go to wizard first
  const completed = await prisma.systemSetting.findUnique({ where: { key: 'setup.completed' } })
  if (!completed || completed.value !== true) redirect('/setup')

  // Only redirect if the session has a valid user id (not just a stale JWT)
  const session = await getServerSession(authOptions)
  if (session?.user?.id) redirect('/')

  return <LoginForm />
}
