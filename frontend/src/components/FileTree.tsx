import { useMemo, useState } from 'react'

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
        className={`tree-row ${active ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          if (!node.isFile) setOpen((o) => !o)
          onSelect(active ? null : node.path)
        }}
        aria-expanded={node.isFile ? undefined : open}
      >
        <span className="tree-icon" aria-hidden>{node.isFile ? '◆' : open ? '▾' : '▸'}</span>
        <span className="tree-name">{node.name}</span>
        <span className="tree-bar" aria-hidden><span style={{ width: `${(node.count / max) * 100}%` }} /></span>
        <span className="tree-count">{node.count}</span>
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
    <ul className="file-tree">
      {sorted(root).map((c) => (
        <Branch key={c.path} node={c} depth={0} selected={selected} onSelect={onSelect} max={max} />
      ))}
    </ul>
  )
}
