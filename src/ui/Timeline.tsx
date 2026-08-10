import { Fragment, type JSX } from 'preact'
import type { ImageRef, LogNode, SystemNode, TextNode, ThinkingNode, ToolNode } from '../model/types'
import { escapeHtml, highlight, langForPath, renderMarkdown } from './markdown'
import { durTone, fmtMs, fmtNum, fmtTime, gapTone } from './format'
import { openViewer } from './Viewer'

/** 卡片里最多预览这么多字符；超出的部分不在原地展开，一律走模态全文查看器 */
const PREVIEW_LIMIT = 2000

export interface ExpandCtl {
  /** defaultOpen 用于对话这类默认展开的卡片；"全部展开/折叠"会覆盖它 */
  isOpen(id: string, defaultOpen?: boolean): boolean
  toggle(id: string): void
}

/** 小于这个间隔不显示 —— 几秒的间隙是正常流水，只标出真正卡住的地方 */
const MIN_GAP_MS = 10_000

interface TimelineProps {
  nodes: LogNode[]
  exp: ExpandCtl
  depth?: number
  onFilterTool?: (name: string) => void
  /** 在相邻卡片之间标出时间间隔（大致就是 LLM 的思考时长） */
  showGaps?: boolean
  /** 点 Agent 卡片上的「统计」：把统计面板切到该 agent 实例 */
  onScopeStats?: (toolUseId: string) => void
}

export function Timeline({ nodes, exp, depth = 0, onFilterTool, showGaps, onScopeStats }: TimelineProps) {
  return (
    <div class={`timeline ${showGaps ? 'with-gaps' : ''}`} data-depth={depth}>
      {nodes.map((n, i) => (
        <Fragment key={n.id}>
          {showGaps && i > 0 && <Gap prev={nodes[i - 1]} next={n} />}
          <NodeView
            node={n}
            exp={exp}
            depth={depth}
            onFilterTool={onFilterTool}
            showGaps={showGaps}
            onScopeStats={onScopeStats}
          />
        </Fragment>
      ))}
    </div>
  )
}

/**
 * 相邻两张卡片之间的时间跨度：两个时间戳之差，
 * 也就是卡片上显示的两个时刻之间隔了多久（含上一步自身的执行耗时）。
 */
function Gap({ prev, next }: { prev: LogNode; next: LogNode }) {
  const from = prev.ts
  const to = next.ts
  if (!from || !to) return null
  const ms = to - from
  if (ms < MIN_GAP_MS) return null
  const tone = gapTone(ms)
  const ran =
    prev.kind === 'tool' && prev.durationMs ? `，其中上一步自身执行 ${fmtMs(prev.durationMs)}` : ''
  return (
    <div
      class={`gap gap-${tone}`}
      title={`跨度 ${fmtMs(ms)}：${fmtTime(from)} → ${fmtTime(to)}${ran}`}
    >
      <span class="gap-mark">
        <span class="gap-bracket" />
        <span class={`gap-label dur-${tone}`}>{fmtMs(ms)}</span>
      </span>
    </div>
  )
}

function NodeView({
  node,
  exp,
  depth,
  onFilterTool,
  showGaps,
  onScopeStats,
}: {
  node: LogNode
  exp: ExpandCtl
  depth: number
  onFilterTool?: (name: string) => void
  showGaps?: boolean
  onScopeStats?: (toolUseId: string) => void
}) {
  switch (node.kind) {
    case 'text':
      return <TextCard node={node} exp={exp} />
    case 'thinking':
      return <ThinkingCard node={node} exp={exp} />
    case 'tool':
      return (
        <ToolCard
          node={node}
          exp={exp}
          depth={depth}
          onFilterTool={onFilterTool}
          showGaps={showGaps}
          onScopeStats={onScopeStats}
        />
      )
    case 'system':
      return <SystemCard node={node} exp={exp} />
  }
}

/* ---------- 文本 / 思考 ---------- */

