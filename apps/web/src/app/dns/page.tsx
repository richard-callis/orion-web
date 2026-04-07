import { getNodeHosts, getCustomRecords } from '@/lib/dns'
import { DnsManager } from '@/components/dns/DnsManager'

export const dynamic = 'force-dynamic'

export default async function DnsPage() {
  const [nodeHosts, customRecords] = await Promise.all([
    getNodeHosts().catch(() => []),
    getCustomRecords().catch(() => []),
  ])

  return <DnsManager initialNodeHosts={nodeHosts} initialCustomRecords={customRecords} />
}
