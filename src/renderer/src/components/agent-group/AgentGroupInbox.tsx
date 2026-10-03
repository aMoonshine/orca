import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type { GroupRun } from '@/lib/agent-group-launch'
import { translate } from '@/i18n/i18n'

const inboxSchema = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      subject: z.string(),
      body: z.string()
    })
  )
})

export function AgentGroupInbox({ run, target }: { run: GroupRun; target: RuntimeClientTarget }) {
  const [messages, setMessages] = useState<z.infer<typeof inboxSchema>['messages']>([])
  const [reply, setReply] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = inboxSchema.parse(
        await callRuntimeRpc(target, 'orchestration.check', {
          run: run.id,
          terminal: run.from,
          all: true
        })
      )
      setMessages(result.messages)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [run.id, run.from, target])
  useEffect(() => {
    let stopped = false
    let refreshing = false
    const poll = async () => {
      if (stopped || refreshing) {
        return
      }
      refreshing = true
      await refresh()
      refreshing = false
    }
    void poll()
    const timer = setInterval(() => void poll(), 5000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [refresh])
  async function send() {
    if (!selected || !reply.trim() || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await callRuntimeRpc(target, 'orchestration.reply', {
        id: selected,
        body: reply.trim(),
        run: run.id,
        from: run.from
      })
      setSelected(null)
      setReply('')
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
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
            {message.type === 'question' && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setSelected(message.id)}
              >
                {translate('agentGroup.reply', 'Reply')}
              </Button>
            )}
          </div>
        ))}
        {selected && (
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