function TextCard({ node, exp }: { node: TextNode; exp: ExpandCtl }) {
  const me = node.role === 'user'
  const title = me ? '用户输入' : 'AI 回复'
  // 对话是主内容，默认展开
  const open = exp.isOpen(node.id, true)
  return (
    <section id={node.id} class={`node card ${me ? 'card-user' : 'card-assistant'}`}>
      <header class="card-head clickable" onClick={() => exp.toggle(node.id)}>
        <Caret open={open} />
        <span class={`role ${me ? 'role-user' : 'role-assistant'}`}>{me ? '用户' : 'AI'}</span>
        {node.agent && <span class="chip chip-agent">{node.agent}</span>}
        {!open && <span class="label dim">{oneLine(node.text, 120)}</span>}
        <span class="spacer" />
        {!open && <span class="metric">{node.text.length.toLocaleString()} 字符</span>}
        <span class="ts">{fmtTime(node.ts)}</span>
      </header>
      {open && (
        <>
          <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(clamp(node.text)) }} />
          <MoreButton text={node.text} title={title} markdown />
        </>
      )}
    </section>
  )
}

function ThinkingCard({ node, exp }: { node: ThinkingNode; exp: ExpandCtl }) {
  const open = exp.isOpen(node.id)
  return (
    <section id={node.id} class="node card card-thinking">
      <header class="card-head clickable" onClick={() => exp.toggle(node.id)}>
        <Caret open={open} />
        <span class="role role-thinking">思考</span>
        {node.agent && <span class="chip chip-agent">{node.agent}</span>}
        <span class="label dim">{open ? '' : oneLine(node.text, 120)}</span>
        <span class="spacer" />
        <span class="ts">{fmtTime(node.ts)}</span>
      </header>
      {open && <TextBlock text={node.text} title="思考过程" />}
    </section>
  )
}

/* ---------- 系统事件 ---------- */

function SystemCard({ node, exp }: { node: SystemNode; exp: ExpandCtl }) {
  const open = exp.isOpen(node.id)
  return (
    <section id={node.id} class="node sys">
      <div class="card-head clickable" onClick={() => exp.toggle(node.id)}>
        <Caret open={open} />
        <span class="chip chip-sys">{node.subtype}</span>
        <span class="label">{node.title}</span>
        <span class="spacer" />
        <span class="ts">{fmtTime(node.ts)}</span>
      </div>
      {open && <JsonBlock value={node.event} title={`${node.subtype} 事件`} />}
    </section>
  )
}

/* ---------- 工具调用 ---------- */

const TOOL_CLASS: Record<string, string> = {
  Bash: 'tool-bash',
  Read: 'tool-read',
  Write: 'tool-write',
  Edit: 'tool-write',
  Agent: 'tool-agent',
  Task: 'tool-agent',
  Skill: 'tool-skill',
}

function ToolCard({
  node,
  exp,
  depth,
  onFilterTool,
  showGaps,
  onScopeStats,
}: {
  node: ToolNode
  exp: ExpandCtl
  depth: number
  onFilterTool?: (name: string) => void
  showGaps?: boolean
  onScopeStats?: (toolUseId: string) => void
}) {
  const open = exp.isOpen(node.id)
  const err = node.result?.isError
  const task = node.task
  const imgCount = node.result?.images.length ?? 0
  const isAgent = node.name === 'Agent' || node.name === 'Task'
  const cls = TOOL_CLASS[node.name] ?? (node.name.startsWith('mcp__') ? 'tool-mcp' : 'tool-generic')

  return (
    <section id={node.id} class={`node card card-tool ${cls} ${err ? 'is-error' : ''}`}>
      <header class="card-head clickable" onClick={() => exp.toggle(node.id)}>
        <Caret open={open} />
        <span
          class="tool-name"
          title="只看这个工具"
          onClick={(e) => {
            e.stopPropagation()
            onFilterTool?.(node.name)
          }}
        >
          {node.name}
        </span>
        {node.agent && <span class="chip chip-agent">{node.agent}</span>}
        <span class="label mono">{node.label}</span>
        <span class="spacer" />
        {task?.status && <span class={`chip chip-status st-${task.status}`}>{task.status}</span>}
        {err && <span class="chip chip-err">error</span>}
        {isAgent && onScopeStats && (
          <button
            class="mini-btn"
            title="只统计这次 Agent 调用的数据"
            onClick={(e) => {
              e.stopPropagation()
              onScopeStats(node.toolUseId)
            }}
          >
            统计
          </button>
        )}
        {imgCount > 0 && (
          <span class="chip chip-img" title={`结果包含 ${imgCount} 张图片`}>
            <ImageIcon />
            {imgCount > 1 && imgCount}
          </span>
        )}
        {node.ctxAdded ? (
          <span class="chip chip-ctx" title={`这一步给上下文新增约 ${Math.round(node.ctxAdded).toLocaleString()} tokens`}>
            +{fmtNum(Math.round(node.ctxAdded))}
          </span>
        ) : null}
        {task?.totalTokens ? <span class="metric">{fmtNum(task.totalTokens)} tok</span> : null}
        <Duration ms={node.durationMs ?? task?.agentDurationMs} />
        <span class="ts">{fmtTime(node.ts)}</span>
      </header>

      {open && (
        <div class="card-body">
          <ToolBody node={node} />

          {task && <TaskPanel task={task} />}

          {node.children.length > 0 && (
            <details class="subagent" open>
              <summary>
                子 agent 时间线 · {task?.subagentType ?? node.agent ?? 'agent'} · {node.children.length} 条
              </summary>
              <Timeline
                nodes={node.children}
                exp={exp}
                depth={depth + 1}
                onFilterTool={onFilterTool}
                showGaps={showGaps}
              />
            </details>
          )}

          {node.rawJson ? (
            <button class="more" onClick={() => openViewer({ title: `原始 JSON · 第 ${node.lineNo} 行`, text: pretty(node.rawJson!), lang: 'json' })}>
              查看原始 JSON
            </button>
          ) : (
            <p class="dim small">该行过大，未保留原始 JSON（第 {node.lineNo} 行）</p>
          )}
        </div>
      )}
    </section>
  )
}

