import { Lock, Shield, Zap, ShieldCheck, Settings2 } from 'lucide-react'

export const MIDDLEWARE_TYPES = [
  { value: 'crowdsec',     label: 'CrowdSec bouncer',        icon: Shield },
  { value: 'forward-auth', label: 'Forward auth (Authentik)', icon: ShieldCheck },
  { value: 'rate-limit',   label: 'Rate limit',               icon: Zap },
  { value: 'basic-auth',   label: 'Basic auth',               icon: Lock },
  { value: 'headers',      label: 'Headers',                  icon: Settings2 },
  { value: 'custom',       label: 'Custom',                   icon: Settings2 },
]
