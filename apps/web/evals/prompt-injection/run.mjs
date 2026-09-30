#!/usr/bin/env node
// Prompt-injection eval for sanitizeContextNote (SOC2 C-001).
//
// Measures, per attack category and placement:
//   detected - the sanitizer flagged the note (its C-001 warning fired)
//   removed  - no line of the attack text survives in the sanitized note
// and, on benign notes:
//   false positives - benign notes the sanitizer flagged
//
// Placements model how an injection reaches ORION's context window:
//   standalone - the whole note is the attack
//   own_line   - attack inserted as its own paragraph inside a real, clean note
//   inline     - attack appended to the end of a sentence inside a clean note
//
// Run from apps/web (Node >= 22.18, which strips TS types natively):
//   npm run eval:injection
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { sanitizeContextNote } from '../../src/lib/sanitize-context.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const dataset = JSON.parse(readFileSync(path.join(here, 'dataset.json'), 'utf8'))

// Count sanitizer warnings instead of printing them.
let warnings = 0
console.warn = () => { warnings++ }

function run(text) {
  const before = warnings
  const out = sanitizeContextNote('eval', text)
  return { out, flagged: warnings > before }
}

const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean)
// An attack line "survives" if its opening (up to 60 chars) is still in the
// output. Comparing prefixes keeps the 8,000-char truncation from counting as
// a removal: a truncated jailbreak still reaches the model.
const survives = (attack, out) => lines(attack).some((l) => out.includes(l.slice(0, 60)))

// ── Benign notes ─────────────────────────────────────────────────────────
const benign = dataset.benign.map((b) => ({ ...b, ...run(b.text) }))
const falsePositives = benign.filter((b) => b.flagged)

// Carrier notes for embedded attacks: 20 benign doc notes the filter does NOT
// flag (so a detection is caused by the attack, not the carrier), chosen
// deterministically by hash.
const hash = (s) => createHash('sha1').update(s).digest('hex')
const carriers = benign
  .filter((b) => !b.flagged && b.source !== 'garak:normal_instructions' && b.text.length < 3000)
  .sort((a, b) => hash(a.text).localeCompare(hash(b.text)))
  .slice(0, 20)
  .map((b) => b.text)

function embed(attack, carrier, placement) {
  const paras = carrier.split('\n\n')
  const mid = Math.max(1, Math.floor(paras.length / 2))
  if (placement === 'own_line') {
    return [...paras.slice(0, mid), attack, ...paras.slice(mid)].join('\n\n')
  }
  // inline: append to the last line of the first half, mid-paragraph
  const head = paras.slice(0, mid).join('\n\n')
  return `${head} ${attack}\n\n${paras.slice(mid).join('\n\n')}`
}

// ── Attacks ──────────────────────────────────────────────────────────────
const placements = ['standalone', 'own_line', 'inline']
const rows = []
for (const [i, a] of dataset.attacks.entries()) {
  for (const placement of placements) {
    const text = placement === 'standalone' ? a.text : embed(a.text, carriers[i % carriers.length], placement)
    const { out, flagged } = run(text)
    rows.push({ id: a.id, category: a.category, placement, detected: flagged, removed: !survives(a.text, out) })
  }
}

// ── Aggregate ────────────────────────────────────────────────────────────
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : 0)
const categories = [...new Set(dataset.attacks.map((a) => a.category))]
const summary = []
for (const category of categories) {
  for (const placement of placements) {
    const r = rows.filter((x) => x.category === category && x.placement === placement)
    summary.push({
      category, placement, n: r.length,
      detected_pct: pct(r.filter((x) => x.detected).length, r.length),
      removed_pct: pct(r.filter((x) => x.removed).length, r.length),
    })
  }
}
const overall = (placement) => {
  const r = rows.filter((x) => !placement || x.placement === placement)
  return { n: r.length, detected_pct: pct(r.filter((x) => x.detected).length, r.length), removed_pct: pct(r.filter((x) => x.removed).length, r.length) }
}
// Category-balanced (macro) average so the 650 in-the-wild jailbreaks don't swamp the rest.
const macro = (key, placement) => {
  const s = summary.filter((x) => !placement || x.placement === placement)
  return Math.round((10 * s.reduce((t, x) => t + x[key], 0)) / s.length) / 10
}

const results = {
  dataset: dataset.meta,
  attacks: dataset.attacks.length,
  attack_cases: rows.length,
  benign_notes: benign.length,
  false_positive_pct: pct(falsePositives.length, benign.length),
  false_positives: falsePositives.map((b) => ({ source: b.source, excerpt: b.text.slice(0, 120) })),
  overall: overall(),
  by_placement: Object.fromEntries(placements.map((p) => [p, { ...overall(p), macro_detected_pct: macro('detected_pct', p), macro_removed_pct: macro('removed_pct', p) }])),
  macro_detected_pct: macro('detected_pct'),
  macro_removed_pct: macro('removed_pct'),
  by_category: summary,
}
writeFileSync(path.join(here, 'results.json'), JSON.stringify(results, null, 2) + '\n')

// ── Report ───────────────────────────────────────────────────────────────
const out = []
out.push(`Attacks: ${results.attacks} (${results.attack_cases} cases across ${placements.length} placements) · Benign notes: ${results.benign_notes}`)
out.push(`Overall: detected ${results.overall.detected_pct}% · fully removed ${results.overall.removed_pct}% · category-balanced detected ${results.macro_detected_pct}% / removed ${results.macro_removed_pct}%`)
out.push(`False positives: ${results.false_positive_pct}% (${falsePositives.length}/${benign.length})`)
out.push('')
out.push('| Category | Placement | n | Detected | Fully removed |')
out.push('| --- | --- | ---: | ---: | ---: |')
for (const s of summary) out.push(`| ${s.category} | ${s.placement} | ${s.n} | ${s.detected_pct}% | ${s.removed_pct}% |`)
console.log(out.join('\n'))
