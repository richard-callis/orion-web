'use client'

import { createPortal } from 'react-dom'
import { Rocket } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { useSSEStream } from '@/hooks/useSSE'
import { ClusterPreflightFlow } from '../ClusterPreflightFlow'
import { BootstrapLogView, ModalHeader, errorLog, isTerminalLog, modalPanel } from '../shared'
import type { BootstrapLog, Environment } from '../types'

export function ClusterBootstrapModal({ env, onClose, onBootstrapped }: {
  env: Environment
  onClose: () => void
  onBootstrapped: () => void
}) {
  const stream = useSSEStream<BootstrapLog>({
    isTerminal: isTerminalLog,
    errorEvent: errorLog,
    onEvent: e => { if (e.type === 'done') onBootstrapped() },
  })
  const started = stream.running || stream.events.length > 0
  // Closing mid-bootstrap would abort the stream; block it while running.
  const close = () => { if (!stream.running) onClose() }

  return createPortal(
    <Dialog onClose={close} closeOnEscape={!stream.running} closeOnBackdrop={!stream.running}
      label="Bootstrap cluster" className={`${modalPanel} max-w-lg`}>
      <ModalHeader
        title={`Bootstrap · ${env.name}`}
        icon={<Rocket size={14} className="text-accent" aria-hidden />}
        onClose={stream.running ? undefined : onClose}
      />

      <div className="p-5 space-y-4">
        {!started && (
          <ClusterPreflightFlow envId={env.id} onReady={() => stream.start(`/api/environments/${env.id}/bootstrap`)} />
        )}

        {stream.events.length > 0 && (
          <>
            <BootstrapLogView logs={stream.events} running={stream.running && !stream.done} maxHeight="max-h-80" />
            {stream.done && (
              <div className="flex justify-end pt-1">
                <Button onClick={onClose}>Done</Button>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>,
    document.body,
  )
}
