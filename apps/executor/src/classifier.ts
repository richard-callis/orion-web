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
      this.config = { rules: [{ tier: 'notify', tool: '', patterns: [] }] }
    }
  }

  private watchConfigFile() {
    fs.watch(CONFIG_PATH, () => {
      console.log('Risk rules changed, reloading...')
      this.loadConfig()
    })
  }

  classify(tool: string, args: Record<string, unknown>): 'auto' | 'notify' | 'approve' | 'escalate' {
    const argsStr = JSON.stringify(args)

    for (const rule of this.config.rules) {
      if (rule.tool !== tool && rule.tool !== '') {
        continue
      }

      for (const pattern of rule.patterns) {
        try {
          const regex = new RegExp(pattern)
          if (regex.test(argsStr)) {
            return rule.tier
          }
        } catch (e) {
          console.error(`Invalid regex pattern: ${pattern}`, e)
        }
      }
    }

    // Default to notify if no rules match
    return 'notify'
  }
}

export const classifier = new Classifier()
