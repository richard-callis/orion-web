/**
 * Model-based prompt-injection classifier: the second layer of SOC2 C-001,
 * on top of the rule signals in sanitize-context.ts.
 *
 * Model: protectai/deberta-v3-base-prompt-injection-v2 (Apache-2.0), an
 * English DeBERTa-v3 classifier trained to detect injected instructions. Its
 * model card notes it does NOT target jailbreaks, which the rule layer already
 * covers, so the two layers complement each other.
 *
 * Runtime:
 *   - Files are downloaded once from a pinned Hugging Face revision into
 *     ORION_MODEL_CACHE_DIR and the ONNX weights are SHA-256 verified.
 *   - Inference uses onnxruntime-node where the native binding loads (glibc
 *     hosts) and falls back to onnxruntime-web (WebAssembly), which runs
 *     anywhere, including the Alpine runtime image.
 *   - Long notes are split into overlapping 512-token windows; the note's
 *     score is the highest window score, so an injection buried mid-note still
 *     counts.
 *   - Scores are cached by content hash; notes rarely change.
 *   - Anything that fails (download, load, inference) disables the layer and
 *     logs once. The rule layer keeps running (fail-open to rules only).
 *
 * Config (env):
 *   ORION_INJECTION_CLASSIFIER            on | off                 (default on)
 *   ORION_INJECTION_CLASSIFIER_THRESHOLD  0..1                     (default DEFAULT_THRESHOLD)
 *   ORION_MODEL_CACHE_DIR                 model file directory     (default ./.cache/models)
 *   ORION_ONNX_BACKEND                    auto | node | web        (default auto)
 */
import { createHash } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'fs'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import os from 'os'
import path from 'path'

export const MODEL = {
  repo: 'protectai/deberta-v3-base-prompt-injection-v2',
  revision: '90c9989b1a342275dd0d1a95aad283c04e075671',
  onnxFile: 'onnx/model.onnx',
  onnxSha256: 'f0ea7f239f765aedbde7c9e163a7cb38a79c5b8853d3f76db5152172047b228c',
  jsonFiles: ['onnx/tokenizer.json', 'onnx/tokenizer_config.json', 'onnx/config.json'],
} as const

/**
 * Decision threshold on P(injection). Calibrated on the eval's dev split only
 * (apps/web/evals/prompt-injection, `--layer=layered --calibrate`).
 */
export const DEFAULT_THRESHOLD = 0.5

const WINDOW_TOKENS = 510 // + [CLS] and [SEP] = the model's 512 limit
const STRIDE_TOKENS = 384
const MAX_WINDOWS = 24
const CACHE_LIMIT = 5000

export function classifierEnabled(): boolean {
  return (process.env.ORION_INJECTION_CLASSIFIER ?? 'on').toLowerCase() !== 'off'
}

export function classifierThreshold(): number {
  const v = Number(process.env.ORION_INJECTION_CLASSIFIER_THRESHOLD)
  return Number.isFinite(v) && v > 0 && v < 1 ? v : DEFAULT_THRESHOLD
}

function cacheDir(): string {
  return process.env.ORION_MODEL_CACHE_DIR || path.join(process.cwd(), '.cache', 'models')
}

function modelDir(): string {
  return path.join(cacheDir(), MODEL.repo.replace('/', '__'), MODEL.revision)
}

// ── Download (pinned revision, checksum-verified) ───────────────────────────

