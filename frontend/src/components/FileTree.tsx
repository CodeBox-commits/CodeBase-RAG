import { ChevronRight, FileCode2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'

interface TreeNode {
  name: string
  path: string
  children: Map<string, TreeNode>
  count: number
  isFile: boolean
}

function buildTree(counts: Map<string, number>): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), count: 0, isFile: false }
  counts.forEach((count, filepath) => {
    const parts = filepath.split('/')
    let node = root
    node.count += count
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/')
      let child = node.children.get(part)
      if (!child) {
        child = { name: part, path, children: new Map(), count: 0, isFile: i === parts.length - 1 }
        node.children.set(part, child)
      }
      child.count += count
      node = child
    })
  })
  return root
}

function sorted(node: TreeNode) {
  return [...node.children.values()].sort((a, b) => Number(a.isFile) - Number(b.isFile) || a.name.localeCompare(b.name))
}

function Branch({ node, depth, selected, onSelect, max }: {
  node: TreeNode; depth: number; selected: string | null; onSelect: (p: string | null) => void; max: number
}) {
  const [open, setOpen] = useState(depth < 2)
  const active = selected === node.path
  return (
    <li>
      <button
        className={cn(
          'group flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[0.8rem] transition-colors hover:bg-accent',
          active && 'bg-thread-soft text-foreground',
        )}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => {
          if (!node.isFile) setOpen((o) => !o)
          onSelect(active ? null : node.path)
        }}
        aria-expanded={node.isFile ? undefined : open}
        aria-pressed={active}
      >
        {node.isFile ? (
          <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden />
        )}
        <span className={cn('min-w-0 flex-1 truncate', node.isFile ? 'font-mono text-[0.76rem]' : 'font-medium')}>{node.name}</span>
        {/* Bar length: how many symbols this file or folder holds, relative to the largest. */}
        <span aria-hidden className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-rule-soft">
          <span className={cn('block h-full rounded-full bg-pencil/60', active && 'bg-thread')} style={{ width: `${(node.count / max) * 100}%` }} />
        </span>
        <span className="w-7 shrink-0 text-right text-[0.72rem] text-muted-foreground tabular-nums">{node.count}</span>
      </button>
      {!node.isFile && open && (
        <ul>
          {sorted(node).map((c) => (
            <Branch key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} max={max} />
          ))}
        </ul>
      )}
    </li>
  )
}

/** Directory tree of the indexed files, sized by how many symbols each holds. */
export default function FileTree({ filepaths, selected, onSelect }: {
  filepaths: string[]; selected: string | null; onSelect: (p: string | null) => void
}) {
  const root = useMemo(() => {
    const counts = new Map<string, number>()
    filepaths.forEach((f) => counts.set(f, (counts.get(f) ?? 0) + 1))
    return buildTree(counts)
  }, [filepaths])
  const max = Math.max(1, ...sorted(root).map((c) => c.count))
  return (
    <ul className="space-y-px">
      {sorted(root).map((c) => (
        <Branch key={c.path} node={c} depth={0} selected={selected} onSelect={onSelect} max={max} />
      ))}
    </ul>
  )
}