function TaskPanel({ task }: { task: NonNullable<ToolNode['task']> }) {
  const isAgent = !!task.subagentType
  return (
    <div class="task-panel">
      <div class="kv-row">
        <Kv k="task_id" v={task.taskId} />
        {task.taskType && <Kv k="类型" v={task.taskType} />}
        {task.subagentType && <Kv k="agent" v={task.subagentType} />}
        {task.toolUses != null && <Kv k="工具调用" v={String(task.toolUses)} />}
        {task.totalTokens != null && <Kv k="tokens" v={fmtNum(task.totalTokens)} />}
        {task.agentDurationMs != null && <Kv k="agent 耗时" v={fmtMs(task.agentDurationMs)} />}
        <Kv k="progress 事件" v={String(task.progressCount)} />
      </div>
      {task.prompt && (
        <button class="more" onClick={() => openViewer({ title: '子 agent prompt', text: task.prompt!, markdown: true })}>
          查看子 agent prompt（{task.prompt.length.toLocaleString()} 字符）
        </button>
      )}
      {task.summary && (
        <div class="summary">
          <div class="sub-title">{isAgent ? '子 agent 返回' : '任务输出'}</div>
          <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(clamp(task.summary)) }} />
          <MoreButton text={task.summary} title={isAgent ? '子 agent 返回' : '任务输出'} markdown />
        </div>
      )}
      {task.outputFile && <div class="dim mono small">output: {task.outputFile}</div>}
    </div>
  )
}

