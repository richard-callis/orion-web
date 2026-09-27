// Renders diagrams through MermaidBlock's real rendering path
// (apps/web/src/components/notes/mermaid-render.ts) in a real browser.
// No ORION server needed: the module is bundled with esbuild and loaded into a
// blank page. Guards mermaid upgrades (render API, securityLevel 'strict').
import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webDir = path.resolve(here, '../../apps/web')

let bundle = ''
test.beforeAll(async () => {
  const out = await build({
    stdin: {
      contents: "import { renderMermaidSvg } from './src/components/notes/mermaid-render'; window.renderMermaidSvg = renderMermaidSvg",
      resolveDir: webDir,
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
  })
  bundle = out.outputFiles[0].text
})

async function render(page, code) {
  await page.setContent('<!doctype html><html><body><div id="out"></div></body></html>')
  await page.addScriptTag({ content: bundle })
  return page.evaluate(async src => {
    const el = await window.renderMermaidSvg(src)
    if (!el) return { ok: false }
    const out = document.getElementById('out')
    out.appendChild(document.importNode(el, true))
    return {
      ok: true,
      tag: out.firstElementChild?.tagName.toLowerCase(),
      scripts: out.querySelectorAll('script').length,
      handlers: [...out.querySelectorAll('*')].filter(n => [...n.attributes].some(a => a.name.toLowerCase().startsWith('on'))).length,
      text: out.textContent,
    }
  }, code)
}

test('renders a flowchart to SVG', async ({ page }) => {
  const r = await render(page, 'flowchart TD\n  A[Start] --> B{Decide}\n  B -->|yes| C[Done]')
  expect(r).toMatchObject({ ok: true, tag: 'svg' })
  expect(r.text).toContain('Decide')
})

test('renders a sequence diagram to SVG', async ({ page }) => {
  const r = await render(page, 'sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi')
  expect(r).toMatchObject({ ok: true, tag: 'svg' })
  expect(r.text).toContain('Alice')
})

test('neutralises script injection in labels (securityLevel strict)', async ({ page }) => {
  let alerted = false
  page.on('dialog', d => { alerted = true; d.dismiss() })
  const r = await render(page, 'flowchart TD\n  A["<script>alert(1)</script><img src=x onerror=alert(2)>"] --> B')
  expect(r.ok).toBe(true)
  expect(r.scripts).toBe(0)
  expect(r.handlers).toBe(0)
  expect(alerted).toBe(false)
})
