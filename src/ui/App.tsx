import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ParsedLog, WorkerResponse } from '../model/types'
import { fileFromDrop, hasFsAccess, onLaunchWithFile, pickFile, type Picked } from '../fs/pickers'
import { forgetFile, listRecent, rememberFile, reopen, type RecentEntry } from '../fs/handleStore'
import { ALL_KINDS, countNodes, filterTree, isFilterActive, type FilterState, type NodeKindKey } from './filter'
import { Timeline, type ExpandCtl } from './Timeline'
import { StatsPanel } from './StatsPanel'
import { Outline } from './Outline'
import { ViewerHost } from './Viewer'
import { fmtBytes, fmtMs } from './format'
import {
  applyTheme,
  loadTheme,
  NEXT_THEME,
  saveTheme,
  THEME_ICON,
  THEME_LABEL,
  watchSystem,
  type Theme,
} from './theme'

type Phase = 'idle' | 'parsing' | 'ready' | 'error'

const KIND_LABEL: Record<NodeKindKey, string> = { text: '对话', thinking: '思考', tool: '工具', system: '系统' }

export function App() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState({ bytes: 0, total: 0, lines: 0 })
  const [log, setLog] = useState<ParsedLog | null>(null)
  const [fileInfo, setFileInfo] = useState<{ name: string; size: number } | null>(null)
  const [error, setError] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [view, setView] = useState<'timeline' | 'stats'>('timeline')
  const [recent, setRecent] = useState<RecentEntry[]>([])
  const [dragging, setDragging] = useState(false)

  const [query, setQuery] = useState('')
  const [tool, setTool] = useState<string | undefined>()
  const [agent, setAgent] = useState<string | undefined>()
  const [kinds, setKinds] = useState<Set<NodeKindKey>>(new Set(ALL_KINDS))

  const [expSet, setExpSet] = useState<Set<string>>(new Set())
  const [expandAll, setExpandAll] = useState(false)
  const [theme, setTheme] = useState<Theme>(loadTheme)

  const workerRef = useRef<Worker | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const contentRef = useRef<HTMLElement | null>(null)
  const scrollPos = useRef<Record<'timeline' | 'stats', number>>({ timeline: 0, stats: 0 })
  const skipRestore = useRef(false)

  useEffect(() => {
    applyTheme(theme)
    saveTheme(theme)
    // 跟随系统时，系统切换要实时反映
    return theme === 'system' ? watchSystem(() => applyTheme('system')) : undefined
  }, [theme])

  useEffect(() => {
    void listRecent().then(setRecent)
    onLaunchWithFile((p) => void load(p))
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const load = useCallback((picked: Picked) => {
    const { file, handle } = picked
    setPhase('parsing')
    setError('')
    setLog(null)
    setExpSet(new Set())
    setExpandAll(false)
    scrollPos.current = { timeline: 0, stats: 0 }
    setFileInfo({ name: file.name, size: file.size })
    setProgress({ bytes: 0, total: file.size, lines: 0 })
    const t0 = performance.now()

    workerRef.current?.terminate()
    const w = new Worker(new URL('../worker/parse.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = w
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.kind === 'progress') setProgress({ bytes: msg.bytes, total: msg.total, lines: msg.lines })
      else if (msg.kind === 'done') {
        setElapsed(performance.now() - t0)
        setLog(msg.payload)
        setPhase('ready')
        w.terminate()
        void rememberFile(file, handle).then(() => void listRecent().then(setRecent))
      } else {
        setError(msg.message)
        setPhase('error')
        w.terminate()
      }
    }
    w.onerror = (ev) => {
      setError(ev.message || 'worker 异常')
      setPhase('error')
    }
    w.postMessage({ kind: 'parse', file })
  }, [])

  const filter: FilterState = useMemo(() => ({ query, tool, agent, kinds }), [query, tool, agent, kinds])
  const active = isFilterActive(filter)
  const roots = useMemo(() => (log ? filterTree(log.roots, filter) : []), [log, filter])
  const matched = useMemo(() => (active ? countNodes(roots) : 0), [roots, active])

  const exp: ExpandCtl = useMemo(() => {
    const base = expandAll || !!query.trim() || !!tool
    return {
      isOpen: (id) => expSet.has(id) !== base,
      toggle: (id) =>
        setExpSet((s) => {
          const n = new Set(s)
          if (n.has(id)) n.delete(id)
          else n.add(id)
          return n
        }),
    }
  }, [expSet, expandAll, query, tool])

  /**
   * 时间线和统计共用同一个滚动容器，所以切换视图时要各自记住/恢复滚动位置，
   * 否则在时间线滚到一半切到统计，统计也是滚到一半的状态。
   */
  const switchView = (next: 'timeline' | 'stats') => {
    if (next === view) return
    const el = contentRef.current
    if (el) scrollPos.current[view] = el.scrollTop
    setView(next)
  }

  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    // jumpToNode 会自己滚到目标节点，别被恢复逻辑抢走
    if (skipRestore.current) {
      skipRestore.current = false
      return
    }
    el.scrollTop = scrollPos.current[view] ?? 0
  }, [view])

  const onPickTool = (name: string) => {
    setTool((t) => (t === name ? undefined : name))
    switchView('timeline')
  }
  const onPickAgent = (name?: string) => {
    setAgent((a) => (a === name ? undefined : name))
    switchView('timeline')
  }

  const openPicker = () => void pickFile().then((p) => p && load(p))

  /**
   * 从统计面板跳到时间线某个节点。
   * 节点可能被过滤掉、或藏在折叠的子 agent 里，所以先清过滤，
   * 找不到时再打开"全部展开"重试几帧。
   */
  const jumpToNode = (nodeId?: string) => {
    if (!nodeId) return
    skipRestore.current = true
    switchView('timeline')
    setQuery('')
    setTool(undefined)
    setAgent(undefined)
    setKinds(new Set(ALL_KINDS))

    let tries = 0
    const tryScroll = () => {
      const el = document.getElementById(nodeId)
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        el.classList.add('flash')
        setTimeout(() => el.classList.remove('flash'), 900)
        return
      }
      if (tries === 1) setExpandAll(true) // 大概率藏在折叠的子 agent 里
      if (tries++ < 8) requestAnimationFrame(tryScroll)
    }
    requestAnimationFrame(tryScroll)
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    void fileFromDrop(e).then((p) => p && load(p))
  }

  return (
    <div
      class={`app ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header class="topbar">
        <div class="brand">
          <span class="logo">▤</span>
          <span>AI Log Formatter</span>
        </div>

        <button class="btn primary" onClick={openPicker}>
          打开日志
        </button>

        {fileInfo && (
          <span class="fileinfo mono">
            {fileInfo.name} <span class="dim">· {fmtBytes(fileInfo.size)}</span>
            {phase === 'ready' && <span class="dim"> · 解析 {fmtMs(elapsed)}</span>}
          </span>
        )}

        <span class="spacer" />

        {phase === 'ready' && (
          <>
            <input
              ref={searchRef}
              class="search"
              type="search"
              placeholder="搜索内容（/ 聚焦）"
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            />
            <div class="tabs">
              <button class={`tab ${view === 'timeline' ? 'active' : ''}`} onClick={() => switchView('timeline')}>
                时间线
              </button>
              <button class={`tab ${view === 'stats' ? 'active' : ''}`} onClick={() => switchView('stats')}>
                统计
              </button>
            </div>
            <button
              class="btn"
              onClick={() => {
                setExpandAll((v) => !v)
                setExpSet(new Set())
              }}
            >
              {expandAll ? '全部折叠' : '全部展开'}
            </button>
          </>
        )}

        <button
          class="btn icon"
          title={`外观：${THEME_LABEL[theme]}（点击切换到${THEME_LABEL[NEXT_THEME[theme]]}）`}
          onClick={() => setTheme((t) => NEXT_THEME[t])}
        >
          {THEME_ICON[theme]}
        </button>
      </header>

      {phase === 'ready' && log && (
        <div class="filterbar">
          {ALL_KINDS.map((k) => (
            <button
              key={k}
              class={`chip-btn ${kinds.has(k) ? 'on' : ''}`}
              onClick={() =>
                setKinds((s) => {
                  const n = new Set(s)
                  if (n.has(k)) n.delete(k)
                  else n.add(k)
                  return n.size ? n : new Set(ALL_KINDS)
                })
              }
            >
              {KIND_LABEL[k]}
            </button>
          ))}
          {tool && (
            <button class="chip-btn on removable" onClick={() => setTool(undefined)}>
              工具 = {tool} ✕
            </button>
          )}
          {agent && (
            <button class="chip-btn on removable" onClick={() => setAgent(undefined)}>
              agent = {agent === 'main' ? '主会话' : agent} ✕
            </button>
          )}
          <span class="spacer" />
          {active ? (
            <span class="dim small">命中 {matched} 个节点</span>
          ) : (
            <span class="dim small">
              {log.stats.parsed.toLocaleString()} 事件 · {log.stats.counts.toolUses} 次工具调用
            </span>
          )}
        </div>
      )}

      <div class="body">
        {phase === 'ready' && log && view === 'timeline' && (
          <aside class="sidebar">
            <Outline log={log} nodes={roots} agent={agent} onAgent={onPickAgent} />
          </aside>
        )}

        <main class="content" ref={contentRef}>
          {phase === 'idle' && <Dropzone onOpen={openPicker} recent={recent} onRecent={load} onForget={(k) => void forgetFile(k).then(() => void listRecent().then(setRecent))} />}

          {phase === 'parsing' && (
            <div class="center">
              <div class="parsing">
                <div class="bar-outer">
                  <div class="bar-inner" style={{ width: `${progress.total ? (progress.bytes / progress.total) * 100 : 0}%` }} />
                </div>
                <p class="mono">
                  解析中 {fmtBytes(progress.bytes)} / {fmtBytes(progress.total)} · {progress.lines.toLocaleString()} 行
                </p>
                <p class="dim small">在 Web Worker 里流式解析，界面不会卡住</p>
              </div>
            </div>
          )}

          {phase === 'error' && (
            <div class="center">
              <div class="err-box">
                <h2>解析失败</h2>
                <pre class="block">{error}</pre>
                <button class="btn primary" onClick={openPicker}>
                  换个文件
                </button>
              </div>
            </div>
          )}

          {phase === 'ready' && log && view === 'timeline' && (
            <>
              {roots.length === 0 ? (
                <div class="center">
                  <p class="dim">没有匹配的节点</p>
                </div>
              ) : (
                <Timeline nodes={roots} exp={exp} onFilterTool={onPickTool} />
              )}
            </>
          )}

          {phase === 'ready' && log && view === 'stats' && (
            <StatsPanel log={log} onFilterTool={onPickTool} onFilterAgent={onPickAgent} onJump={jumpToNode} />
          )}
        </main>
      </div>

      <ViewerHost />
    </div>
  )
}

function Dropzone({
  onOpen,
  recent,
  onRecent,
  onForget,
}: {
  onOpen: () => void
  recent: RecentEntry[]
  onRecent: (p: Picked) => void
  onForget: (key: string) => void
}) {
  const [msg, setMsg] = useState('')
  return (
    <div class="center">
      <div class="dropzone">
        <div class="dz-icon">▤</div>
        <h1>AI Log Formatter</h1>
        <p class="dim">
          把 <code>--output-format stream-json</code> 的日志（.log / .jsonl）拖到这里，或
        </p>
        <button class="btn primary big" onClick={onOpen}>
          选择文件
        </button>
        <p class="dim small">
          全部在本地解析，不上传任何数据。{hasFsAccess() ? '已安装为 PWA 后可完全离线使用。' : '当前浏览器不支持文件系统句柄，最近打开将不可用。'}
        </p>

        {recent.length > 0 && (
          <div class="recent">
            <div class="outline-title">最近打开</div>
            {recent.map((r) => (
              <div key={r.key} class="recent-row">
                <button
                  class="recent-btn mono"
                  onClick={() =>
                    void reopen(r).then((f) => {
                      if (f) onRecent({ file: f, handle: r.handle })
                      else setMsg(`无法重新打开 ${r.name}（文件已移动或权限被拒绝）`)
                    })
                  }
                >
                  {r.name} <span class="dim">· {fmtBytes(r.size)}</span>
                </button>
                <button class="x" title="移除" onClick={() => onForget(r.key)}>
                  ✕
                </button>
              </div>
            ))}
            {msg && <p class="warn small">{msg}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
