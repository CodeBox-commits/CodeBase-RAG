import { useEffect, useRef, useState } from 'react'
import type { ThemedToken } from 'shiki/core'
import { cn } from '@/lib/utils'
import { tokenize, type Lang } from '@/lib/highlight'

/**
 * Source with a line-number gutter. Lines in `mark` get the highlighter: the exact lines a
 * citation points at. The first marked line scrolls into view when `scrollToMark` is set.
 */
export default function CodeBlock({
  code,
  lang,
  startLine = 1,
  mark,
  scrollToMark = false,
  className,
}: {
  code: string
  lang: Lang
  startLine?: number
  mark?: [number, number]
  scrollToMark?: boolean
  className?: string
}) {
  const [tokens, setTokens] = useState<{ code: string; lines: ThemedToken[][] | null } | null>(null)
  const markRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    tokenize(code, lang).then((lines) => { if (!cancelled) setTokens({ code, lines }) })
    return () => { cancelled = true }
  }, [code, lang])

  const markStart = mark?.[0]
  useEffect(() => {
    if (scrollToMark) markRef.current?.scrollIntoView({ block: 'center' })
  }, [scrollToMark, tokens, markStart])

  const plain = code.replace(/\n$/, '').split('\n')
  const lines = tokens?.code === code && tokens.lines ? tokens.lines : null
  return (
    <pre className={cn('overflow-auto py-2 font-mono text-[0.8rem] leading-[1.6]', className)}>
      {plain.map((text, i) => {
        const n = startLine + i
        const hit = mark && n >= mark[0] && n <= mark[1]
        return (
          <div
            key={n}
            ref={hit && n === mark![0] ? markRef : undefined}
            className={cn('flex min-w-max pr-4', hit && 'bg-highlight/70 text-highlight-ink dark:bg-highlight/25 dark:text-foreground')}
          >
            <span
              aria-hidden
              className={cn(
                'sticky left-0 w-12 shrink-0 select-none bg-inherit pr-3 text-right text-muted-foreground/70 tabular-nums',
                hit && 'font-semibold text-highlight-ink dark:text-highlight',
              )}
            >
              {n}
            </span>
            <code className="whitespace-pre">
              {lines?.[i]
                ? lines[i].map((t, k) => (
                    <span
                      key={k}
                      style={{
                        color: t.color,
                        fontStyle: t.fontStyle && t.fontStyle & 1 ? 'italic' : undefined,
                        fontWeight: t.fontStyle && t.fontStyle & 2 ? 600 : undefined,
                      }}
                    >
                      {t.content}
                    </span>
                  ))
                : text || ' '}
            </code>
          </div>
        )
      })}
    </pre>
  )
}
