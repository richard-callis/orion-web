/**
 * Sanitize user/agent/dream-generated content before injecting into LLM system prompts.
 * Strips known prompt-injection patterns and truncates oversized content.
 *
 * SOC2: [C-001] — prevents prompt injection via notes, knowledge base, or dream extraction.
 * Applied to ALL context injection paths (worker.ts llm-context notes + vector search retrieval).
 */

const MAX_NOTE_LENGTH = 8000

const INJECTION_PATTERNS = [
  /^\s*(ignore\s+(previous|above|prior)\s+(instructions|prompts|context|system))/im,
  /^\s*(you\s+are\s+now)/im,
  /^\s*(from\s+now\s+on)/im,
  /^\s*(override\s+(all|the)?\s*(system|previous|original)\s*(instructions|prompt|rules|behavior))/im,
  /^\s*(do\s+not\s+(follow|obey|respond))/im,
  /^\s*(disregard\s+(all|the)?\s*(instructions|previous|context))/im,
  /^\s*(begin\s+(new|all)\s*(instructions|system))/im,
  /^\s*(change\s+(your|the)?\s*(role|persona|identity))/im,
  /^\s*(reveal|print|output|show|display|dump|list)\s+(your|the)?\s*(system|original|full|complete)\s*(prompt|instructions|rules|context)/im,
  /^\s*(show\s+me\s+(your|the|this))\s+(prompt|instructions|context)/im,
]

export function sanitizeContextNote(title: string, content: string): string {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      console.warn(`[C-001] Potential prompt injection in note "${title}" — stripping suspicious lines`)
      content = content.split('\n')
        .filter(line => !INJECTION_PATTERNS.some(p => p.test(line)))
        .join('\n')
    }
  }

  if (content.length > MAX_NOTE_LENGTH) {
    content = content.slice(0, MAX_NOTE_LENGTH) + '\n\n[Note truncated]'
  }

  content = content.replace(/^---+$/, '---')
  return content
}