async function download(file: string, sha256?: string): Promise<string> {
  const dest = path.join(modelDir(), file)
  if (existsSync(dest)) return dest
  mkdirSync(path.dirname(dest), { recursive: true })
  const url = `https://huggingface.co/${MODEL.repo}/resolve/${MODEL.revision}/${file}`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download ${file}: HTTP ${res.status}`)

  const tmp = `${dest}.${process.pid}.part`
  const hash = createHash('sha256')
  const body = Readable.fromWeb(res.body as import('stream/web').ReadableStream<Uint8Array>)
  body.on('data', (chunk: Buffer) => hash.update(chunk))
  await pipeline(body, createWriteStream(tmp))

  const digest = hash.digest('hex')
  if (sha256 && digest !== sha256) {
    rmSync(tmp, { force: true })
    throw new Error(`checksum mismatch for ${file}: expected ${sha256}, got ${digest}`)
  }
  renameSync(tmp, dest)
  return dest
}

// ── Runtime ─────────────────────────────────────────────────────────────────

/** Minimal slice of the onnxruntime API shared by -node and -web. */
interface OrtTensorCtor {
  new (type: 'int64', data: BigInt64Array, dims: number[]): unknown
}
interface OrtSession {
  inputNames: readonly string[]
  outputNames: readonly string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>>
}
interface Ort {
  Tensor: OrtTensorCtor
  InferenceSession: { create(model: string | Uint8Array, opts?: Record<string, unknown>): Promise<OrtSession> }
  env?: { wasm?: { numThreads?: number } }
}
interface Tok {
  encode(text: string, opts?: { add_special_tokens?: boolean }): { ids: number[] }
}

interface Loaded {
  ort: Ort
  session: OrtSession
  tokenizer: Tok
  prefix: number[]
  suffix: number[]
  injectionIndex: number
  backend: 'onnxruntime-node' | 'onnxruntime-web'
}

let loading: Promise<Loaded | null> | null = null
let disabledReason: string | null = null
const cache = new Map<string, number>()

function isGlibc(): boolean {
  try {
    const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined
    return Boolean(report?.header?.glibcVersionRuntime)
  } catch {
    return false
  }
}

async function createSession(modelPath: string): Promise<{ ort: Ort; session: OrtSession; backend: Loaded['backend'] }> {
  const threads = Math.max(1, Math.min(4, os.cpus().length))
  const pref = (process.env.ORION_ONNX_BACKEND ?? 'auto').toLowerCase()
  if (pref === 'node' || (pref === 'auto' && isGlibc())) {
    try {
      const ort = (await import('onnxruntime-node')) as unknown as Ort
      const session = await ort.InferenceSession.create(modelPath, { intraOpNumThreads: threads, graphOptimizationLevel: 'all' })
      return { ort, session, backend: 'onnxruntime-node' }
    } catch (e) {
      console.warn(`[C-001] onnxruntime-node unavailable (${(e as Error).message}); using WebAssembly backend`)
    }
  }
  const ort = (await import('onnxruntime-web')) as unknown as Ort
  if (ort.env?.wasm) ort.env.wasm.numThreads = threads
  const session = await ort.InferenceSession.create(new Uint8Array(readFileSync(modelPath)), { graphOptimizationLevel: 'all' })
  return { ort, session, backend: 'onnxruntime-web' }
}

async function load(): Promise<Loaded | null> {
  try {
    const modelPath = await download(MODEL.onnxFile, MODEL.onnxSha256)
    const [tokPath, tokCfgPath, cfgPath] = await Promise.all(MODEL.jsonFiles.map((f) => download(f)))
    const { Tokenizer } = await import('@huggingface/tokenizers')
    const tokenizer = new Tokenizer(
      JSON.parse(readFileSync(tokPath, 'utf8')),
      JSON.parse(readFileSync(tokCfgPath, 'utf8')),
    ) as unknown as Tok

    // Learn the special-token wrapping ([CLS] … [SEP]) from the tokenizer itself.
    const bare = tokenizer.encode('x', { add_special_tokens: false }).ids
    const wrapped = tokenizer.encode('x', { add_special_tokens: true }).ids
    const at = wrapped.findIndex((id, i) => bare.every((b, j) => wrapped[i + j] === b))
    const prefix = wrapped.slice(0, Math.max(0, at))
    const suffix = wrapped.slice(Math.max(0, at) + bare.length)

    const config = JSON.parse(readFileSync(cfgPath, 'utf8')) as { id2label?: Record<string, string> }
    const entry = Object.entries(config.id2label ?? {}).find(([, label]) => /injection/i.test(label))
    const injectionIndex = entry ? Number(entry[0]) : 1

    const { ort, session, backend } = await createSession(modelPath)
    console.log(`[C-001] injection classifier ready (${backend}, ${MODEL.repo}@${MODEL.revision.slice(0, 7)})`)
    return { ort, session, tokenizer, prefix, suffix, injectionIndex, backend }
  } catch (e) {
    disabledReason = (e as Error).message
    console.warn(`[C-001] injection classifier disabled, rule layer only: ${disabledReason}`)
    return null
  }
}

function getModel(): Promise<Loaded | null> {
  if (!loading) loading = load()
  return loading
}

/** Start downloading/loading in the background so the first retrieval isn't blocked. */
export function warmInjectionClassifier(): void {
  if (classifierEnabled()) void getModel()
}

export function classifierStatus(): { enabled: boolean; ready: boolean; disabledReason: string | null } {
  return { enabled: classifierEnabled(), ready: loading !== null && disabledReason === null, disabledReason }
}

function softmaxAt(logits: ArrayLike<number>, index: number): number {
  const vals = Array.from(logits, Number)
  const max = Math.max(...vals)
  const exps = vals.map((v) => Math.exp(v - max))
  return exps[index] / exps.reduce((a, b) => a + b, 0)
}

async function scoreWindow(m: Loaded, ids: number[]): Promise<number> {
  const full = [...m.prefix, ...ids, ...m.suffix]
  const feeds: Record<string, unknown> = {}
  const dims = [1, full.length]
  for (const name of m.session.inputNames) {
    if (name === 'input_ids') feeds[name] = new m.ort.Tensor('int64', BigInt64Array.from(full.map(BigInt)), dims)
    else if (name === 'attention_mask') feeds[name] = new m.ort.Tensor('int64', new BigInt64Array(full.length).fill(1n), dims)
    else if (name === 'token_type_ids') feeds[name] = new m.ort.Tensor('int64', new BigInt64Array(full.length), dims)
  }
  const out = await m.session.run(feeds)
  return softmaxAt(out[m.session.outputNames[0]].data, m.injectionIndex)
}

/**
 * P(injection) for a piece of text: the maximum over its token windows.
 * Returns null when the classifier is disabled or unavailable.
 */
export async function classifyInjection(text: string): Promise<number | null> {
  if (!classifierEnabled()) return null
  const key = createHash('sha256').update(text).digest('hex')
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const m = await getModel()
  if (!m) return null

  const ids = m.tokenizer.encode(text, { add_special_tokens: false }).ids
  let best = 0
  for (let start = 0, n = 0; n < MAX_WINDOWS; start += STRIDE_TOKENS, n++) {
    best = Math.max(best, await scoreWindow(m, ids.slice(start, start + WINDOW_TOKENS)))
    if (start + WINDOW_TOKENS >= ids.length) break
  }

  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  cache.set(key, best)
  return best
}
