import { useMemo, useState } from 'preact/hooks'
import type { ParsedLog, Stats, ToolStat } from '../model/types'
import { listScopes, SCOPE_ALL, statsForScope } from '../model/scope'
import { durTone, fmtBytes, fmtDateTime, fmtMs, fmtNum } from './format'

type SortKey = 'count' | 'name' | 'totalMs' | 'avgMs' | 'ctxAdded'

interface Props {
  log: ParsedLog
  onFilterTool: (name: string) => void
  onFilterAgent: (agent: string) => void
  onJump: (nodeId?: string) => void
  scope: string
  onScope: (key: string) => void
}

export function StatsPanel({ log, onFilterTool, onFilterAgent, onJump, scope, onScope }: Props) {
  const { session } = log
  const [sort, setSort] = useState<SortKey>('count')

  const scopes = useMemo(() => listScopes(log), [log])
  const stats = useMemo(() => statsForScope(log, scope).stats, [log, scope])
  const isAll = scope === SCOPE_ALL

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
        <div class="panel-head">
          <h2>统计范围</h2>
          <span class="dim small">选中某次 Agent 调用即只统计它（含其嵌套子 agent）</span>
        </div>
        <div class="scope-bar">
          {scopes.map((sc) => (
            <button
              key={sc.key}
              class={`chip-btn ${scope === sc.key ? 'on' : ''}`}
              title={sc.sub ? `${sc.label} · ${sc.sub}` : sc.label}
              onClick={() => onScope(sc.key)}
            >
              {sc.label}
              {sc.sub && <span class="dim"> · {sc.sub}</span>}
            </button>
          ))}
        </div>
      </section>

      <section class="panel">
        <h2>概览</h2>
        <div class="tiles">
          {isAll ? (
            <>
              <Tile label="文件大小" value={fmtBytes(stats.bytes)} sub={`${stats.lines.toLocaleString()} 行`} />
              <Tile
                label="解析事件"
                value={stats.parsed.toLocaleString()}
                sub={stats.parseErrors ? `${stats.parseErrors} 行解析失败` : '全部成功'}
                tone={stats.parseErrors ? 'warn' : undefined}
              />
            </>
          ) : (
            <Tile label="消息数" value={stats.counts.assistantMessages.toLocaleString()} sub="该范围内的 API 请求" />
          )}
          <Tile label="工具调用" value={totalCalls.toLocaleString()} sub={`${tools.length} 种工具`} />
          <Tile
            label={isAll ? '会话时长' : '该范围时长'}
            value={fmtMs(stats.wallClockMs)}
            sub={isAll ? fmtDateTime(session.startedAt) : '首末事件时间差'}
          />
          <Tile label="峰值上下文" value={fmtNum(stats.peakContext)} sub={`${stats.requests.length} 次 API 请求`} />
          <Tile
            label="上下文增长"
            value={fmtNum(stats.tokens.ctxGrowth)}
            sub={`缓存读取 ${fmtNum(stats.tokens.cacheRead)}`}
          />
        </div>
        {isAll && (
          <div class="kv-row wrap">
            <Meta k="model" v={session.model} />
            <Meta k="version" v={session.version} />
            <Meta k="cwd" v={session.cwd} />
            <Meta k="permissionMode" v={session.permissionMode} />
            <Meta k="session_id" v={session.sessionId} />
            <Meta k="可用工具" v={session.tools.length ? String(session.tools.length) : undefined} />
            <Meta k="MCP" v={session.mcpServers.map((m) => `${m.name}(${m.status ?? '?'})`).join(', ') || undefined} />
          </div>
        )}
      </section>

      <TokenPanel stats={stats} onJump={onJump} />

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
                <td class={`num dur-${durTone(t.avgMs || undefined)}`}>{t.avgMs ? fmtMs(t.avgMs) : '—'}</td>
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
        {/* 事件类型分布来自原始行，只有全局口径 */}
        {isAll && (
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
        )}

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
function TokenPanel({ stats, onJump }: { stats: Stats; onJump: (nodeId?: string) => void }) {
  const [topN, setTopN] = useState(15)

  const ranked = useMemo(() => [...stats.requests].sort((a, b) => b.ctxDelta - a.ctxDelta), [stats.requests])
  if (ranked.length === 0) return null

  const maxDelta = Math.max(1, ranked[0].ctxDelta)
  const totalGrowth = Math.max(1, stats.tokens.ctxGrowth)

  return (
    <section class="panel">
      <div class="panel-head">
        <h2>Token 消耗 · 最贵的步骤</h2>
        <span class="dim small">按上下文增量排序，点行跳到造成它的那一步</span>
      </div>

      <div class="tiles">
        <Tile label="上下文增长合计" value={fmtNum(stats.tokens.ctxGrowth)} sub="真正进入过上下文的 token" />
        <Tile label="峰值上下文" value={fmtNum(stats.peakContext)} sub="单次请求的最大上下文" />
        <Tile
          label="缓存写入合计"
          value={fmtNum(stats.tokens.cacheCreate)}
          sub="含缓存失效后的重写，会大于实际增长"
        />
        <Tile label="缓存读取合计" value={fmtNum(stats.tokens.cacheRead)} sub="每次请求重读的上下文累计" />
        <Tile label="API 请求数" value={ranked.length.toLocaleString()} sub="已按 message.id 去重" />
      </div>

      <table class="tbl">
        <thead>
          <tr>
            <th class="num">行号</th>
            <th>agent</th>
            <th>是哪一步塞进来的</th>
            <th class="num">上下文增量</th>
            <th class="num">占比</th>
            <th class="num">之后的上下文</th>
            <th class="num">缓存写入</th>
          </tr>
        </thead>
        <tbody>
          {ranked.slice(0, topN).map((r) => {
            const initial = r.causeNodeId == null && r.causeLineNo == null
            return (
              <tr
                key={r.messageId}
                class={r.causeNodeId ? 'clickable' : 'no-anchor'}
                onClick={() => onJump(r.causeNodeId)}
                title={
                  r.causeNodeId
                    ? '跳到造成这段增量的那一步'
                    : initial
                      ? '该 agent 实例的初始上下文，没有对应的时间线节点'
                      : '造成增量的那一步没有产出可见内容，无法定位'
                }
              >
                <td class="num dim">{r.causeLineNo ?? '—'}</td>
                <td>
                  <span class={r.agent === 'main' ? 'dim' : 'agent-tag'}>{r.agent === 'main' ? '主会话' : r.agent}</span>
                </td>
                <td class="mono step-label">
                  <span class="bar" style={{ width: `${(r.ctxDelta / maxDelta) * 100}%` }} />
                  <span class="rel">{r.causeLabel}</span>
                </td>
                <td class="num strong">+{r.ctxDelta.toLocaleString()}</td>
                <td class="num dim">{((r.ctxDelta / totalGrowth) * 100).toFixed(1)}%</td>
                <td class="num dim">{fmtNum(r.ctxTotal)}</td>
                <td class={`num ${r.cacheCreate > r.ctxDelta * 2 + 1000 ? 'warn' : 'dim'}`}>
                  {fmtNum(r.cacheCreate)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {topN < ranked.length && (
        <button class="more" onClick={() => setTopN((n) => n + 30)}>
          还有 {ranked.length - topN} 条，展开更多
        </button>
      )}

      <p class="dim small note">
        上下文增量 = 该次请求的上下文总量减去<b>同一 agent 实例</b>上一次请求的总量。按实例算是必须的 ——
        同一种 agent 可能被启动多次，每个实例的上下文都从零开始。增量归因到<b>上一步</b>，因为多出来的
        token 是上一步的结果塞进来的；每个实例的第一次请求没有上一步，记作初始上下文。
        <br />
        <b>不要用 <code>cache_creation_input_tokens</code> 当增量</b>：缓存前缀失效时会整段重写，
        它会暴涨而上下文其实没怎么长（实测有一条 cacheCreate 报 190,636，真实增量只有 1,796）。
        「缓存写入」列明显高于增量时会标黄，那就是发生了缓存重写。
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
