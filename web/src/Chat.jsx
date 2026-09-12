import React, { useEffect, useRef, useState } from 'react'
import Markdown from './markdown.jsx'

const compact = n =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n ?? 0)
const money = n => (n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`)
export const clock = s =>
  s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`

export default function Chat ({
  scope, messages, onPush, busy, onBusy, disabled,
  onClearScope, onGraphChanged, onSessionStarted,
  queuedPrompt, onQueuedConsumed, onUsage, spend,
  model, models, resolvedModel, onPickModel, onModelResolved, onStop
}) {
  const [input, setInput] = useState('')
  // A long turn can sit on one tool call for minutes with nothing to show. The
  // elapsed count is the part that proves it is still alive.
  const [elapsed, setElapsed] = useState(0)
  const boxRef = useRef(null)
  // Follow the tail only while we are already at it, so scrolling up to read
  // something mid-turn does not get yanked back by the next streamed message.
  const stick = useRef(true)

  useEffect(() => {
    if (!busy) return
    setElapsed(0)
    const started = Date.now()
    const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(id)
  }, [busy])

  useEffect(() => {
    const box = boxRef.current
    // Set scrollTop rather than scrollIntoView({ behavior: 'smooth' }): smooth
    // silently does nothing here, which left a replayed transcript at the top.
    if (box && stick.current) box.scrollTop = box.scrollHeight
  }, [messages.length])

  // `scoped` is false for a prompt the app queued: a pass over the whole diagram
  // must not be narrowed to whichever box happens to be selected.
  async function runPrompt (prompt, { scoped = true, allowLayout = false } = {}) {
    if (!prompt?.trim() || busy || disabled) return
    const focus = scoped && scope ? { kind: scope.kind, id: scope.id } : null
    onBusy(true)
    onPush({ role: 'user', text: prompt, scope: scoped ? scope?.label : undefined })

    // Any failure past this point has to land in the transcript and release the
    // prompt box, or the pane is dead until reload.
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, scope: focus, allowLayout })
      })

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '')
        throw new Error(`server returned ${res.status}. ${detail.slice(0, 300)}`)
      }

      // Hand-rolled SSE reader: EventSource can't POST.
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split('\n\n')
        buffer = chunks.pop()
        for (const chunk of chunks) {
          const event = chunk.match(/^event: (.+)$/m)?.[1]
          if (!event) continue
          let data
          try {
            data = JSON.parse(chunk.match(/^data: (.+)$/m)?.[1] ?? '{}')
          } catch {
            continue
          }
          if (event === 'text') onPush({ role: 'assistant', text: data.text })
          if (event === 'tool') onPush({ role: 'tool', text: data.name.replace('mcp__canvas__', 'canvas.') })
          if (event === 'notice') onPush({ role: 'tool', text: data.text })
          if (event === 'error') onPush({ role: 'error', text: data.message })
          if (event === 'session' && data.sessionId) onSessionStarted(data.sessionId)
          if (event === 'model' && data.model) onModelResolved?.(data.model)
          if (event === 'graph' && data.graph) onGraphChanged(data.graph)
          if (event === 'done' && data.graph) onGraphChanged(data.graph)
          if (event === 'done' && data.usage) {
            const u = data.usage
            onUsage?.(u)
            onPush({
              role: 'usage',
              text: `${compact(u.input)} in · ${compact(u.output)} out · ` +
                `${compact(u.cacheRead)} cached · ${money(u.costUSD)} · ${clock(Math.round(u.ms / 1000))}`
            })
          }
        }
      }
    } catch (err) {
      onPush({ role: 'error', text: `Could not reach the agent: ${err.message}` })
    } finally {
      onBusy(false)
    }
  }

  function send (e) {
    e.preventDefault()
    const prompt = input.trim()
    if (!prompt || busy || disabled) return
    setInput('')
    runPrompt(prompt)
  }

  // A prompt handed over by the app - today, the refine pass after a scan. Held
  // until the pane is free, then consumed so it cannot fire twice.
  useEffect(() => {
    if (!queuedPrompt || busy || disabled) return
    runPrompt(queuedPrompt.text, { scoped: false, allowLayout: !!queuedPrompt.allowLayout })
    onQueuedConsumed()
  }, [queuedPrompt, busy, disabled])

  const placeholder = disabled
    ? 'Add a repo first'
    : busy ? 'Working...' : 'What should change?'

  return (
    <section className="chat">
      <div
        className="messages"
        ref={boxRef}
        onScroll={e => {
          const b = e.currentTarget
          stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 120
        }}
      >
        {messages.length === 0 && (
          <p className="hint">
            Pick a box or an arrow on the canvas to scope a prompt to it, or just describe
            what you want changed.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.scope && <span className="chip small">{m.scope}</span>}
            {m.role === 'assistant'
              ? <Markdown text={m.text} />
              : <span>{m.text}</span>}
          </div>
        ))}
        {busy && (
          <div className="working">
            <span className="spinner" aria-hidden="true" />
            <span>Working… {clock(elapsed)}</span>
          </div>
        )}
      </div>

      <div className="spend">
        <select
          value={model ?? ''}
          disabled={busy}
          onChange={e => onPickModel(e.target.value)}
          title={resolvedModel ? `Last turn ran on ${resolvedModel}` : 'Model for the next turn'}
        >
          {(models ?? []).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        {resolvedModel && <span className="muted" title="Reported by the SDK at the start of the last turn">{resolvedModel}</span>}
        {spend?.turns > 0 && (
          <span title="This session, as reported by the Agent SDK. An estimate, not a bill.">
            {spend.turns} turn{spend.turns === 1 ? '' : 's'} · {compact(spend.input)} in ·{' '}
            {compact(spend.output)} out · {money(spend.costUSD)} · {clock(Math.round(spend.ms / 1000))}
          </span>
        )}
      </div>

      <form onSubmit={send}>
        {scope && (
          <div className="scope">
            <span className="chip">{scope.label}</span>
            <button type="button" onClick={onClearScope}>clear</button>
          </div>
        )}
        <textarea
          rows={3}
          value={input}
          disabled={disabled}
          placeholder={placeholder}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) send(e)
          }}
        />
        <div className="send-row">
          <button className="primary" disabled={busy || disabled}>{busy ? 'Working' : 'Send'}</button>
          {busy && (
            <button type="button" onClick={onStop} title="Interrupt the turn in progress">
              Stop
            </button>
          )}
        </div>
      </form>
    </section>
  )
}
