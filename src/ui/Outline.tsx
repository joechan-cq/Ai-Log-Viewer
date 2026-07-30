import type { LogNode, ParsedLog } from '../model/types'
import { fmtNum } from './format'
import { flashElement } from './flash'

const ICON: Record<string, string> = { text: '💬', thinking: '💭', tool: '⚙', system: '·' }

/** 工具各给一个好认的记号，子 agent 单独区分出来（大纲里最需要一眼找到的就是它） */
const TOOL_ICON: Record<string, string> = {
  Agent: '◆',
  Task: '◆',
  Bash: '$',
  Read: '▤',
  Write: '✎',
  Edit: '✎',
  Skill: '✦',
}

function iconFor(n: LogNode): string {
  if (n.kind === 'tool') return TOOL_ICON[n.name] ?? (n.name.startsWith('mcp__') ? '⧉' : ICON.tool)
  return ICON[n.kind]
}

function isSubAgent(n: LogNode): boolean {
  return n.kind === 'tool' && (n.name === 'Agent' || n.name === 'Task')
}

function summary(n: LogNode): string {
  switch (n.kind) {
    case 'text':
      return (n.role === 'user' ? '用户：' : '') + oneLine(n.text, 70)
    case 'thinking':
      return oneLine(n.text, 70)
    case 'tool':
      return `${n.name}  ${oneLine(n.label, 52)}`
    case 'system':
      return n.title
  }
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

export function Outline({
  log,
  nodes,
  agent,
  onAgent,
}: {
  log: ParsedLog
  nodes: LogNode[]
  agent?: string
  onAgent: (a?: string) => void
}) {
  const agents = Object.entries(log.stats.agents).sort((a, b) => b[1].count - a[1].count)

  const jump = (id: string) => {
    const el = document.getElementById(id)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    flashElement(el)
  }

  return (
    <div class="outline">
      {agents.length > 0 && (
        <div class="outline-sec">
          <div class="outline-title">Agent</div>
          <button class={`agent-btn ${!agent ? 'active' : ''}`} onClick={() => onAgent(undefined)}>
            全部
          </button>
          <button class={`agent-btn ${agent === 'main' ? 'active' : ''}`} onClick={() => onAgent('main')}>
            主会话
          </button>
          {agents.map(([name, a]) => (
            <button key={name} class={`agent-btn ${agent === name ? 'active' : ''}`} onClick={() => onAgent(name)}>
              {name}
              {/* 显示调用次数而不是启动成功次数，否则和过滤后的条目数对不上 */}
              <span class="dim"> ×{a.launches || a.count} · {fmtNum(a.totalTokens)}tok</span>
              {a.failed > 0 && <span class="err"> {a.failed} 失败</span>}
            </button>
          ))}
        </div>
      )}

      <div class="outline-sec">
        <div class="outline-title">主时间线 · {nodes.length} 条</div>
        <ul class="jump">
          {nodes.map((n) => (
            <li
              key={n.id}
              class={`jl jl-${n.kind} ${isSubAgent(n) ? 'is-agent' : ''}`}
              onClick={() => jump(n.id)}
              title={summary(n)}
            >
              <span class="ic">{iconFor(n)}</span>
              <span class="tx">{summary(n)}</span>
              {n.kind === 'tool' && n.children.length > 0 && <span class="badge">{n.children.length}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
