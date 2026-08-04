import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ParsedLog, WorkerResponse } from '../model/types'
import { dragHasFile, fileFromDrop, hasFsAccess, onLaunchWithFile, pickFile, type Picked } from '../fs/pickers'
import { forgetFile, listRecent, rememberFile, reopen, type RecentEntry } from '../fs/handleStore'
import {
  ALL_KINDS,
  countNodes,
  filterTree,
  isFilterActive,
  pathToNode,
  type FilterState,
  type NodeKindKey,
} from './filter'
import { Timeline, type ExpandCtl } from './Timeline'
import { StatsPanel } from './StatsPanel'
import { Outline } from './Outline'
import { ViewerHost } from './Viewer'
import { cancelFlash, flashElement } from './flash'
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
type AllMode = 'auto' | 'open' | 'closed'

const DEFAULT_SIDEBAR_W = 300
const SIDEBAR_KEY = 'alf.sidebarWidth'

/** 保证大纲不会窄到看不清，也不会挤掉右侧内容区 */
function clampSidebar(w: number): number {
  const max = Math.min(680, Math.max(240, window.innerWidth - 420))
  return Math.round(Math.min(max, Math.max(180, w)))
}

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
  const [allMode, setAllMode] = useState<AllMode>('auto')
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const [sidebarW, setSidebarW] = useState(() => {
    const saved = Number(localStorage.getItem(SIDEBAR_KEY))
    return clampSidebar(Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_SIDEBAR_W)
  })

  const workerRef = useRef<Worker | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const contentRef = useRef<HTMLElement | null>(null)
  const scrollPos = useRef<Record<'timeline' | 'stats', number>>({ timeline: 0, stats: 0 })
  const skipRestore = useRef(false)
  const jumpToken = useRef(0)

  useEffect(() => {
    applyTheme(theme)
    saveTheme(theme)
    // 跟随系统时，系统切换要实时反映
    return theme === 'system' ? watchSystem(() => applyTheme('system')) : undefined
  }, [theme])

  /**
   * 拖拽打开：监听挂在 window 上，不挂在根 div。
   * 只挂根 div 的话，落在它没覆盖到的区域（或模态窗口上）的 drop 会走浏览器默认行为 ——
   * Chrome 会直接导航到 file:// 打开原始日志，把应用顶掉，看起来就像不支持拖拽。
   * dragenter/dragleave 用计数器配对，否则在子元素之间移动时提示会疯狂闪烁。
   */
  useEffect(() => {
    let depth = 0

    const onEnter = (e: DragEvent) => {
      if (!dragHasFile(e)) return
      e.preventDefault()
      depth++
      setDragging(true)
    }
    const onOver = (e: DragEvent) => {
      if (!dragHasFile(e)) return
      e.preventDefault() // 不调用它 drop 事件根本不会触发
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (e: DragEvent) => {
      if (!dragHasFile(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onDrop = (e: DragEvent) => {
      // 无论是不是文件都要阻止默认行为，否则浏览器会导航走
      e.preventDefault()
      depth = 0
      setDragging(false)
      if (!dragHasFile(e)) return
      void fileFromDrop(e).then((p) => {
        if (p) load(p)
        else setError('拖入的内容里没有可读取的文件')
      })
    }

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, String(sidebarW))
  }, [sidebarW])

  useEffect(() => {
    // 窗口变窄时重新收敛，避免大纲把内容区挤没
    const onResize = () => setSidebarW((w) => clampSidebar(w))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

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
    setAllMode('auto')
    scrollPos.current = { timeline: 0, stats: 0 }
    jumpToken.current++
    cancelFlash()
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

  /**
   * 展开状态是三态的：
   *  auto   —— 各卡片用自己的默认值（对话默认开，工具/思考默认关）
   *  open   —— 用户点了"全部展开"
   *  closed —— 用户点了"全部折叠"
   * expSet 存的是"相对当前基准被手动翻转过"的节点。
   * 搜索/工具过滤时临时视作全开，否则搜到了还得一个个点开。
   */
  const exp: ExpandCtl = useMemo(() => {
    const forced: AllMode = allMode === 'auto' && (query.trim() || tool) ? 'open' : allMode
    return {
      isOpen: (id, defaultOpen = false) => {
        const base = forced === 'auto' ? defaultOpen : forced === 'open'
        return expSet.has(id) ? !base : base
      },
      toggle: (id) =>
        setExpSet((s) => {
          const n = new Set(s)
          if (n.has(id)) n.delete(id)
          else n.add(id)
          return n
        }),
    }
  }, [expSet, allMode, query, tool])

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

  /** 拖动分隔条调整大纲宽度。用 pointer capture，指针滑出分隔条也不会丢事件 */
  const startResize = (e: PointerEvent) => {
    e.preventDefault()
    const bar = e.currentTarget as HTMLElement
    const startX = e.clientX
    const startW = sidebarW
    bar.setPointerCapture(e.pointerId)
    document.body.classList.add('resizing')

    const onMove = (ev: PointerEvent) => setSidebarW(clampSidebar(startW + ev.clientX - startX))
    const onUp = () => {
      document.body.classList.remove('resizing')
      bar.removeEventListener('pointermove', onMove)
      bar.removeEventListener('pointerup', onUp)
      bar.removeEventListener('pointercancel', onUp)
    }
    bar.addEventListener('pointermove', onMove)
    bar.addEventListener('pointerup', onUp)
    bar.addEventListener('pointercancel', onUp)
  }

  /**
   * 从统计面板跳到时间线某个节点。
   *
   * 三个坑：
   *  1. 节点可能被过滤掉 —— 先清掉所有过滤条件
   *  2. 节点可能藏在折叠的子 agent 里 —— 只展开它的祖先链，不要"全部展开"
   *     （全部展开会把 200+ 条子 agent 记录一次性铺开，还会跟 expSet 的
   *      异或语义打架，把本来该开的卡片关掉）
   *  3. 卡片带 content-visibility，屏外高度是估算值。滚动过程中真实高度陆续
   *     测出来，布局会往下挪 —— 所以用瞬时滚动，并在随后几帧持续校正，
   *     用平滑滚动的话动画途中布局一变，落点就飘了
   */
  const jumpToNode = (nodeId?: string) => {
    if (!nodeId || !log) return
    skipRestore.current = true
    switchView('timeline')
    setQuery('')
    setTool(undefined)
    setAgent(undefined)
    setKinds(new Set(ALL_KINDS))

    const path = pathToNode(log.roots, nodeId)
    if (!path) return
    setAllMode('auto')
    setExpSet(new Set(path))

    // 上一次跳转的校正循环可能还在跑，会和这次抢滚动位置，用令牌作废掉
    const token = ++jumpToken.current
    let tries = 0
    let flashed = false
    const settle = () => {
      if (token !== jumpToken.current) return
      const host = contentRef.current
      const el = document.getElementById(nodeId)
      if (host && el) {
        const offset = el.getBoundingClientRect().top - host.getBoundingClientRect().top - host.clientHeight / 3
        if (Math.abs(offset) > 2) host.scrollTop += offset
        if (!flashed) {
          flashed = true
          flashElement(el)
        }
      }
      // 找到之后再校正几帧，等 content-visibility 把真实高度补齐
      if (tries++ < (flashed ? 6 : 15)) requestAnimationFrame(settle)
    }
    requestAnimationFrame(settle)
  }

  return (
    <div class={`app ${dragging ? 'dragging' : ''}`}>
      <header class="topbar">
        <div class="brand">
          <span class="logo">▤</span>
          <span>AI Log Formatter</span>
        </div>

        {/* 首屏中间已经有选择文件和最近打开了，顶栏再放一个是重复的 */}
        {phase !== 'idle' && (
          <OpenMenu
            recent={recent}
            onPickFile={openPicker}
            onRecent={load}
            onForget={(k) => void forgetFile(k).then(() => void listRecent().then(setRecent))}
          />
        )}

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
                setAllMode((m) => (m === 'open' ? 'closed' : 'open'))
                setExpSet(new Set())
              }}
            >
              {allMode === 'open' ? '全部折叠' : '全部展开'}
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
          <>
            <aside class="sidebar" style={{ flexBasis: `${sidebarW}px`, width: `${sidebarW}px` }}>
              <Outline log={log} nodes={roots} agent={agent} onAgent={onPickAgent} />
            </aside>
            <div
              class="splitter"
              title="拖动调整宽度，双击复位"
              onPointerDown={startResize}
              onDblClick={() => setSidebarW(DEFAULT_SIDEBAR_W)}
            />
          </>
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

/** 顶栏「打开日志」：先给最近打开的列表，再给「从本地打开…」，少一次文件选择框 */
function OpenMenu({
  recent,
  onPickFile,
  onRecent,
  onForget,
}: {
  recent: RecentEntry[]
  onPickFile: () => void
  onRecent: (p: Picked) => void
  onForget: (key: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const close = () => {
    setOpen(false)
    setMsg('')
  }

  return (
    <div class="menu-wrap">
      <button class="btn primary" onClick={() => (open ? close() : setOpen(true))}>
        打开日志 <span class="caret-down">▾</span>
      </button>

      {open && (
        <>
          {/* 点击任意处关闭；放在菜单之前，菜单的 z-index 更高 */}
          <div class="menu-backdrop" onClick={close} />
          <div class="menu">
            <button
              class="menu-item primary-item"
              onClick={() => {
                close()
                onPickFile()
              }}
            >
              从本地打开…
            </button>

            <div class="menu-sep">最近打开</div>
            {recent.length === 0 ? (
              <div class="menu-empty dim small">还没有记录</div>
            ) : (
              recent.map((r) => (
                <div key={r.key} class="menu-row">
                  <button
                    class="menu-item mono"
                    title={`${r.name} · ${fmtBytes(r.size)}`}
                    onClick={() =>
                      void reopen(r).then((f) => {
                        if (f) {
                          close()
                          onRecent({ file: f, handle: r.handle })
                        } else {
                          setMsg(`无法重新打开 ${r.name}（文件已移动或权限被拒绝）`)
                        }
                      })
                    }
                  >
                    <span class="mi-name">{r.name}</span>
                    <span class="dim mi-size">{fmtBytes(r.size)}</span>
                  </button>
                  <button class="x" title="从列表移除" onClick={() => onForget(r.key)}>
                    ✕
                  </button>
                </div>
              ))
            )}
            {msg && <p class="warn small menu-msg">{msg}</p>}
          </div>
        </>
      )}
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
