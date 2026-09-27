'use client'

export interface IngressPath {
  path:      string
  service:   string
  port:      number
  namespace?: string
}

export interface IngressMiddleware {
  id:             string
  ingressPointId: string
  name:           string
  type:           string
  config:         Record<string, unknown>
  enabled:        boolean
}

export interface IngressRoute {
  id:             string
  host:           string
  paths:          IngressPath[]
  tls:            boolean
  middlewares:    string[]
  comment:        string | null
  enabled:        boolean
  disabledAt:     string | null
  disabledBy:     string | null
  ingressPointId: string
}

export interface IngressPoint {
  id:            string
  domainId:      string
  name:          string
  type:          string
  ip:            string | null
  port:          number
  certManager:   boolean
  clusterIssuer: string | null
  status:        string
  comment:       string | null
  environment:   { id: string; name: string } | null
  routes:        IngressRoute[]
  middlewares:   IngressMiddleware[]
}

export interface DnsRecord {
  id:        string
  domainId:  string
  ip:        string
  hostnames: string[]
  enabled:   boolean
  comment:   string | null
}

export interface Domain {
  id:                   string
  name:                 string
  type:                 string
  notes:                string | null
  coreDnsEnvironmentId: string | null
  coreDnsIp:            string | null
  coreDnsStatus:        string
  ingressPoints:        IngressPoint[]
}

export interface Env { id: string; name: string; type: string }

// ── Styles ────────────────────────────────────────────────────────────────────

export type PointTab = 'routes' | 'middlewares' | 'bootstrap'

export type DomainTab = 'ingress' | 'dns'
