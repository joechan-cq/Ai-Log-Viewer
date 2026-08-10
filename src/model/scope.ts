import { MAIN_AGENT } from './normalize'
import type { AgentStat, LogNode, ParsedLog, Stats, TokenRequest, ToolNode, ToolStat } from './types'

export const SCOPE_ALL = 'all'

export interface Scope {
  /** SCOPE_ALL / MAIN_AGENT / agent 实例的 tool_use_id */
  key: string
  label: string
  /** 副标题：agent 类型或简要说明 */
  sub?: string
}

/** 故意不写成类型谓词：调用点已经收窄到 ToolNode，写成谓词会让 else 分支被收窄成 never */
function isAgentTool(n: ToolNode): boolean {
  return n.name === 'Agent' || n.name === 'Task'
}

/** 列出可选的统计范围：全部 / 主会话 / 每一次 Agent 调用 */
export function listScopes(log: ParsedLog): Scope[] {
  const out: Scope[] = [
    { key: SCOPE_ALL, label: '全部' },
    { key: MAIN_AGENT, label: '主会话', sub: '不含子 agent' },
  ]
  const walk = (nodes: LogNode[], depth: number) => {
    for (const n of nodes) {
      if (n.kind !== 'tool') continue
      if (isAgentTool(n)) {
        const type = n.task?.subagentType ?? str(n.input.subagent_type) ?? 'agent'
        const desc = n.task?.description ?? str(n.input.description) ?? n.label
        out.push({
          key: n.toolUseId,
          label: `${'└'.repeat(depth ? 1 : 0)}${desc || type}`.slice(0, 42),
          sub: type,
        })
      }
      walk(n.children, depth + 1)
    }
  }
  walk(log.roots, 0)
  return out
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** 找到某个 agent 实例对应的 Agent 工具节点 */
function findAgentNode(nodes: LogNode[], toolUseId: string): ToolNode | undefined {
  for (const n of nodes) {
    if (n.kind !== 'tool') continue
    if (n.toolUseId === toolUseId) return n
    const hit = findAgentNode(n.children, toolUseId)
    if (hit) return hit
  }
  return undefined
}

function emptyStats(): Stats {
  return {
    bytes: 0,
    lines: 0,
    parsed: 0,
    parseErrors: 0,
    byEventType: {},
    toolCalls: {},
    skillCalls: {},
    mcpCalls: {},
    slashCommands: {},
    agents: {},
    backgroundTasks: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, ctxGrowth: 0 },
    requests: [],
    peakContext: 0,
    peakContextByAgent: {},
    thinkingTokens: 0,
    counts: {
      assistantMessages: 0,
      textBlocks: 0,
      thinkingBlocks: 0,
      toolUses: 0,
      toolResults: 0,
      userMessages: 0,
      hooks: 0,
      images: 0,
      emptyThinkingBlocks: 0,
    },
    rateLimits: [],
  }
}

function toolStat(s: Stats, name: string): ToolStat {
  return (s.toolCalls[name] ??= { count: 0, ok: 0, error: 0, totalMs: 0, ctxAdded: 0, byAgent: {} })
}

function agentStat(s: Stats, name: string): AgentStat {
  return (s.agents[name] ??= { count: 0, launches: 0, failed: 0, totalTokens: 0, toolUses: 0, durationMs: 0 })
}

function bump(rec: Record<string, number>, key: string) {
  rec[key] = (rec[key] ?? 0) + 1
}

/**
 * 按范围重算统计。
 *
 * 只用已经挂在节点上的数据（工具名、耗时、归因增量、task 信息）加上按实例过滤的请求列表，
 * 所以不需要重新解析原始日志。
 *
 * 与解析期的全局统计相比，有几项按范围算没有意义，会保持为 0：
 * 文件大小 / 行数 / 事件类型分布 / 思考 token / 速率限制。
 */
