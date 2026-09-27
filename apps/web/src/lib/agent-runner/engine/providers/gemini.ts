/**
 * Gemini provider adapter (streamGenerateContent, SSE). Text only — no tools.
 */
import { runSignal } from '../../abort'
import { ProviderHttpError, type ChatProvider, type TurnEvent, type TurnRequest } from '../types'

export interface GeminiProviderConfig {
  apiKey: string
  model: string
  timeoutMs: number
}

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function createGeminiProvider(cfg: GeminiProviderConfig): ChatProvider {
  return {
    async *turn(req: TurnRequest): AsyncGenerator<TurnEvent> {
      // Model id goes into the URL path — allow only plain model ids. The API key
      // travels in a header, not the query string (which ends up in logs).
      if (!MODEL_ID_RE.test(cfg.model)) throw new Error(`Invalid Gemini model id: ${cfg.model}`)
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse`
      const system = req.messages.filter(m => m.role === 'system').map(m => m.content ?? '').join('\n\n')
      const contents = req.messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content ?? '' }] }))

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents }),
        signal: runSignal(req.signal, cfg.timeoutMs),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new ProviderHttpError(`Gemini ${res.status}: ${text}`, res.status, text)
      }
      if (!res.body) throw new Error('No response body from Gemini')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let text = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (!data) continue
            let chunk: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
            try { chunk = JSON.parse(data) as typeof chunk } catch { continue }
            const t = chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
            if (t) {
              text += t
              yield { type: 'delta', text: t }
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {})
      }
      yield { type: 'end', result: { text, toolCalls: [] } }
    },
  }
}