/** 按工具类型定制渲染，未知工具走通用 JSON */
function ToolBody({ node }: { node: ToolNode }) {
  const inp = node.input
  const res = node.result
  const structured = res?.structured

  switch (node.name) {
    case 'Bash': {
      const stdout = str(structured?.stdout)
      const stderr = str(structured?.stderr)
      const interrupted = structured?.interrupted === true
      return (
        <>
          {str(inp.description) && <div class="dim small">{str(inp.description)}</div>}
          <pre class="shell">
            <code
              dangerouslySetInnerHTML={{
                __html: `<span class="prompt">$</span> ${highlight(String(inp.command ?? ''), 'bash')}`,
              }}
            />
          </pre>
          {interrupted && <div class="chip chip-err">interrupted</div>}
          {stdout || stderr ? (
            <>
              {stdout && <OutBlock title="stdout" text={stdout} />}
              {stderr && <OutBlock title="stderr" text={stderr} tone="err" />}
              <ImageGrid images={res?.images ?? []} />
            </>
          ) : (
            <ResultBlock res={res} />
          )}
        </>
      )
    }

    case 'Read': {
      const path = str(inp.file_path)
      return (
        <>
          <div class="path mono">{path}</div>
          <ResultBlock res={res} lang={langForPath(path)} title={path?.split('/').pop()} />
        </>
      )
    }

    case 'Write': {
      const path = str(inp.file_path)
      return (
        <>
          <div class="path mono">{path}</div>
          <OutBlock title="写入内容" text={String(inp.content ?? '')} lang={langForPath(path)} />
          <ResultBlock res={res} compact />
        </>
      )
    }

    case 'Edit': {
      const path = str(inp.file_path)
      return (
        <>
          <div class="path mono">{path}</div>
          <DiffBlock oldText={String(inp.old_string ?? '')} newText={String(inp.new_string ?? '')} />
          <ResultBlock res={res} compact />
        </>
      )
    }

    case 'Skill':
      return (
        <>
          <div class="kv-row">
            <Kv k="skill" v={String(inp.skill ?? '')} />
            {inp.args ? <Kv k="args" v={String(inp.args)} /> : null}
          </div>
          <ResultBlock res={res} />
        </>
      )

    case 'Agent':
    case 'Task':
      return (
        <>
          <div class="kv-row">
            {str(inp.subagent_type) && <Kv k="subagent_type" v={str(inp.subagent_type)!} />}
            {str(inp.description) && <Kv k="描述" v={str(inp.description)!} />}
            {str(inp.model) && <Kv k="model" v={str(inp.model)!} />}
          </div>
          {str(inp.prompt) && (
            <button class="more" onClick={() => openViewer({ title: 'Agent prompt', text: str(inp.prompt)!, markdown: true })}>
              查看 prompt（{str(inp.prompt)!.length.toLocaleString()} 字符）
            </button>
          )}
          <ResultBlock res={res} compact />
        </>
      )

    default:
      return (
        <>
          <JsonBlock value={inp} title="入参" />
          <ResultBlock res={res} />
        </>
      )
  }
}

/* ---------- 基础块 ---------- */

function ResultBlock({
  res,
  lang,
  title,
  compact,
}: {
  res?: ToolNode['result']
  lang?: string
  title?: string
  /** 结果不重要时（Write/Edit/Agent 的确认信息）只给一行摘要 */
  compact?: boolean
}) {
  if (!res) return <div class="dim small">（无结果 —— 日志可能被截断）</div>
  const hasText = res.text.trim().length > 0
  if (!hasText && res.images.length === 0) return <div class="dim small">（结果为空）</div>

  const label = res.isError ? '错误' : '结果'
  if (compact) {
    return (
      <>
        <div class="compact-res">
          <span class="sub-title">{label}</span>
          <span class={`mono ${res.isError ? 'err' : 'dim'}`}>{oneLine(res.text, 90)}</span>
          {res.text.length > 90 && (
            <button class="more inline" onClick={() => openViewer({ title: title ?? label, text: res.text, lang })}>
              查看全文
            </button>
          )}
        </div>
        <ImageGrid images={res.images} />
      </>
    )
  }

  return (
    <>
      {hasText && (
        <OutBlock title={title ? `${label} · ${title}` : label} text={res.text} lang={lang} tone={res.isError ? 'err' : undefined} />
      )}
      <ImageGrid images={res.images} />
    </>
  )
}

function OutBlock({ title, text, lang, tone }: { title: string; text: string; lang?: string; tone?: 'err' }) {
  return (
    <div class="out">
      <div class="sub-title">
        {title} <span class="dim">· {text.length.toLocaleString()} 字符</span>
      </div>
      <TextBlock text={text} lang={lang} tone={tone} title={title} />
    </div>
  )
}

/** 只渲染前 PREVIEW_LIMIT 个字符，剩下的交给模态查看器 */
function TextBlock({ text, lang, tone, title }: { text: string; lang?: string; tone?: 'err'; title: string }) {
  const long = text.length > PREVIEW_LIMIT
  const shown = long ? text.slice(0, PREVIEW_LIMIT) : text
  const html = lang ? highlight(shown, lang) : escapeHtml(shown)
  return (
    <>
      <pre class={`block ${tone === 'err' ? 'block-err' : ''} ${long ? 'is-clipped' : ''}`}>
        <code class="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
      {/* md 内容即使很短也给入口，否则没法看渲染效果 */}
      <MoreButton text={text} title={title} lang={lang} always={lang === 'markdown'} />
    </>
  )
}

