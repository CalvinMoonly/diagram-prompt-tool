import React from 'react'

// A small markdown renderer for the subset the agent actually emits: headings,
// emphasis, inline and fenced code, lists, GFM tables, blockquotes, links and
// rules. It builds React elements directly - nothing reaches innerHTML - so a
// model that echoes markup back at us cannot inject anything into the page.
// Whatever it does not recognise stays literal text, which is the honest
// failure mode for chat output.

const INLINE =
  '`([^`]+)`' +                          // code
  '|\\*\\*([\\s\\S]+?)\\*\\*' +          // bold
  '|__([\\s\\S]+?)__' +                  // bold
  '|\\*([^*\\n]+?)\\*' +                 // italic
  '|_([^_\\n]+?)_' +                     // italic
  '|~~([\\s\\S]+?)~~' +                  // strikethrough
  '|\\[([^\\]]+)\\]\\(([^)\\s]+)\\)'     // link

// Only these become real links. Anything else renders as its own source text,
// so `javascript:` and friends cannot ride in on a model's output.
const SAFE_HREF = /^(https?:|mailto:|\/|#)/i

const FENCE = /^\s*(```|~~~)/
const HEADING = /^(#{1,6})\s+(.*)$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const QUOTE = /^\s*>\s?(.*)$/
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

// A table's second line: pipes and dashes only, e.g. |---|:--:|
const isSeparator = l => /\|/.test(l) && /-/.test(l) && /^[\s|:-]+$/.test(l)

const opensBlock = (line, next) =>
  FENCE.test(line) || HEADING.test(line) || RULE.test(line) ||
  QUOTE.test(line) || ITEM.test(line) ||
  (line.includes('|') && isSeparator(next ?? ''))

// Drops at most n leading spaces, never eating into the text itself.
const dedent = (line, n) => line.slice(Math.min(n, line.length - line.trimStart().length))

const cells = row => {
  let s = row.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map(c => c.trim())
}

function inline (text) {
  const re = new RegExp(INLINE, 'g') // fresh per call: this recurses
  const out = []
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const key = out.length
    if (m[1] != null) out.push(<code key={key}>{m[1]}</code>)
    else if (m[2] != null) out.push(<strong key={key}>{inline(m[2])}</strong>)
    else if (m[3] != null) out.push(<strong key={key}>{inline(m[3])}</strong>)
    else if (m[4] != null) out.push(<em key={key}>{inline(m[4])}</em>)
    else if (m[5] != null) out.push(<em key={key}>{inline(m[5])}</em>)
    else if (m[6] != null) out.push(<del key={key}>{inline(m[6])}</del>)
    else if (m[7] != null) {
      out.push(SAFE_HREF.test(m[8])
        ? <a key={key} href={m[8]} target="_blank" rel="noreferrer">{inline(m[7])}</a>
        : m[0])
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function list (lines, start) {
  const first = lines[start].match(ITEM)
  const base = first[1].length
  const ordered = /\d/.test(first[2])
  const items = []
  let i = start

  while (i < lines.length) {
    const m = lines[i].match(ITEM)
    if (!m || m[1].length > base) break
    const body = [m[3]]
    i++
    // Continuation and nested lines: anything up to the next item at this level.
    while (i < lines.length && lines[i].trim()) {
      const n = lines[i].match(ITEM)
      if (n && n[1].length <= base) break
      body.push(dedent(lines[i], base + 2))
      i++
    }
    items.push(body.length === 1 && !opensBlock(body[0], '')
      ? inline(body[0])
      : blocks(body.join('\n')))
    // A blank line inside a list is still the same list if an item follows.
    let peek = i
    while (peek < lines.length && !lines[peek].trim()) peek++
    const after = lines[peek]?.match(ITEM)
    if (after && after[1].length <= base) i = peek
  }

  const Tag = ordered ? 'ol' : 'ul'
  const startAt = ordered ? Number(first[2].replace(/\D/g, '')) : undefined
  return [
    <Tag start={startAt !== 1 ? startAt : undefined}>
      {items.map((it, n) => <li key={n}>{it}</li>)}
    </Tag>,
    i
  ]
}

function blocks (src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n')
  const out = []
  const push = el => out.push(React.cloneElement(el, { key: out.length }))
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    if (FENCE.test(line)) {
      const marker = line.trim().slice(0, 3)
      const body = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++])
      i++ // closing fence, or past the end if the turn was cut off mid-block
      push(<pre><code>{body.join('\n')}</code></pre>)
      continue
    }

    const h = line.match(HEADING)
    if (h) {
      const Tag = `h${h[1].length}`
      push(<Tag>{inline(h[2])}</Tag>)
      i++
      continue
    }

    if (RULE.test(line)) { push(<hr />); i++; continue }

    if (line.includes('|') && isSeparator(lines[i + 1] ?? '')) {
      const head = cells(line)
      const align = cells(lines[i + 1]).map(c =>
        c.startsWith(':') && c.endsWith(':') ? 'center'
          : c.endsWith(':') ? 'right'
            : c.startsWith(':') ? 'left' : undefined)
      i += 2
      const rows = []
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]))
      push(
        // Own scroller: the chat pane is narrow and a wide table must not
        // widen the column or clip.
        <div className="md-table">
          <table>
            <thead>
              <tr>{head.map((c, n) => <th key={n} style={{ textAlign: align[n] }}>{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, n) => (
                <tr key={n}>
                  {r.map((c, k) => <td key={k} style={{ textAlign: align[k] }}>{inline(c)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

    if (QUOTE.test(line)) {
      const body = []
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].match(QUOTE)[1])
      push(<blockquote>{blocks(body.join('\n'))}</blockquote>)
      continue
    }

    if (ITEM.test(line)) {
      const [el, next] = list(lines, i)
      push(el)
      i = next
      continue
    }

    const para = [lines[i++]]
    while (i < lines.length && lines[i].trim() && !opensBlock(lines[i], lines[i + 1])) {
      para.push(lines[i++])
    }
    push(<p>{inline(para.join('\n'))}</p>)
  }

  return out
}

export default function Markdown ({ text }) {
  return <div className="md">{blocks(text ?? '')}</div>
}
