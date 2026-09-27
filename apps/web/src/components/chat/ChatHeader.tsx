'use client'
import { ChevronLeft, Eye } from 'lucide-react'
import { IconButton } from '@/components/ui/Button'
import { PROVIDER_CONFIG, PROVIDER_ORDER, type AppModel, type ChatMode } from './chat-types'

interface Props {
  mode: ChatMode
  conversationId: string | null
  models: AppModel[]
  currentProvider: string
  selectedModelId: string
  onMobileBack?: () => void
  onOpenTraces: () => void
  onSwitchModel: (modelId: string | null) => void
}

function title(mode: ChatMode): string {
  switch (mode.kind) {
    case 'agentChat':   return mode.agent.name
    case 'agentTarget': return `Agent: ${mode.agent.name}`
    case 'plan':        return `Planning: ${mode.target.type}`
    default:            return 'AI Chat'
  }
}

export function ChatHeader({ mode, conversationId, models, currentProvider, selectedModelId, onMobileBack, onOpenTraces, onSwitchModel }: Props) {
  // Model choice applies to plain chats and agent-creation drafts only.
  const showPicker = (mode.kind === 'plain' || mode.kind === 'agentDraft') && models.length > 0
  const providers = PROVIDER_ORDER.filter(p => models.some(m => m.provider === p))
  const providerModels = models.filter(m => m.provider === currentProvider)

  return (
    <div className="flex items-center justify-between px-4 py-2 border-b border-border-subtle bg-bg-sidebar flex-shrink-0">
      <div className="flex items-center gap-2">
        {onMobileBack && (
          <IconButton label="Back to conversations" onClick={onMobileBack} className="md:hidden p-0 mr-1">
            <ChevronLeft size={16} />
          </IconButton>
        )}
        <span className="text-xs font-medium text-text-primary">{title(mode)}</span>
        {conversationId && (
          <IconButton label="View full context sent to the LLM" onClick={onOpenTraces} className="hover:text-accent hover:bg-bg-raised">
            <Eye size={13} />
          </IconButton>
        )}
      </div>
      {showPicker && (
        <div className="flex flex-col items-end gap-1">
          {/* Provider buttons */}
          <div className="flex items-center gap-1" role="radiogroup" aria-label="Provider">
            {providers.map(provider => {
              const cfg = PROVIDER_CONFIG[provider]
              const isActive = currentProvider === provider
              return (
                <button
                  key={provider}
                  role="radio"
                  aria-checked={isActive}
                  onClick={() => {
                    if (isActive) return
                    if (provider === 'anthropic') onSwitchModel(null)
                    else {
                      const first = models.find(m => m.provider === provider)
                      if (first) onSwitchModel(first.id)
                    }
                  }}
                  className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
                    isActive ? cfg.activeClass : 'bg-bg-raised border-border-subtle text-text-muted hover:text-text-primary'
                  }`}
                >
                  {cfg?.label ?? provider}
                </button>
              )
            })}
          </div>
          {/* Model picker — shown when the active provider has selectable models */}
          {currentProvider !== 'anthropic' && providerModels.length > 0 && (
            <div className="flex items-center gap-1" role="radiogroup" aria-label="Model">
              {providerModels.map(m => {
                const isSelected = m.id === selectedModelId
                return (
                  <button
                    key={m.id}
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => onSwitchModel(m.id)}
                    className={`px-2 py-0.5 rounded text-xs border transition-colors ${
                      isSelected
                        ? PROVIDER_CONFIG[currentProvider].modelClass
                        : 'bg-bg-raised border-border-subtle text-text-muted hover:text-text-secondary'
                    }`}
                  >
                    {m.name}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
