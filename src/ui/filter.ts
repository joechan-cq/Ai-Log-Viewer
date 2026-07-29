import type { LogNode } from '../model/types'

export type NodeKindKey = 'text' | 'thinking' | 'tool' | 'system'
export const ALL_KINDS: NodeKindKey[] = ['text', 'thinking', 'tool', 'system']

export interface FilterState {
  query: string
  /** 只看某个工具（点统计面板的工具行会设置它） */
  tool?: string
  /** 只看某个 agent（main 或 subagent_type） */
  agent?: string
  kinds: Set<NodeKindKey>
}

export function isFilterActive(f: FilterState): boolean {
  return !!f.query.trim() || !!f.tool || !!f.agent || f.kinds.size !== ALL_KINDS.length
}

function searchableText(n: LogNode): string {
  switch (n.kind) {
    case 'text':
    case 'thinking':
      return n.text
    case 'tool':
      return `${n.name} ${n.label} ${JSON.stringify(n.input)} ${n.result?.text ?? ''} ${n.task?.summary ?? ''}`
    case 'system':
      return `${n.title} ${n.subtype} ${n.rawJson ?? ''}`
  }
}

function matchSelf(n: LogNode, f: FilterState): boolean {
  if (!f.kinds.has(n.kind)) return false
  if (f.tool && !(n.kind === 'tool' && n.name === f.tool)) return false
  if (f.agent && (n.agent ?? 'main') !== f.agent) return false
  const q = f.query.trim().toLowerCase()
  if (q && !searchableText(n).toLowerCase().includes(q)) return false
  return true
}

/** 剪枝：命中的节点保留；父级只要有后代命中就保留（作为路径） */
export function filterTree(nodes: LogNode[], f: FilterState): LogNode[] {
  if (!isFilterActive(f)) return nodes
  const out: LogNode[] = []
  for (const n of nodes) {
    if (n.kind === 'tool') {
      const kids = filterTree(n.children, f)
      const self = matchSelf(n, f)
      if (self || kids.length) out.push(kids === n.children ? n : { ...n, children: kids })
    } else if (matchSelf(n, f)) {
      out.push(n)
    }
  }
  return out
}

export function countNodes(nodes: LogNode[]): number {
  let n = 0
  for (const node of nodes) {
    n++
    if (node.kind === 'tool') n += countNodes(node.children)
  }
  return n
}