export function statsForScope(log: ParsedLog, key: string): { stats: Stats; scopedNodes: LogNode[] } {
  if (key === SCOPE_ALL) return { stats: log.stats, scopedNodes: log.roots }

  let scopedNodes: LogNode[]
  /** 该范围涵盖的实例键集合（含嵌套子 agent） */
  const instances = new Set<string>()

  if (key === MAIN_AGENT) {
    // 主会话：只看顶层节点，不递归进子 agent
    scopedNodes = log.roots.map((n) => (n.kind === 'tool' ? { ...n, children: [] } : n))
    instances.add(MAIN_AGENT)
  } else {
    const host = findAgentNode(log.roots, key)
    scopedNodes = host?.children ?? []
    instances.add(key)
    // 嵌套的子 agent 也算在这个范围内
    const collect = (nodes: LogNode[]) => {
      for (const n of nodes) {
        if (n.kind !== 'tool') continue
        if (n.children.length) instances.add(n.toolUseId)
        collect(n.children)
      }
    }
    collect(scopedNodes)
  }

  const s = emptyStats()
  let minTs: number | undefined
  let maxTs: number | undefined

  const walk = (nodes: LogNode[]) => {
    for (const n of nodes) {
      if (n.ts) {
        minTs = Math.min(minTs ?? n.ts, n.ts)
        maxTs = Math.max(maxTs ?? n.ts, n.ts)
      }
      switch (n.kind) {
        case 'text': {
          if (n.role === 'user') {
            s.counts.userMessages++
            const m = /^\s*\/([A-Za-z0-9_:-]+)/.exec(n.text)
            if (m) bump(s.slashCommands, m[1])
          } else {
            s.counts.textBlocks++
          }
          break
        }
        case 'thinking':
          s.counts.thinkingBlocks++
          break
        case 'system':
          if (n.subtype === 'hook_response') s.counts.hooks++
          break
        case 'tool': {
          s.counts.toolUses++
          const st = toolStat(s, n.name)
          st.count++
          bump(st.byAgent, n.agent ?? MAIN_AGENT)
          if (n.result) {
            s.counts.toolResults++
            if (n.result.isError) st.error++
            else st.ok++
            s.counts.images += n.result.images.length
          }
          if (n.durationMs) st.totalMs += n.durationMs
          if (n.ctxAdded) st.ctxAdded += n.ctxAdded

          if (n.name === 'Skill') {
            const sk = str(n.input.skill)
            if (sk) bump(s.skillCalls, sk)
          }
          if (n.name.startsWith('mcp__')) bump(s.mcpCalls, n.name)

          if (isAgentTool(n)) {
            const type = n.task?.subagentType ?? str(n.input.subagent_type)
            if (type) {
              const a = agentStat(s, type)
              a.launches++
              if (n.result?.isError) a.failed++
              if (n.task?.subagentType) {
                a.count++
                a.totalTokens += n.task.totalTokens ?? 0
                a.toolUses += n.task.toolUses ?? 0
                a.durationMs += n.task.agentDurationMs ?? 0
              }
            }
          } else if (n.task && !n.task.subagentType) {
            s.backgroundTasks++
          }

          walk(n.children)
          break
        }
      }
    }
  }
  walk(scopedNodes)

  // 请求按实例过滤，token 相关全部重算
  const reqs: TokenRequest[] = log.stats.requests.filter((r) => instances.has(r.instance))
  s.requests = reqs
  for (const r of reqs) {
    s.tokens.input += r.input
    s.tokens.output += r.output
    s.tokens.cacheRead += r.cacheRead
    s.tokens.cacheCreate += r.cacheCreate
    s.tokens.ctxGrowth += r.ctxDelta
    s.peakContext = Math.max(s.peakContext, r.ctxTotal)
    s.peakContextByAgent[r.agent] = Math.max(s.peakContextByAgent[r.agent] ?? 0, r.ctxTotal)
    s.counts.assistantMessages++
  }

  if (minTs && maxTs) s.wallClockMs = maxTs - minTs
  return { stats: s, scopedNodes }
}
