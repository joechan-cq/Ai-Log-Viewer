import { useMemo, useState } from 'preact/hooks'
import type { ParsedLog, ToolStat } from '../model/types'
import { fmtBytes, fmtDateTime, fmtMs, fmtNum } from './format'

type SortKey = 'count' | 'name' | 'totalMs' | 'avgMs' | 'ctxAdded'

interface Props {
  log: ParsedLog
  onFilterTool: (name: string) => void
  onFilterAgent: (agent: string) => void
  onJump: (nodeId?: string) => void
}

export function StatsPanel({ log, onFilterTool, onFilterAgent, onJump }: Props) {
  const { stats, session } = log
  const [sort, setSort] = useState<SortKey>('count')

  const tools = useMemo(() => {
    const rows = Object.entries(stats.toolCalls).map(([name, s]) => ({
      name,
      ...s,
      avgMs: s.count ? s.totalMs / s.count : 0,
    }))
    rows.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      return (b[sort] as number) - (a[sort] as number)
    })
    return rows
  }, [stats, sort])

  const maxCount = Math.max(1, ...tools.map((t) => t.count))
  const totalCalls = tools.reduce((n, t) => n + t.count, 0)

  return (
    <div class="stats">
      <section class="panel">
        <h2>概览</h2>
        <div class="tiles">
          <Tile label="文件大小" value={fmtBytes(stats.bytes)} sub={`${stats.lines.toLocaleString()} 行`} />
          <Tile
            label="解析事件"
            value={stats.parsed.toLocaleString()}
            sub={stats.parseErrors ? `${stats.parseErrors} 行解析失败` : '全部成功'}
            tone={stats.parseErrors ? 'warn' : undefined}
          />
          <Tile label="工具调用" value={totalCalls.toLocaleString()} sub={`${tools.length} 种工具`} />
          <Tile label="会话时长" value={fmtMs(stats.wallClockMs)} sub={fmtDateTime(session.startedAt)} />
          <Tile label="峰值上下文" value={fmtNum(stats.peakContext)} sub={`${stats.requests.length} 次 API 请求`} />
          <Tile
            label="上下文写入"
            value={fmtNum(stats.tokens.cacheCreate)}
            sub={`缓存读取 ${fmtNum(stats.tokens.cacheRead)}`}
          />
        </div>
        <div class="kv-row wrap">
          <Meta k="model" v={session.model} />
          <Meta k="version" v={session.version} />
          <Meta k="cwd" v={session.cwd} />
          <Meta k="permissionMode" v={session.permissionMode} />
          <Meta k="session_id" v={session.sessionId} />
          <Meta k="可用工具" v={session.tools.length ? String(session.tools.length) : undefined} />
          <Meta k="MCP" v={session.mcpServers.map((m) => `${m.name}(${m.status ?? '?'})`).join(', ') || undefined} />
        </div>
      </section>

      <TokenPanel log={log} onJump={onJump} />

      <section class="panel">
        <div class="panel-head">
          <h2>工具调用次数</h2>
          <div class="sorts">
            <span class="dim small">排序：</span>
            {(
              [
                ['count', '次数'],
                ['ctxAdded', '上下文增量'],
                ['totalMs', '总耗时'],
                ['avgMs', '平均耗时'],
                ['name', '名称'],
              ] as [SortKey, string][]
            ).map(([k, label]) => (
              <button key={k} class={`tab small ${sort === k ? 'active' : ''}`} onClick={() => setSort(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <table class="tbl">
          <thead>
            <tr>
              <th>工具</th>
              <th class="num">次数</th>
              <th class="num">占比</th>
              <th class="num">成功</th>
              <th class="num">失败</th>
              <th class="num">上下文增量</th>
              <th class="num">总耗时</th>
              <th class="num">平均</th>
              <th>调用方</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <tr key={t.name} class="clickable" onClick={() => onFilterTool(t.name)} title="点击只看该工具的调用">
                <td>
                  <span class="bar" style={{ width: `${(t.count / maxCount) * 100}%` }} />
                  <span class="tool-name">{t.name}</span>
                </td>
                <td class="num strong">{t.count}</td>
                <td class="num dim">{((t.count / totalCalls) * 100).toFixed(1)}%</td>
                <td class="num">{t.ok || '—'}</td>
                <td class={`num ${t.error ? 'err' : 'dim'}`}>{t.error || '—'}</td>
                <td class="num">{t.ctxAdded ? `+${fmtNum(Math.round(t.ctxAdded))}` : '—'}</td>
                <td class="num">{t.totalMs ? fmtMs(t.totalMs) : '—'}</td>
                <td class="num">{t.avgMs ? fmtMs(t.avgMs) : '—'}</td>
                <td class="agents">{agentsLabel(t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div class="cols">
        <CountPanel
          title="Skill 调用次数"
          empty="日志中没有 Skill 调用"
          data={stats.skillCalls}
          prefix="/"
          onPick={() => onFilterTool('Skill')}
        />
        <CountPanel title="MCP 工具调用" empty="没有 MCP 调用" data={stats.mcpCalls} onPick={onFilterTool} />
        <CountPanel title="Slash 命令（用户输入）" empty="没有 slash 命令" data={stats.slashCommands} prefix="/" />
      </div>

      <section class="panel">
        <h2>子 Agent</h2>
        {Object.keys(stats.agents).length === 0 ? (
          <p class="dim">没有子 agent</p>
        ) : (
          <table class="tbl">
            <thead>
              <tr>
                <th>subagent_type</th>
                <th class="num">调用</th>
                <th class="num">启动成功</th>
                <th class="num">失败</th>
                <th class="num">工具调用</th>
                <th class="num">tokens</th>
                <th class="num">峰值上下文</th>
                <th class="num">耗时</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(stats.agents)
                .sort((a, b) => b[1].count - a[1].count)
                .map(([name, a]) => (
                  <tr key={name} class="clickable" onClick={() => onFilterAgent(name)} title="点击只看该 agent 的事件">
                    <td class="tool-name">{name}</td>
                    <td class="num strong">{a.launches || a.count}</td>
                    <td class="num">{a.count}</td>
                    <td class={`num ${a.failed ? 'err' : 'dim'}`}>{a.failed || '—'}</td>
                    <td class="num">{a.toolUses || '—'}</td>
                    <td class="num">{fmtNum(a.totalTokens)}</td>
                    <td class="num">{fmtNum(stats.peakContextByAgent[name])}</td>
                    <td class="num">{fmtMs(a.durationMs)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </section>

      <div class="cols">
        <section class="panel">
          <h2>事件类型分布</h2>
          <table class="tbl compact">
            <tbody>
              {Object.entries(stats.byEventType)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <tr key={k}>
                    <td class="mono">{k}</td>
                    <td class="num strong">{v}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>

        <section class="panel">
          <h2>消息构成</h2>
          <table class="tbl compact">
            <tbody>
              <CountRow k="assistant 消息" v={stats.counts.assistantMessages} />
              <CountRow k="文本块" v={stats.counts.textBlocks} />
              <CountRow k="思考块" v={stats.counts.thinkingBlocks} />
              <CountRow k="└ 内容已剥离（不渲染）" v={stats.counts.emptyThinkingBlocks} />
              <CountRow k="tool_use" v={stats.counts.toolUses} />
              <CountRow k="tool_result" v={stats.counts.toolResults} />
              <CountRow k="用户消息" v={stats.counts.userMessages} />
              <CountRow k="hook 触发" v={stats.counts.hooks} />
              <CountRow k="后台任务 (local_bash)" v={stats.backgroundTasks} />
              <CountRow k="返回图片（截图）" v={stats.counts.images} />
            </tbody>
          </table>
          {stats.counts.toolUses !== stats.counts.toolResults && (
            <p class="warn small">
              tool_use / tool_result 数量不等（{stats.counts.toolUses} vs {stats.counts.toolResults}），日志可能被截断或有中断的调用。
            </p>
          )}
        </section>
      </div>

      {stats.rateLimits.length > 0 && (
        <section class="panel">
          <h2>速率限制事件（{stats.rateLimits.length}）</h2>
          <pre class="block">
            <code>{JSON.stringify(stats.rateLimits, null, 2)}</code>
          </pre>
        </section>
      )}
    </div>
  )
}

/**
 * Token 面板。
 * 关键点：cache_creation_input_tokens 精确等于该次请求相对上一次的上下文增量，
 * 所以它就是「这一步多贵」；而 output_tokens 是 message_start 快照，严重偏低，只做参考。
 */
function TokenPanel({ log, onJump }: { log: ParsedLog; onJump: (nodeId?: string) => void }) {
  const { stats } = log
  const [topN, setTopN] = useState(15)

  const ranked = useMemo(
    () => [...stats.requests].sort((a, b) => b.cacheCreate - a.cacheCreate),
    [stats.requests],
  )
  if (ranked.length === 0) return null

  const maxCreate = Math.max(1, ranked[0].cacheCreate)
  const totalCreate = stats.tokens.cacheCreate

  return (
    <section class="panel">
      <div class="panel-head">
        <h2>Token 消耗 · 最贵的步骤</h2>
        <span class="dim small">按上下文增量排序，点行跳到时间线</span>
      </div>

      <div class="tiles">
        <Tile label="上下文写入合计" value={fmtNum(totalCreate)} sub="新进入上下文的 token" />
        <Tile label="缓存读取合计" value={fmtNum(stats.tokens.cacheRead)} sub="每次请求重读的上下文累计" />
        <Tile label="峰值上下文" value={fmtNum(stats.peakContext)} sub="单次请求的最大上下文" />
        <Tile label="API 请求数" value={ranked.length.toLocaleString()} sub="已按 message.id 去重" />
      </div>

      <table class="tbl">
        <thead>
          <tr>
            <th class="num">行号</th>
            <th>agent</th>
            <th>这一步做了什么</th>
            <th class="num">上下文增量</th>
            <th class="num">占比</th>
            <th class="num">当时上下文</th>
          </tr>
        </thead>
        <tbody>
          {ranked.slice(0, topN).map((r) => (
            <tr
              key={r.messageId}
              class={r.nodeId ? 'clickable' : 'no-anchor'}
              onClick={() => onJump(r.nodeId)}
              title={r.nodeId ? '跳到时间线对应位置' : '这次请求没有产出可见内容（思考正文已被日志剥离），无法定位'}
            >
              <td class="num dim">{r.lineNo}</td>
              <td>
                <span class={r.agent === 'main' ? 'dim' : 'agent-tag'}>{r.agent === 'main' ? '主会话' : r.agent}</span>
              </td>
              <td class="mono step-label">
                <span class="bar" style={{ width: `${(r.cacheCreate / maxCreate) * 100}%` }} />
                <span class="rel">{r.label}</span>
              </td>
              <td class="num strong">+{r.cacheCreate.toLocaleString()}</td>
              <td class="num dim">{((r.cacheCreate / totalCreate) * 100).toFixed(1)}%</td>
              <td class="num dim">{fmtNum(r.ctxTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {topN < ranked.length && (
        <button class="more" onClick={() => setTopN((n) => n + 30)}>
          还有 {ranked.length - topN} 条，展开更多
        </button>
      )}

      <p class="dim small note">
        上下文增量取自 <code>cache_creation_input_tokens</code>，等于该次请求相对上一次多出来的上下文，是精确值。
        每个 agent 的第一次请求（system prompt / skill 指令）没有前序步骤，会以「thinking」或首个动作的名义出现在榜上。
        <br />
        日志里的 <code>output_tokens</code> 是 message_start 时的快照（一个 5,900 字符的 Write 调用只报 3），
        不能当输出量用，因此这里不展示。
      </p>
    </section>
  )
}

function agentsLabel(t: ToolStat): string {
  return Object.entries(t.byAgent)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k === 'main' ? '主会话' : k} ${v}`)
    .join(' · ')
}

function CountPanel({
  title,
  data,
  empty,
  prefix = '',
  onPick,
}: {
  title: string
  data: Record<string, number>
  empty: string
  prefix?: string
  onPick?: (k: string) => void
}) {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1])
  return (
    <section class="panel">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p class="dim">{empty}</p>
      ) : (
        <table class="tbl compact">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} class={onPick ? 'clickable' : ''} onClick={() => onPick?.(k)}>
                <td class="mono">
                  {prefix}
                  {k}
                </td>
                <td class="num strong">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function CountRow({ k, v }: { k: string; v: number }) {
  return (
    <tr>
      <td>{k}</td>
      <td class="num strong">{v}</td>
    </tr>
  )
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' }) {
  return (
    <div class={`tile ${tone ?? ''}`}>
      <div class="tile-label">{label}</div>
      <div class="tile-value">{value}</div>
      {sub && <div class="tile-sub">{sub}</div>}
    </div>
  )
}

function Meta({ k, v }: { k: string; v?: string }) {
  if (!v) return null
  return (
    <span class="kv">
      <span class="k">{k}</span>
      <span class="v mono">{v}</span>
    </span>
  )
}
