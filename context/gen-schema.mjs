#!/usr/bin/env node
// Regenerates context/schema.md from apps/web/prisma/schema.prisma so the model
// reference can't drift from the schema again. Run from the repo root:
//   node context/gen-schema.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'apps/web/prisma/schema.prisma'), 'utf8')

const blocks = [...src.matchAll(/^(model|enum) (\w+) \{\n([\s\S]*?)^\}/gm)].map(m => ({
  kind: m[1], name: m[2], body: m[3],
}))
const modelNames = new Set(blocks.filter(b => b.kind === 'model').map(b => b.name))
const enumNames = new Set(blocks.filter(b => b.kind === 'enum').map(b => b.name))

const esc = s => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')

function parseModel(body) {
  const fields = []
  const attrs = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('//')) continue
    if (line.startsWith('@@')) { attrs.push(line.replace(/\s*\/\/.*$/, '')); continue }
    const m = line.match(/^(\w+)\s+([\w\[\]?"()]+(?:\([^)]*\))?)\s*(.*)$/)
    if (!m) continue
    const [, name, type, rest] = m
    const comment = (rest.match(/\/\/\s*(.*)$/) || [])[1] || ''
    const attr = rest.replace(/\/\/.*$/, '').trim()
    const base = type.replace(/[\[\]?]/g, '')
    fields.push({ name, type, attr, comment, isRelation: modelNames.has(base) })
  }
  return { fields, attrs }
}

const out = []
out.push('# Prisma Schema — Models Reference')
out.push('')
out.push('> **Generated** from `apps/web/prisma/schema.prisma` by `node context/gen-schema.mjs` — do not edit by hand.')
out.push('> Migration workflow: `apps/web/prisma/MIGRATIONS.md`.')
out.push('> Referenced by: [[web-call-graph]], [[api-routes]]')
out.push('')
out.push(`${modelNames.size} models, ${enumNames.size} enums.`)
out.push('')
out.push('## Index')
out.push('')
out.push([...modelNames].map(n => `[${n}](#${n.toLowerCase()})`).join(' · '))
out.push('')
out.push('## Models')
for (const b of blocks.filter(b => b.kind === 'model')) {
  const { fields, attrs } = parseModel(b.body)
  const map = attrs.find(a => a.startsWith('@@map'))
  out.push('')
  out.push(`### ${b.name}${map ? ` — table \`${map.match(/"(.*)"/)[1]}\`` : ''}`)
  out.push('')
  out.push('| Field | Type | Attributes | Notes |')
  out.push('|---|---|---|---|')
  for (const f of fields) {
    out.push(`| ${f.name} | ${esc(f.isRelation ? `→ ${f.type}` : f.type)} | ${esc(f.attr ? `\`${f.attr}\`` : '')} | ${esc(f.comment)} |`)
  }
  const rest = attrs.filter(a => !a.startsWith('@@map'))
  if (rest.length) {
    out.push('')
    out.push(rest.map(a => `\`${a}\``).join(' · '))
  }
}
out.push('')
out.push('## Enums')
for (const b of blocks.filter(b => b.kind === 'enum')) {
  const values = b.body.split('\n').map(l => l.replace(/\/\/.*$/, '').trim()).filter(Boolean)
  out.push('')
  out.push(`- **${b.name}**: ${values.join(', ')}`)
}
out.push('')
writeFileSync(join(root, 'context/schema.md'), out.join('\n'))
console.log(`context/schema.md: ${modelNames.size} models, ${enumNames.size} enums`)