/**
 * 统一的"查看全文"入口 —— 不在当前 UI 里原地展开。
 * always=true 时即使内容没被截断也显示按钮（md 需要一个入口去看渲染效果）。
 */
function MoreButton({
  text,
  title,
  lang,
  markdown,
  always,
}: {
  text: string
  title: string
  lang?: string
  markdown?: boolean
  always?: boolean
}) {
  const long = text.length > PREVIEW_LIMIT
  if (!long && !always) return null
  // .md 文件（Read 的结果、Write 的内容）在全文查看器里默认渲染，可切回原文
  const asMd = markdown ?? lang === 'markdown'
  return (
    <button class="more" onClick={() => openViewer({ title, text, lang, markdown: asMd })}>
      {long
        ? `查看全文（共 ${text.length.toLocaleString()} 字符，还有 ${(text.length - PREVIEW_LIMIT).toLocaleString()}）`
        : asMd
          ? '渲染 Markdown'
          : '在大窗口查看'}
    </button>
  )
}

function JsonBlock({ value, title }: { value: unknown; title: string }) {
  let s: string
  try {
    s = JSON.stringify(value, null, 2)
  } catch {
    s = String(value)
  }
  return (
    <div class="out">
      <div class="sub-title">{title}</div>
      <TextBlock text={s} lang="json" title={title} />
    </div>
  )
}

/** 截图类工具会返回 base64 图片，缩略图展示，点击放大 */
function ImageGrid({ images }: { images: ImageRef[] }) {
  if (!images.length) return null
  return (
    <div class="out">
      <div class="sub-title">图片 · {images.length} 张</div>
      <div class="imgs">
        {images.map((img, i) => (
          <img
            key={i}
            class="thumb"
            src={`data:${img.mediaType};base64,${img.data}`}
            loading="lazy"
            title={`${img.mediaType} · ${Math.round((img.data.length * 3) / 4 / 1024)} KB · 点击查看大图`}
            onClick={() =>
              openViewer({
                title: images.length > 1 ? `截图 ${i + 1}/${images.length}` : '截图',
                images: { list: images, index: i },
              })
            }
          />
        ))}
      </div>
    </div>
  )
}

/** Edit 的极简 diff：整块删除 + 整块新增，够看清改了什么 */
function DiffBlock({ oldText, newText }: { oldText: string; newText: string }) {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  return (
    <div class="diff">
      {oldLines.map((l, i) => (
        <div key={`o${i}`} class="dl del">
          <span class="sign">-</span>
          <span class="txt">{l || ' '}</span>
        </div>
      ))}
      {newLines.map((l, i) => (
        <div key={`n${i}`} class="dl add">
          <span class="sign">+</span>
          <span class="txt">{l || ' '}</span>
        </div>
      ))}
    </div>
  )
}

/** 耗时按数量级分色，越慢越暖；最慢那档还会加粗，不只靠颜色区分 */
function Duration({ ms }: { ms?: number }) {
  const tone = durTone(ms)
  return <span class={`metric dur-${tone}`}>{fmtMs(ms)}</span>
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <span class="kv">
      <span class="k">{k}</span>
      <span class="v mono">{v}</span>
    </span>
  )
}

/** 折叠状态下也能一眼看出这次调用带了截图 */
function ImageIcon(): JSX.Element {
  return (
    <svg class="ic-img" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <rect x="1.2" y="2.4" width="13.6" height="11.2" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4" />
      <circle cx="5.6" cy="6.3" r="1.3" fill="currentColor" />
      <path d="M2.2 12.4l3.5-3.4 2.4 2.3 2.6-2.9 3.1 4z" fill="currentColor" />
    </svg>
  )
}

function Caret({ open }: { open: boolean }): JSX.Element {
  return <span class={`caret ${open ? 'open' : ''}`}>▸</span>
}

/* ---------- 工具函数 ---------- */

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function clamp(s: string): string {
  return s.length > PREVIEW_LIMIT ? s.slice(0, PREVIEW_LIMIT) : s
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}
