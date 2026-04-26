/**
 * Tests for S3 backend abstraction layer
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  detectS3Backend,
  loadS3Config,
  getBackendName,
  logBackendConfig,
  type S3Backend,
} from './s3-backends'

// Save original env vars
const originalEnv = process.env

describe('S3 Backend Abstraction', () => {
  beforeEach(() => {
    // Reset environment for each test
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    // Restore original env
    process.env = originalEnv
  })

  describe('detectS3Backend()', () => {
    it('detects MinIO when endpoint contains "minio"', () => {
      process.env.AUDIT_EXPORT_S3_ENDPOINT = 'http://minio:9000'
      process.env.AUDIT_EXPORT_S3_BACKEND = 'auto'
      expect(detectS3Backend()).toBe('minio')
    })

    it('detects MinIO when endpoint is localhost:9000', () => {
      process.env.AUDIT_EXPORT_S3_ENDPOINT = 'http://localhost:9000'
      process.env.AUDIT_EXPORT_S3_BACKEND = 'auto'
      expect(detectS3Backend()).toBe('minio')
    })

    it('detects DigitalOcean when endpoint contains "digitalocean"', () => {
      process.env.AUDIT_EXPORT_S3_ENDPOINT = 'https://nyc3.digitaloceanspaces.com'
      process.env.AUDIT_EXPORT_S3_BACKEND = 'auto'
      expect(detectS3Backend()).toBe('digitalocean')
    })

    it('detects Wasabi when endpoint contains "wasabi"', () => {
      process.env.AUDIT_EXPORT_S3_ENDPOINT = 'https://s3.us-east-1.wasabisys.com'
      process.env.AUDIT_EXPORT_S3_BACKEND = 'auto'
      expect(detectS3Backend()).toBe('wasabi')
    })

    it('defaults to AWS when no endpoint specified', () => {
      delete process.env.AUDIT_EXPORT_S3_ENDPOINT
      process.env.AUDIT_EXPORT_S3_BACKEND = 'auto'
      expect(detectS3Backend()).toBe('aws')
    })

    it('respects explicit AUDIT_EXPORT_S3_BACKEND setting', () => {
      process.env.AUDIT_EXPORT_S3_BACKEND = 'wasabi'
      process.env.AUDIT_EXPORT_S3_ENDPOINT = 'http://minio:9000'
      expect(detectS3Backend()).toBe('wasabi')
    })

    it('treats unknown custom endpoints as "custom"', () => {
      process.env.AUDIT_EXPORT_S3_ENDPOINT = 'https://s3.example.com'
      process.env.AUDIT_EXPORT_S3_BACKEND = 'auto'
      expect(detectS3Backend()).toBe('custom')
    })

    it('defaults to auto when AUDIT_EXPORT_S3_BACKEND not set', () => {
      delete process.env.AUDIT_EXPORT_S3_BACKEND
      process.env.AUDIT_EXPORT_S3_ENDPOINT = 'http://minio:9000'
      expect(detectS3Backend()).toBe('minio')
    })
  })

  describe('loadS3Config()', () => {
    beforeEach(() => {
      process.env.AWS_ACCESS_KEY_ID = 'test-key'
      process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'
    })

    it('loads MinIO config correctly', () => {
      process.env.AUDIT_EXPORT_S3_ENDPOINT = 'http://minio:9000'
      process.env.AUDIT_EXPORT_S3_BACKEND = 'minio'
      process.env.AUDIT_EXPORT_S3_BUCKET = 'audit-logs'
      process.env.AUDIT_EXPORT_S3_REGION = 'us-east-1'

      const config = loadS3Config()
      expect(config.endpoint).toBe('http://minio:9000')
      expect(config.forcePathStyle).toBe(true)
      expect(config.bucket).toBe('audit-logs')
      expect(config.region).toBe('us-east-1')
      expect(config.accessKeyId).toBe('test-key')
    })

    it('loads AWS config correctly (no endpoint)', () => {
      delete process.env.AUDIT_EXPORT_S3_ENDPOINT
      process.env.AUDIT_EXPORT_S3_BACKEND = 'aws'
      process.env.AUDIT_EXPORT_S3_BUCKET = 'audit-logs-prod'
      process.env.AUDIT_EXPORT_S3_REGION = 'us-east-1'

      const config = loadS3Config()
      expect(config.endpoint).toBeUndefined()
      expect(config.forcePathStyle).toBe(false)
      expect(config.bucket).toBe('audit-logs-prod')
    })

    it('loads DigitalOcean config correctly', () => {
      process.env.AUDIT_EXPORT_S3_ENDPOINT = 'https://nyc3.digitaloceanspaces.com'
      process.env.AUDIT_EXPORT_S3_BACKEND = 'digitalocean'
      process.env.AUDIT_EXPORT_S3_BUCKET = 'audit-logs'
      process.env.AUDIT_EXPORT_S3_REGION = 'nyc3'

      const config = loadS3Config()
      expect(config.endpoint).toBe('https://nyc3.digitaloceanspaces.com')
      expect(config.forcePathStyle).toBe(false)
      expect(config.region).toBe('nyc3')
    })

    it('loads Wasabi config correctly', () => {
      process.env.AUDIT_EXPORT_S3_ENDPOINT = 'https://s3.us-east-1.wasabisys.com'
      process.env.AUDIT_EXPORT_S3_BACKEND = 'wasabi'
      process.env.AUDIT_EXPORT_S3_BUCKET = 'audit-logs'
      process.env.AUDIT_EXPORT_S3_REGION = 'us-east-1'

      const config = loadS3Config()
      expect(config.endpoint).toBe('https://s3.us-east-1.wasabisys.com')
      expect(config.forcePathStyle).toBe(false)
      expect(config.region).toBe('us-east-1')
    })

    it('loads custom config correctly', () => {
      process.env.AUDIT_EXPORT_S3_ENDPOINT = 'https://s3.example.com'
      process.env.AUDIT_EXPORT_S3_BACKEND = 'custom'
      process.env.AUDIT_EXPORT_S3_BUCKET = 'audit-logs'
      process.env.AUDIT_EXPORT_S3_REGION = 'us-east-1'

      const config = loadS3Config()
      expect(config.endpoint).toBe('https://s3.example.com')
      expect(config.bucket).toBe('audit-logs')
    })

    it('defaults to environment-specific bucket name', () => {
      delete process.env.AUDIT_EXPORT_S3_BUCKET
      process.env.NODE_ENV = 'staging'
      process.env.AUDIT_EXPORT_S3_BACKEND = 'aws'

      const config = loadS3Config()
      expect(config.bucket).toBe('orion-audit-logs-staging')
    })

    it('throws error if AWS credentials missing', () => {
      delete process.env.AWS_ACCESS_KEY_ID
      process.env.AUDIT_EXPORT_S3_BACKEND = 'aws'

      expect(() => loadS3Config()).toThrow('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY')
    })

    it('throws error if custom backend without endpoint', () => {
      delete process.env.AUDIT_EXPORT_S3_ENDPOINT
      process.env.AUDIT_EXPORT_S3_BACKEND = 'custom'

      expect(() => loadS3Config()).toThrow('AUDIT_EXPORT_S3_ENDPOINT is required')
    })

    it('respects custom path-style flag for custom backend', () => {
      process.env.AUDIT_EXPORT_S3_ENDPOINT = 'https://s3.example.com'
      process.env.AUDIT_EXPORT_S3_BACKEND = 'custom'
      process.env.AUDIT_EXPORT_S3_FORCE_PATH_STYLE = 'true'

      const config = loadS3Config()
      expect(config.forcePathStyle).toBe(true)
    })

    it('defaults forcePathStyle to false for custom backend', () => {
      process.env.AUDIT_EXPORT_S3_ENDPOINT = 'https://s3.example.com'
      process.env.AUDIT_EXPORT_S3_BACKEND = 'custom'
      delete process.env.AUDIT_EXPORT_S3_FORCE_PATH_STYLE

      const config = loadS3Config()
      expect(config.forcePathStyle).toBe(false)
    })

    it('generates default region if not specified', () => {
      delete process.env.AUDIT_EXPORT_S3_REGION
      process.env.AUDIT_EXPORT_S3_BACKEND = 'aws'

      const config = loadS3Config()
      expect(config.region).toBe('us-east-1')
    })
  })

  describe('getBackendName()', () => {
    beforeEach(() => {
      process.env.AWS_ACCESS_KEY_ID = 'test-key'
      process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'
    })

    it('returns correct names for each backend', () => {
      const backends: S3Backend[] = ['minio', 'aws', 'digitalocean', 'wasabi', 'custom']
      const expectedNames = [
        'MinIO',
        'AWS S3',
        'DigitalOcean Spaces',
        'Wasabi',
        'Custom S3-compatible',
      ]

      for (let i = 0; i < backends.length; i++) {
        process.env.AUDIT_EXPORT_S3_BACKEND = backends[i]
        if (backends[i] !== 'aws') {
          process.env.AUDIT_EXPORT_S3_ENDPOINT = 'http://example.com'
        } else {
          delete process.env.AUDIT_EXPORT_S3_ENDPOINT
        }
        expect(getBackendName()).toBe(expectedNames[i])
      }
    })
  })

  describe('logBackendConfig()', () => {
    beforeEach(() => {
      process.env.AWS_ACCESS_KEY_ID = 'test-key-12345'
      process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-67890'
      process.env.AUDIT_EXPORT_S3_BUCKET = 'test-bucket'
      process.env.AUDIT_EXPORT_S3_REGION = 'us-east-1'
    })

    it('logs backend config with redacted credentials', () => {
      process.env.AUDIT_EXPORT_S3_BACKEND = 'minio'
      process.env.AUDIT_EXPORT_S3_ENDPOINT = 'http://minio:9000'

      const log = logBackendConfig()
      expect(log).toContain('MinIO')
      expect(log).toContain('us-east-1')
      expect(log).toContain('test-bucket')
      expect(log).toContain('http://minio:9000')
      // Credentials should be redacted
      expect(log).toContain('tes...345')
      expect(log).not.toContain('test-key-12345')
    })

    it('logs AWS config without endpoint', () => {
      process.env.AUDIT_EXPORT_S3_BACKEND = 'aws'
      delete process.env.AUDIT_EXPORT_S3_ENDPOINT

      const log = logBackendConfig()
      expect(log).toContain('AWS S3')
      expect(log).toContain('(AWS default)')
    })

    it('includes path-style addressing info', () => {
      process.env.AUDIT_EXPORT_S3_BACKEND = 'minio'
      process.env.AUDIT_EXPORT_S3_ENDPOINT = 'http://minio:9000'

      const log = logBackendConfig()
      expect(log).toContain('Path-style addressing: true')
    })
  })
})
