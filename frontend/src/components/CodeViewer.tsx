import { useEffect, useRef, useState } from 'react'
import { getCodeAt, type CodeAt } from '../api'
import { STATUS_LABEL, type Citation, type CitationStatus } from '../citations'

/** What a citation chip points at; `status` is unknown while the answer is still streaming. */
export interface CitationTarget {
  text: string
  filepath: string
  line: number
  end_line: number
  status?: CitationStatus
}

export function targetFromText(text: string, citation?: Citation): CitationTarget {
  if (citation) return citation
  const m = /^(.*):(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(text.trim())
  const line = m ? Number(m[2]) : 1
  return { text, filepath: m ? m[1] : text, line, end_line: m?.[3] ? Number(m[3]) : line }
}

export function CitationChip({ target, onOpen }: { target: CitationTarget; onOpen: (t: CitationTarget) => void }) {
  const status = target.status ?? 'pending'
  return (
    <button
      type="button"
      className={`cite cite-${status}`}
      title={target.status ? STATUS_LABEL[target.status] : 'Checking…'}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(target)
      }}
    >
      <span className="cite-mark" aria-hidden>{status === 'verified' ? '✓' : status === 'graph' ? '◇' : status === 'pending' ? '·' : '!'}</span>
      {target.text}
    </button>
  )
}

export default function CodeViewer({ repoUrl, target, onClose }: { repoUrl: string; target: CitationTarget; onClose: () => void }) {
  const [code, setCode] = useState<{ key: string; data?: CodeAt; error?: string } | null>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const key = `${repoUrl}|${target.filepath}|${target.line}`

  useEffect(() => {
    let cancelled = false
    getCodeAt(repoUrl, target.filepath, target.line)
      .then((data) => { if (!cancelled) setCode({ key, data }) })
      .catch((e) => { if (!cancelled) setCode({ key, error: (e as Error).message }) })
    return () => { cancelled = true }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const current = code?.key === key ? code : null
  useEffect(() => { highlightRef.current?.scrollIntoView({ block: 'center' }) }, [current?.data])

  const lines = current?.data?.code?.split('\n') ?? []
  const first = current?.data?.start_line ?? 1
  return (
    <div className="code-viewer" role="dialog" aria-label={`Code at ${target.text}`}>
      <header className="code-viewer-head">
        <div>
          <code className="mono">{target.filepath}:{target.line}{target.end_line > target.line ? `–${target.end_line}` : ''}</code>
          {current?.data && <div className="muted small">in <b className="mono">{current.data.name}</b> ({current.data.type})</div>}
        </div>
        <button className="icon" aria-label="Close" onClick={onClose}>×</button>
      </header>
      {target.status && <p className={`cite-note cite-${target.status}`}>{STATUS_LABEL[target.status]}</p>}
      {!current && <div className="muted small"><span className="spinner tiny" /> Loading code…</div>}
      {current?.error && <p className="muted small">{current.error}. The line may be outside any indexed function or class.</p>}
      {lines.length > 0 && (
        <pre className="code-lines">
          {lines.map((text, i) => {
            const n = first + i
            const hit = n >= target.line && n <= target.end_line
            return (
              <div key={n} ref={hit && n === target.line ? highlightRef : undefined} className={hit ? 'hit' : ''}>
                <span className="ln">{n}</span>{text || ' '}
              </div>
            )
          })}
        </pre>
      )}
    </div>
  )
}
