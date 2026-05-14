export interface SkillMatch {
  skillName: string
  systemPrompt: string
  nebulaId: string
}

export class SkillLoader {
  private skills: Map<string, Array<{ id: string; name: string; spec: string }>> = new Map()

  // Load skills for an environment from ORION
  async load(environmentId: string, orionClient: any): Promise<void> {
    const response = await orionClient.fetchNebula(environmentId)
    const installed = (response as any[]).filter((s: any) => s.isInstalled && s.category === 'skill')
    this.skills.set(environmentId, installed)
  }

  // Match a message against skills and return injected system prompt
  match(environmentId: string, message: string): SkillMatch | null {
    const skills = this.skills.get(environmentId) ?? []
    const msgLower = message.toLowerCase()

    for (const skill of skills) {
      const spec = JSON.parse(skill.spec) as { triggerPatterns?: string[]; systemPrompt?: string }
      if (!spec?.triggerPatterns?.length) continue

      for (const pattern of spec.triggerPatterns) {
        if (msgLower.includes(pattern.toLowerCase())) {
          return {
            skillName: skill.name,
            systemPrompt: spec.systemPrompt ?? '',
            nebulaId: skill.id,
          }
        }
      }
    }
    return null
  }

  // Refresh skills from ORION
  async refresh(environmentId: string, orionClient: any): Promise<void> {
    await this.load(environmentId, orionClient)
  }
}
