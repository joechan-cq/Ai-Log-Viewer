import type { LogNode, ParsedLog } from '../model/types'
import { fmtNum } from './format'

const ICON: Record<string, string> = { text: '💬', thinking: '💭', tool: '⚙', system: '·' }

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
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el?.classList.add('flash')
    setTimeout(() => el?.classList.remove('flash'), 900)
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
              <span class="dim"> ×{a.count} · {fmtNum(a.totalTokens)}tok</span>
            </button>
          ))}
        </div>
      )}

      <div class="outline-sec">
        <div class="outline-title">主时间线 · {nodes.length} 条</div>
        <ul class="jump">
          {nodes.map((n) => (
            <li key={n.id} class={`jl jl-${n.kind}`} onClick={() => jump(n.id)} title={summary(n)}>
              <span class="ic">{ICON[n.kind]}</span>
              <span class="tx">{summary(n)}</span>
              {n.kind === 'tool' && n.children.length > 0 && <span class="badge">{n.children.length}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
