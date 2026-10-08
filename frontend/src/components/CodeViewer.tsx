import { CircleAlert, CircleCheck, Diamond, Loader } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { langFor } from '@/lib/highlight'
import { cn } from '@/lib/utils'
import { getCodeAt, type CodeAt } from '../api'
import { STATUS_LABEL, type Citation, type CitationStatus } from '../citations'
import CodeBlock from './CodeBlock'

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

const STATUS_ICON: Record<CitationStatus, typeof CircleCheck> = {
  verified: CircleCheck,
  graph: Diamond,
  wrong_line: CircleAlert,
  unknown_file: CircleAlert,
}

export function StatusMark({ status, className }: { status?: CitationStatus; className?: string }) {
  if (!status) return <Loader className={cn('size-3 animate-spin text-muted-foreground', className)} aria-hidden />
  const Icon = STATUS_ICON[status]
  return (
    <Icon
      aria-hidden
      className={cn(
        'size-3 shrink-0',
        status === 'verified' && 'text-verified',
        status === 'graph' && 'text-thread',
        (status === 'wrong_line' || status === 'unknown_file') && 'text-check',
        className,
      )}
    />
  )
}

/** A file:line reference in an answer. Its mark says whether the line was in the code the model saw. */
export function CitationChip({ target, onOpen }: { target: CitationTarget; onOpen: (t: CitationTarget) => void }) {
  const unsure = target.status === 'wrong_line' || target.status === 'unknown_file'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onOpen(target) }}
          className={cn(
            'inline-flex translate-y-[-1px] items-center gap-1 rounded-[5px] border bg-sheet px-1.5 py-px align-baseline font-mono text-[0.78em] leading-[1.45] text-foreground',
            'transition-colors hover:border-graphite/40 hover:bg-accent',
            unsure && 'border-check/50 border-dashed',
          )}
        >
          <StatusMark status={target.status} />
          {target.text}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{target.status ? STATUS_LABEL[target.status] : 'Checking against the context…'}</TooltipContent>
    </Tooltip>
  )
}

/** The code a citation points at, with the cited lines marked in highlighter. */
export default function CodeViewer({ repoUrl, target, onClose }: { repoUrl: string; target: CitationTarget | null; onClose: () => void }) {
  const [code, setCode] = useState<{ key: string; data?: CodeAt; error?: string } | null>(null)
  const key = target ? `${repoUrl}|${target.filepath}|${target.line}` : ''

  useEffect(() => {
    if (!target) return
    let cancelled = false
    getCodeAt(repoUrl, target.filepath, target.line)
      .then((data) => { if (!cancelled) setCode({ key, data }) })
      .catch((e) => { if (!cancelled) setCode({ key, error: (e as Error).message }) })
    return () => { cancelled = true }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const current = code?.key === key ? code : null
  return (
    <Sheet open={target != null} onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent side="right" className="w-full gap-0 bg-sheet p-0 sm:max-w-2xl">
        {target && (
          <>
            <SheetHeader className="gap-1.5 border-b px-5 py-4 pr-12">
              <SheetTitle className="break-all font-mono text-[0.86rem] font-medium">
                {target.filepath}:{target.line}{target.end_line > target.line ? `–${target.end_line}` : ''}
              </SheetTitle>
              <SheetDescription className="text-xs">
                {current?.data ? (
                  <>In <span className="font-mono text-foreground">{current.data.name}</span>, a {current.data.type} spanning lines {current.data.start_line} to {current.data.end_line}.</>
                ) : current?.error ? 'Not inside an indexed function, method or class.' : 'Loading the code…'}
              </SheetDescription>
              {target.status && (
                <p
                  className={cn(
                    'mt-1 flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs leading-snug',
                    target.status === 'verified' && 'border-verified/30 text-verified',
                    target.status === 'graph' && 'border-thread/30 text-thread',
                    (target.status === 'wrong_line' || target.status === 'unknown_file') && 'border-check/40 text-check',
                  )}
                >
                  <StatusMark status={target.status} className="mt-px size-3.5" />
                  {STATUS_LABEL[target.status]}
                </p>
              )}
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-auto bg-background/40">
              {current?.data?.code ? (
                <CodeBlock
                  code={current.data.code}
                  lang={langFor(current.data.filepath)}
                  startLine={current.data.start_line}
                  mark={[target.line, target.end_line]}
                  scrollToMark
                  className="min-h-full"
                />
              ) : current?.error ? (
                <p className="p-5 text-sm text-muted-foreground">
                  {current.error}. The line may sit between definitions (imports, module-level code), or the file may not be indexed.
                </p>
              ) : (
                <div className="space-y-2 p-5" aria-hidden>
                  {Array.from({ length: 9 }, (_, i) => (
                    <div key={i} className="h-3 animate-pulse rounded bg-muted" style={{ width: `${40 + ((i * 37) % 55)}%` }} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
