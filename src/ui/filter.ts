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

/** 结构化结果里的字符串字段（Bash 的 stdout/stderr、Agent 的 content 等） */
function structuredText(s?: Record<string, unknown>): string {
  if (!s) return ''
  const out: string[] = []
  for (const v of Object.values(s)) if (typeof v === 'string' && v) out.push(v)
  return out.join(' ')
}

function buildSearchable(n: LogNode): string {
  switch (n.kind) {
    case 'text':
    case 'thinking':
      return n.text
    case 'tool':
      return [
        n.name,
        n.label,
        JSON.stringify(n.input),
        n.result?.text ?? '',
        structuredText(n.result?.structured),
        n.task?.description ?? '',
        n.task?.prompt ?? '',
        n.task?.summary ?? '',
      ].join(' ')
    case 'system':
      return `${n.title} ${n.subtype} ${n.rawJson ?? ''}`
  }
}

// 每次按键都会重新过滤整棵树，拼接结果按节点缓存，避免反复拼几 MB 字符串
const cache = new WeakMap<LogNode, string>()

function searchableText(n: LogNode): string {
  let s = cache.get(n)
  if (s === undefined) {
    s = buildSearchable(n).toLowerCase()
    cache.set(n, s)
  }
  return s
}

/**
 * 这个工具调用是不是在启动指定的子 agent。
 *
 * 光看 n.agent 不够：Agent 调用卡片本身发生在主会话里，靠"有后代命中"才被保留。
 * 而启动失败的调用（比如 model 参数非法）压根没有子事件，就会被过滤掉 ——
 * 恰恰是最该被看到的那条。
 */
function launchesAgent(n: LogNode, agent: string): boolean {
  if (n.kind !== 'tool') return false
  if (n.task?.subagentType === agent) return true
  return typeof n.input.subagent_type === 'string' && n.input.subagent_type === agent
}

function matchSelf(n: LogNode, f: FilterState): boolean {
  if (!f.kinds.has(n.kind)) return false
  if (f.tool && !(n.kind === 'tool' && n.name === f.tool)) return false
  if (f.agent && (n.agent ?? 'main') !== f.agent && !launchesAgent(n, f.agent)) return false
  const q = f.query.trim().toLowerCase()
  if (q && !searchableText(n).includes(q)) return false
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

/**
 * 找到目标节点的祖先链（都是 Agent 工具节点）。
 * 子 agent 的时间线只在父卡片展开时才渲染，跳转前必须把这条链上的卡片打开。
 * 返回 null 表示树里没有这个节点。
 */
export function pathToNode(nodes: LogNode[], targetId: string): string[] | null {
  for (const n of nodes) {
    if (n.id === targetId) return []
    if (n.kind === 'tool' && n.children.length) {
      const sub = pathToNode(n.children, targetId)
      if (sub) return [n.id, ...sub]
    }
  }
  return null
}

export function countNodes(nodes: LogNode[]): number {
  let n = 0
  for (const node of nodes) {
    n++
    if (node.kind === 'tool') n += countNodes(node.children)
  }
  return n
}
