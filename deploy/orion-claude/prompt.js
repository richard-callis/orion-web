/**
 * Request → Claude Code CLI translation for orion-claude (pure, unit-tested
 * from apps/web: lib/agent-runner/engine/sidecar-prompt.test.ts).
 *
 * Prompt caching: the Claude Code CLI applies cache_control itself — to its
 * system prompt (which includes --append-system-prompt) and tool definitions.
 * What the sidecar controls is keeping that prefix byte-identical:
 *   - `system` (stable) is the only thing appended to the system prompt;
 *   - `context` (volatile: skills, RAG notes) goes into the user turn;
 *   - --exclude-dynamic-system-prompt-sections (when the CLI supports it) moves
 *     per-machine sections (cwd, env, git status) out of the system prompt —
 *     MCP runs use a fresh temp cwd per request, which otherwise changed the
 *     system prompt on every call.
 */

const PROMPT_CHAR_LIMIT = 80000   // Linux ARG_MAX headroom (execFile fails with E2BIG beyond ~128KB)
const SYSTEM_CHAR_LIMIT = 20000

/**
 * Prior messages + the new user message → one prompt string.
 * 'chat': "role: content" blocks separated by blank lines, then "user: <prompt>".
 * 'room': "Name: content" lines, a blank line, then the latest message as-is.
 * Byte-identical to the strings ORION flattened itself before (renderLegacyPrompt).
 */
function renderTranscript(messages, transcript) {
  if (messages.length === 0) return ''
  const last = String(messages[messages.length - 1].content ?? '')
  const prior = messages.slice(0, -1)
  if (transcript === 'room') {
    const block = prior.length ? prior.map(m => `${m.name ?? m.role}: ${m.content}`).join('\n') + '\n\n' : ''
    return block + last
  }
  return prior.length ? prior.map(m => `${m.role}: ${m.content}`).join('\n\n') + `\n\nuser: ${last}` : last
}

function truncatePrompt(s) {
  if (s.length <= PROMPT_CHAR_LIMIT) return s
  // Keep the tail (most recent messages) — the model needs recency more than deep history.
  const truncated = s.slice(s.length - PROMPT_CHAR_LIMIT)
  const newline = truncated.indexOf('\n')
  return newline > 0 ? truncated.slice(newline + 1) : truncated
}

/**
 * Resolve the prompt and appended system prompt for a /run or /run/collect
 * request. Structured requests (`messages`) win; legacy `prompt` /
 * `systemPrompt` requests are passed through unchanged.
 */
function resolvePrompt(opts) {
  if (Array.isArray(opts.messages) && opts.messages.length > 0) {
    const messages = opts.messages.filter(m => m && typeof m === 'object')
    const transcript = renderTranscript(messages, opts.transcript === 'room' ? 'room' : 'chat')
    const context = typeof opts.context === 'string' ? opts.context.trim() : ''
    const prompt = context ? `Context for this turn:\n${context}\n\n---\n\n${transcript}` : transcript
    const system = typeof opts.system === 'string' ? opts.system : undefined
    return { prompt: truncatePrompt(prompt), systemPrompt: system !== undefined ? system.slice(0, SYSTEM_CHAR_LIMIT) : undefined }
  }
  return {
    prompt: truncatePrompt(String(opts.prompt || '')),
    systemPrompt: typeof opts.systemPrompt === 'string' ? opts.systemPrompt.slice(0, SYSTEM_CHAR_LIMIT) : undefined,
  }
}

/**
 * CLI flags for the tool allowlist. An explicit empty list means "no built-in
 * tools" (readonly chat users, one-shot completions); a non-empty list is
 * passed as --allowedTools; absent means the CLI default. Entries are
 * validated — they come from ORION, but must never smuggle in a flag.
 */
function toolArgs(allowedTools) {
  if (!Array.isArray(allowedTools)) return []
  const valid = allowedTools.filter(t => typeof t === 'string' && t.length > 0 && t.length <= 200 && !t.startsWith('-') && !/[\r\n\0]/.test(t))
  if (allowedTools.length === 0 || valid.length === 0) return ['--tools', '']
  return ['--allowedTools', ...valid]
}

/** Per-request MCP token (per-agent attribution); falls back to the service token. */
function mcpTokenFor(opts, fallback) {
  const t = opts.mcpToken
  if (typeof t === 'string' && t.length > 0 && t.length <= 1024 && !/[\r\n\0]/.test(t)) return t
  return fallback
}

/** Usage from `claude --output-format json`, normalised for ORION. */
function parseUsage(parsed) {
  const u = parsed && parsed.usage
  if (!u || typeof u !== 'object') return undefined
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const cacheRead = num(u.cache_read_input_tokens)
  const cacheCreation = num(u.cache_creation_input_tokens)
  return {
    // Total prompt size (fresh + cache writes + cache reads): ORION uses it as a context-size proxy.
    inputTokens: num(u.input_tokens) + cacheCreation + cacheRead,
    outputTokens: num(u.output_tokens),
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
  }
}

module.exports = { renderTranscript, resolvePrompt, toolArgs, mcpTokenFor, parseUsage, PROMPT_CHAR_LIMIT }
