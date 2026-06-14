import { notFound } from 'next/navigation'

export default async function SecurityDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await params
  return notFound()
}
