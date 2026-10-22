import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { GroupRun } from '@/lib/agent-group-launch'
import { translate } from '@/i18n/i18n'

const messageSchema = z.object({
  id: z.string(),
  type: z.string(),
  subject: z.string(),
  body: z.string()
})
const inboxSchema = z.object({
  messages: z.array(messageSchema),
  pendingQuestions: z.array(messageSchema).optional()
})

export function AgentGroupInbox({ run, target }: { run: GroupRun; target: RuntimeClientTarget }) {
  const identity = JSON.stringify([
    target.kind,
    target.kind === 'environment' ? target.environmentId : null,
    run.id,
    run.from
  ])
  return <RunInbox key={identity} run={run} target={target} />
}

type InboxRequest = { controller: AbortController; busy: boolean }

function RunInbox({ run, target }: { run: GroupRun; target: RuntimeClientTarget }) {
  const [messages, setMessages] = useState<z.infer<typeof inboxSchema>['messages']>([])
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set())
  const [reply, setReply] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const request = useRef<InboxRequest | null>(null)
  const environmentId = target.kind === 'environment' ? target.environmentId : undefined
  const load = useCallback(
    async (current: InboxRequest) => {
      const runtimeTarget: RuntimeClientTarget =
        environmentId === undefined ? { kind: 'local' } : { kind: 'environment', environmentId }
      const result = inboxSchema.parse(
        await callRuntimeRpc(
          runtimeTarget,
          'orchestration.check',
          {
            run: run.id,
            terminal: run.from,
            all: true
          },
          { signal: current.controller.signal }
        )
      )
      if (current.controller.signal.aborted) {
        return
      }
      const questions =
        result.pendingQuestions ?? result.messages.filter((message) => message.type === 'question')
      const ids = new Set(questions.map((message) => message.id))
      setPendingIds(ids)
      setMessages([...questions, ...result.messages.filter((message) => !ids.has(message.id))])
    },
    [run.id, run.from, environmentId]
  )
  const refresh = useCallback(async () => {
    const current = request.current
    if (!current || current.busy || current.controller.signal.aborted) {
      return
    }
    current.busy = true
    setBusy(true)
    setError(null)
    try {
      await load(current)
    } catch (cause) {
      if (!current.controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      current.busy = false
      if (!current.controller.signal.aborted) {
        setBusy(false)
      }
    }
  }, [load])
  useEffect(() => {
    const current: InboxRequest = { controller: new AbortController(), busy: false }
    request.current = current
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => {
      current.controller.abort()
      clearInterval(timer)
    }
  }, [refresh])
  async function send() {
    const current = request.current
    if (
      !selected ||
      !pendingIds.has(selected) ||
      !reply.trim() ||
      !current ||
      current.busy ||
      current.controller.signal.aborted
    ) {
      return
    }
    current.busy = true
    setBusy(true)
    setError(null)
    try {
      await callRuntimeRpc(
        target,
        'orchestration.reply',
        {
          id: selected,
          body: reply.trim(),
          run: run.id,
          from: run.from
        },
        { signal: current.controller.signal }
      )
      if (current.controller.signal.aborted) {
        return
      }
      setSelected(null)
      setReply('')
      await load(current)
    } catch (cause) {
      if (!current.controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      current.busy = false
      if (!current.controller.signal.aborted) {
        setBusy(false)
      }
    }
  }
  return (
    <details className="text-xs">
      <summary className="cursor-pointer">
        {translate('agentGroup.messages', 'Group messages')} ({messages.length})
      </summary>
      <div className="mt-2 flex flex-col gap-3">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
          {translate('agentGroup.refreshMessages', 'Refresh messages')}
        </Button>
        {messages.map((message) => (
          <div key={message.id} className="flex flex-col gap-1">
            <p className="font-medium">
              {message.type}: {message.subject}
            </p>
            <p className="whitespace-pre-wrap break-words">{message.body}</p>
            {pendingIds.has(message.id) && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setSelected(message.id)
                  setReply('')
                }}
              >
                {translate('agentGroup.reply', 'Reply')}
              </Button>
            )}
          </div>
        ))}
        {selected && pendingIds.has(selected) && (
          <>
            <Label htmlFor="group-reply">
              {translate('agentGroup.answer', 'Answer to selected question')}
            </Label>
            <Textarea
              id="group-reply"
              disabled={busy}
              value={reply}
              onChange={(event) => setReply(event.target.value)}
            />
            <Button size="sm" disabled={busy || !reply.trim()} onClick={() => void send()}>
              {translate('agentGroup.sendReply', 'Send reply')}
            </Button>
          </>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </div>
    </details>
  )
}
