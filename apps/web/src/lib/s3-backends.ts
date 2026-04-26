/**
 * S3 Backend Abstraction Layer
 *
 * Supports multiple S3-compatible storage providers:
 * - MinIO (homelab-friendly S3-compatible)
 * - AWS S3 (cloud production)
 * - DigitalOcean Spaces (cost-effective cloud)
 * - Wasabi (cold storage, cheapest)
 * - Custom (any S3-compatible provider)
 *
 * Factory function auto-detects backend based on environment variables.
 * Supports single codebase for all providers with zero backend-specific logic
 * in main audit export code.
 */

import type { S3Client } from '@aws-sdk/client-s3'

/**
 * Supported S3 backends
 */
export type S3Backend = 'minio' | 'aws' | 'digitalocean' | 'wasabi' | 'custom' | 'auto'

/**
 * S3 backend configuration interface
 */
export interface S3Config {
  /**
   * S3 endpoint URL (undefined for AWS default)
   * - MinIO: http://minio:9000 or http://localhost:9000
   * - DigitalOcean: https://nyc3.digitaloceanspaces.com
   * - Wasabi: https://s3.us-east-1.wasabisys.com
   * - Custom: https://s3.example.com
   */
  endpoint?: string

  /**
   * AWS region or region-like identifier
   * - AWS: us-east-1, us-west-2, eu-west-1, etc.
   * - MinIO: any value (us-east-1 recommended)
   * - DigitalOcean: nyc3, sfo2, sfo3, etc.
   * - Wasabi: us-east-1, us-west-1, eu-west-1, etc.
   */
  region: string

  /**
   * S3 bucket name
   */
  bucket: string

  /**
   * AWS access key ID or MinIO/provider equivalent
   */
  accessKeyId: string

  /**
   * AWS secret access key or MinIO/provider equivalent
   */
  secretAccessKey: string

  /**
   * Force path-style addressing (required for MinIO)
   * MinIO: true
   * AWS: false (virtual-hosted style)
   * DigitalOcean: false
   * Wasabi: false
   * Custom: depends on provider
   */
  forcePathStyle?: boolean

  /**
   * Disable SSL certificate verification (NOT for production)
   * Use only for self-signed certificates in development
   */
  disableSslVerification?: boolean
}

/**
 * Detect backend from environment variables
 * Returns: detected backend type or 'aws' as default
 */
export function detectS3Backend(): S3Backend {
  const endpoint = process.env.AUDIT_EXPORT_S3_ENDPOINT
  const backend = process.env.AUDIT_EXPORT_S3_BACKEND || 'auto'

  if (backend !== 'auto') {
    return backend as S3Backend
  }

  // Auto-detection logic
  if (endpoint) {
    // If endpoint is set, detect provider from endpoint URL
    if (endpoint.includes('minio') || endpoint.includes('localhost:9000')) {
      return 'minio'
    }
    if (endpoint.includes('digitalocean')) {
      return 'digitalocean'
    }
    if (endpoint.includes('wasabi')) {
      return 'wasabi'
    }
    // Any other custom endpoint
    return 'custom'
  }

  // Default to AWS if no endpoint specified
  return 'aws'
}

/**
 * Load S3 configuration from environment variables based on detected backend
 */
export function loadS3Config(): S3Config {
  const backend = detectS3Backend()
  const region = process.env.AUDIT_EXPORT_S3_REGION || 'us-east-1'
  const bucket = process.env.AUDIT_EXPORT_S3_BUCKET || `orion-audit-logs-${process.env.NODE_ENV || 'dev'}`
  const endpoint = process.env.AUDIT_EXPORT_S3_ENDPOINT
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID || ''
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || ''

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables are required')
  }

  const config: S3Config = {
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
  }

  // Backend-specific configuration
  switch (backend) {
    case 'minio':
      config.endpoint = endpoint || 'http://minio:9000'
      config.forcePathStyle = true // Required for MinIO
      break

    case 'aws':
      // AWS S3: no endpoint specified (uses default AWS endpoint)
      config.endpoint = undefined
      config.forcePathStyle = false
      break

    case 'digitalocean':
      config.endpoint = endpoint || `https://${region}.digitaloceanspaces.com`
      config.forcePathStyle = false
      break

    case 'wasabi':
      config.endpoint = endpoint || `https://s3.${region}.wasabisys.com`
      config.forcePathStyle = false
      break

    case 'custom':
      if (!endpoint) {
        throw new Error('AUDIT_EXPORT_S3_ENDPOINT is required for custom S3-compatible backends')
      }
      config.endpoint = endpoint
      // Custom backends may need path-style addressing
      // Default to false, but allow override via env var
      config.forcePathStyle = process.env.AUDIT_EXPORT_S3_FORCE_PATH_STYLE === 'true'
      break

    case 'auto':
      // Should not reach here (auto is converted in detectS3Backend)
      throw new Error('Backend detection failed')
  }

  return config
}

/**
 * Create an S3 client for the configured backend
 */
export async function createS3Client(): Promise<S3Client> {
  let S3ClientClass: typeof import('@aws-sdk/client-s3').S3Client

  try {
    const aws = await import('@aws-sdk/client-s3')
    S3ClientClass = aws.S3Client
  } catch {
    throw new Error(
      'AWS SDK not installed. Install @aws-sdk/client-s3: npm install @aws-sdk/client-s3'
    )
  }

  const config = loadS3Config()

  const clientConfig: ConstructorParameters<typeof S3ClientClass>[0] = {
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  }

  // Add endpoint if specified
  if (config.endpoint) {
    clientConfig.endpoint = config.endpoint
    clientConfig.forcePathStyle = config.forcePathStyle
  }

  // For development with self-signed certificates
  if (config.disableSslVerification) {
    // @ts-expect-error: Node.js agent configuration
    clientConfig.httpAgent = new (await import('http')).Agent({ rejectUnauthorized: false })
    // @ts-expect-error: Node.js agent configuration
    clientConfig.httpsAgent = new (await import('https')).Agent({ rejectUnauthorized: false })
  }

  return new S3ClientClass(clientConfig)
}

/**
 * Get backend name for logging and diagnostics
 */
export function getBackendName(): string {
  const backend = detectS3Backend()
  const names: Record<S3Backend, string> = {
    minio: 'MinIO',
    aws: 'AWS S3',
    digitalocean: 'DigitalOcean Spaces',
    wasabi: 'Wasabi',
    custom: 'Custom S3-compatible',
    auto: 'Auto-detected',
  }
  return names[backend]
}

/**
 * Log backend configuration (for diagnostics, secrets redacted)
 */
export function logBackendConfig(): string {
  const config = loadS3Config()
  const backend = detectS3Backend()

  return `
Backend: ${getBackendName()}
Region: ${config.region}
Bucket: ${config.bucket}
Endpoint: ${config.endpoint || '(AWS default)'}
Path-style addressing: ${config.forcePathStyle || false}
Access Key ID: ${config.accessKeyId.substring(0, 3)}...${config.accessKeyId.substring(config.accessKeyId.length - 3)}
  `.trim()
}
