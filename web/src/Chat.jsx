import React, { useEffect, useRef, useState } from 'react'

export default function Chat ({
  scope, messages, onPush, busy, onBusy, disabled,
  onClearScope, onGraphChanged, onSessionStarted
}) {
  const [input, setInput] = useState('')
  const endRef = useRef(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  async function send (e) {
    e.preventDefault()
    const prompt = input.trim()
    if (!prompt || busy || disabled) return
    setInput('')
    onBusy(true)
    onPush({ role: 'user', text: prompt, scope: scope?.label })

    // Any failure past this point has to land in the transcript and release the
    // prompt box, or the pane is dead until reload.
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, nodeId: scope?.id ?? null })
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
          if (event === 'done' && data.graph) onGraphChanged(data.graph)
        }
      }
    } catch (err) {
      onPush({ role: 'error', text: `Could not reach the agent: ${err.message}` })
    } finally {
      onBusy(false)
    }
  }

  const placeholder = disabled
    ? 'Add a repo first'
    : busy ? 'Working...' : 'What should change?'

  return (
    <section className="chat">
      <div className="messages">
        {messages.length === 0 && (
          <p className="hint">
            Pick a box on the canvas to scope a prompt to it, or just describe what you want changed.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.scope && <span className="chip small">{m.scope}</span>}
            <span>{m.text}</span>
          </div>
        ))}
        <div ref={endRef} />
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
        <button className="primary" disabled={busy || disabled}>{busy ? 'Working' : 'Send'}</button>
      </form>
    </section>
  )
}
