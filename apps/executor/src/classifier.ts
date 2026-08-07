import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import YAML from 'yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(__dirname, '../config/risk-rules.yaml')

interface RiskRule {
  tier: 'auto' | 'notify' | 'approve' | 'escalate'
  tool: string
  patterns: string[]
}

interface RiskConfig {
  rules: RiskRule[]
}

class Classifier {
  private config: RiskConfig = { rules: [] }

  constructor() {
    this.loadConfig()
    this.watchConfigFile()
  }

  private loadConfig() {
    try {
      const content = fs.readFileSync(CONFIG_PATH, 'utf-8')
      this.config = YAML.parse(content) as RiskConfig
      console.log('Risk rules loaded')
    } catch (error) {
      console.error('Failed to load risk rules:', error)
      // Fail closed: if the risk rules can't be parsed (e.g. a bad hot-reloaded edit),
      // require the strictest human approval tier for everything rather than silently
      // downgrading every command to a low-friction tier.
      this.config = { rules: [{ tier: 'escalate', tool: '', patterns: [] }] }
    }
  }

  private watchConfigFile() {
    fs.watch(CONFIG_PATH, () => {
      console.log('Risk rules changed, reloading...')
      this.loadConfig()
    })
  }

  classify(tool: string, args: Record<string, unknown>): 'auto' | 'notify' | 'approve' | 'escalate' {
    const matchStr = tool === 'shell_exec' ? String(args.command ?? '') : JSON.stringify(args)

    // Fail closed if the loaded config's rules array is empty/malformed (e.g. `rules: []` parses
    // successfully but matches nothing) — don't fall through to a low-friction default.
    let tier: 'auto' | 'notify' | 'approve' | 'escalate' = this.config.rules.length ? 'notify' : 'escalate'

    for (const rule of this.config.rules) {
      if (rule.tool !== tool && rule.tool !== '') {
        continue
      }

      if (!rule.patterns || rule.patterns.length === 0) {
        tier = rule.tier
        break
      }

      let matched = false
      for (const pattern of rule.patterns) {
        try {
          // case-insensitive: the denylist patterns (curl, wget, sudo, ...) shouldn't be
          // trivially evaded by case (`Curl`, `SUDO`, ...)
          const regex = new RegExp(pattern, 'i')
          if (regex.test(matchStr)) {
            matched = true
            break
          }
        } catch (e) {
          console.error(`Invalid regex pattern: ${pattern}`, e)
        }
      }
      if (matched) {
        tier = rule.tier
        break
      }
    }

    // The "auto" tier's patterns anchor on the command's first word only (e.g. `^cat\b`) and say
    // nothing about what follows. sandbox.ts runs shell_exec via `exec()` — full `/bin/sh -c`
    // interpretation — so ANY shell operator that chains a second command onto a safe-looking
    // first one defeats the per-word allowlist: pipe, `&&`/`&`, `;`, command substitution
    // `$(...)`/backticks, redirects, and newlines (sh treats a literal newline as a statement
    // separator same as `;`). Never let such a command through on the no-human-approval "auto"
    // path — require the strictest tier instead.
    if (tool === 'shell_exec' && tier === 'auto' && /[|&;<>\n\r`]|\$\(/.test(matchStr)) {
      tier = 'escalate'
    }

    return tier
  }
}

export const classifier = new Classifier()
