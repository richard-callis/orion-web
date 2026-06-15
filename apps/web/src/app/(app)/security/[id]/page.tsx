import { redirect } from 'next/navigation'

export default async function SecurityDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/security/incidents/${id}`)
}
