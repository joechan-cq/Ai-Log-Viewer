import type {
  AgentStat,
  ImageRef,
  LogNode,
  ParsedLog,
  RawEvent,
  SessionMeta,
  Stats,
  TokenRequest,
  ToolNode,
  ToolResult,
  ToolStat,
} from './types'

/** 超过这个大小的原始行不保留 JSON 文本（避免内存翻倍），"查看原始"会提示已省略 */
const RAW_KEEP_LIMIT = 32 * 1024

export const MAIN_AGENT = 'main'

/** 这些 system 事件靠 tool_use_id 关联，允许延迟解析 */
const TASK_SUBTYPES = new Set(['task_started', 'task_progress', 'task_notification'])

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

function emptySession(): SessionMeta {
  return { tools: [], mcpServers: [], plugins: [], skills: [], slashCommands: [] }
}

function bump<T extends string>(rec: Record<T, number>, key: T) {
  rec[key] = (rec[key] ?? 0) + 1
}

function toolStat(stats: Stats, name: string): ToolStat {
  return (stats.toolCalls[name] ??= { count: 0, ok: 0, error: 0, totalMs: 0, ctxAdded: 0, byAgent: {} })
}

function agentStat(stats: Stats, name: string): AgentStat {
  return (stats.agents[name] ??= { count: 0, launches: 0, failed: 0, totalTokens: 0, toolUses: 0, durationMs: 0 })
}

function parseTs(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : t
  }
  return undefined
}

function firstLine(s: string, max = 140): string {
  const idx = s.indexOf('\n')
  const head = idx === -1 ? s : s.slice(0, idx) + ' …'
  return head.length > max ? head.slice(0, max) + '…' : head
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** 一行摘要，决定折叠状态下时间线的可读性 */
export function labelForTool(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => str(input[k])
  switch (name) {
    case 'Bash':
      return firstLine(s('command') ?? s('description') ?? '')
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return s('file_path') ?? s('notebook_path') ?? ''
    case 'Grep':
      return `${s('pattern') ?? ''}${input.path ? `  in ${s('path')}` : ''}`
    case 'Glob':
      return s('pattern') ?? ''
    case 'Agent':
    case 'Task': {
      const at = s('subagent_type')
      const d = s('description') ?? firstLine(s('prompt') ?? '')
      return at ? `${at} · ${d}` : d
    }
    case 'Skill':
      return `/${s('skill') ?? '?'}${input.args ? ` ${firstLine(String(input.args), 60)}` : ''}`
    case 'ToolSearch':
      return s('query') ?? ''
    case 'WebFetch':
    case 'WebSearch':
      return s('url') ?? s('query') ?? ''
    case 'TodoWrite':
      return Array.isArray(input.todos) ? `${input.todos.length} 项` : ''
    default: {
      if (name.startsWith('mcp__')) {
        const keys = Object.keys(input)
        return keys.length ? firstLine(`${keys[0]}=${JSON.stringify(input[keys[0]])}`, 100) : ''
      }
      const j = JSON.stringify(input)
      return j === '{}' ? '' : firstLine(j, 120)
    }
  }
}

/** 一次请求产出了什么 —— 用于 token 排行里指认「哪一步」 */
function labelForMessage(content: unknown): string {
  if (typeof content === 'string') return firstLine(content, 90)
  if (!Array.isArray(content)) return '(无内容)'
  const blocks = content as Record<string, unknown>[]
  const tool = blocks.find((b) => b.type === 'tool_use')
  if (tool) {
    const name = String(tool.name ?? 'unknown')
    const label = labelForTool(name, (tool.input ?? {}) as Record<string, unknown>)
    const extra = blocks.filter((b) => b.type === 'tool_use').length - 1
    return `${name} ${label}${extra > 0 ? ` (+${extra} 个并行调用)` : ''}`
  }
  const text = blocks.find((b) => b.type === 'text')
  if (text) return firstLine(String(text.text ?? ''), 90)
  return blocks.map((b) => String(b.type)).join(', ') || '(无内容)'
}

/** tool_result 的 content 可能是字符串，也可能是 block 数组（含 base64 图片） */
function extractResult(content: unknown): { text: string; images: ImageRef[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  if (content == null) return { text: '', images: [] }
  if (!Array.isArray(content)) return { text: JSON.stringify(content, null, 2), images: [] }

  const parts: string[] = []
  const images: ImageRef[] = []
  for (const b of content) {
    if (typeof b === 'string') {
      parts.push(b)
      continue
    }
    const blk = b as Record<string, unknown>
    if (blk.type === 'text') {
      parts.push(String(blk.text ?? ''))
    } else if (blk.type === 'image') {
      const src = blk.source as Record<string, unknown> | undefined
      const data = str(src?.data)
      if (data) images.push({ mediaType: str(src?.media_type) ?? 'image/png', data })
      else parts.push('[image: 无 base64 数据]')
    } else {
      parts.push(JSON.stringify(blk))
    }
  }
  return { text: parts.join('\n'), images }
}

/**
 * 增量规范化器。逐行喂原始事件，最后 finish() 得到会话树。
 *
 * 关键关联：
 *  - tool_use_id  → 把 tool_use / tool_result / system.task_* 合并成一个 ToolNode
 *  - parent_tool_use_id → 把子 agent 的事件挂到父 Agent 工具调用下面
 *  - task_id      → task_updated 只带 task_id，需要单独索引
 */
export class Normalizer {
  private session = emptySession()
  private stats = emptyStats()
  /** bucket key: MAIN_AGENT 或 父 tool_use_id */
  private buckets = new Map<string, LogNode[]>()
  private toolByUseId = new Map<string, ToolNode>()
  private toolByTaskId = new Map<string, ToolNode>()
  /** task_* 事件可能早于它引用的 tool_use 出现，先挂起，等 tool_use 到了再回放 */
  private pendingByUseId = new Map<string, { raw: RawEvent; base: NodeBaseFields; bucketKey: string }[]>()
  private seenTasks = new Set<string>()
  /** 一个 API 响应会拆成多条 assistant 事件，usage 只能按 message.id 记一次 */
  private seenMessageIds = new Set<string>()
  /** agent 实例（parent_tool_use_id）→ 等待下一次请求的增量来做归因的工具节点 */
  private pendingAttrib = new Map<string, ToolNode[]>()
  /** agent 实例 → 上一次请求，用来算上下文增量并归因到上一步 */
  private lastRequestByInstance = new Map<string, TokenRequest>()
  /** message.id → 请求记录，用于把跳转锚点绑到该消息真正产出的第一个节点 */
  private requestByMessageId = new Map<string, TokenRequest>()
  private seq = 0

  private bucket(key: string): LogNode[] {
    let b = this.buckets.get(key)
    if (!b) this.buckets.set(key, (b = []))
    return b
  }

  private nextId(): string {
    return `n${this.seq++}`
  }

  countLine(byteLen: number) {
    this.stats.lines++
    this.stats.bytes += byteLen
  }

  countParseError() {
    this.stats.parseErrors++
  }

  push(raw: RawEvent, lineNo: number, rawText: string) {
    this.stats.parsed++
    const type = raw.type ?? 'unknown'
    const key = raw.subtype ? `${type}/${raw.subtype}` : type
    bump(this.stats.byEventType, key)

    const ts = parseTs(raw.timestamp)
    if (ts) {
      this.session.startedAt = Math.min(this.session.startedAt ?? ts, ts)
      this.session.endedAt = Math.max(this.session.endedAt ?? ts, ts)
    }

    const parent = typeof raw.parent_tool_use_id === 'string' ? raw.parent_tool_use_id : null
    const agent = parent ? (raw.subagent_type ?? 'agent') : undefined
    const bucketKey = parent ?? MAIN_AGENT
    const rawJson = rawText.length <= RAW_KEEP_LIMIT ? rawText : undefined
    const base = { lineNo, ts, agent, rawJson }

    switch (type) {
      case 'assistant':
        this.onAssistant(raw, base, bucketKey)
        return
      case 'user':
        this.onUser(raw, base, bucketKey)
        return
      case 'system':
        this.onSystem(raw, base, bucketKey)
        return
      case 'rate_limit_event':
        this.stats.rateLimits.push(raw.rate_limit_info)
        this.bucket(bucketKey).push({
          ...base,
          id: this.nextId(),
          kind: 'system',
          subtype: 'rate_limit_event',
          title: `速率限制 · ${(raw.rate_limit_info as Record<string, unknown> | undefined)?.rateLimitType ?? ''}`,
          event: raw,
        })
        return
      case 'result':
        this.bucket(bucketKey).push({
          ...base,
          id: this.nextId(),
          kind: 'system',
          subtype: 'result',
          title: `会话结束 · ${raw.subtype ?? ''}`,
          event: raw,
        })
        return
      default:
        // 未知事件类型必须优雅降级，不能丢
        this.bucket(bucketKey).push({
          ...base,
          id: this.nextId(),
          kind: 'system',
          subtype: key,
          title: key,
          event: raw,
        })
    }
  }

  private onAssistant(raw: RawEvent, base: NodeBaseFields, bucketKey: string) {
    const msg = (raw.message ?? {}) as Record<string, unknown>
    this.stats.counts.assistantMessages++

    const content = msg.content
    const agentKey = base.agent ?? MAIN_AGENT

    // 同一个 API 响应会被拆成多条 assistant 事件（226 个 message.id / 279 条事件），
    // usage 在每条上重复出现，必须按 message.id 去重才不会重复计数。
    const messageId = str(msg.id)
    let request: TokenRequest | undefined
    if (messageId && !this.seenMessageIds.has(messageId)) {
      this.seenMessageIds.add(messageId)
      const usage = (msg.usage ?? {}) as Record<string, unknown>
      const input = Number(usage.input_tokens ?? 0)
      const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0)
      const cacheRead = Number(usage.cache_read_input_tokens ?? 0)
      const output = Number(usage.output_tokens ?? 0)

      const t = this.stats.tokens
      t.input += input
      t.output += output
      t.cacheRead += cacheRead
      t.cacheCreate += cacheCreate

      const ctxTotal = input + cacheCreate + cacheRead
      this.stats.peakContext = Math.max(this.stats.peakContext, ctxTotal)
      this.stats.peakContextByAgent[agentKey] = Math.max(this.stats.peakContextByAgent[agentKey] ?? 0, ctxTotal)

      /*
       * 上下文增量按「agent 实例」算，键用 bucketKey（parent_tool_use_id），
       * 不能用 subagent_type：同一种 agent 会被启动多次，每个实例的上下文都是
       * 从零开始的，按类型分组会把"新实例启动"误判成"上下文被压缩"（实测出现 5 次负增量，
       * 换成实例键后为 0，且增量总和与各实例峰值之和完全相等）。
       */
      const prev = this.lastRequestByInstance.get(bucketKey)
      const ctxDelta = Math.max(0, ctxTotal - (prev?.ctxTotal ?? 0))

      // 归因：这段增量是上一轮那些工具调用的结果塞进来的
      const pending = this.pendingAttrib.get(bucketKey)
      if (pending?.length && ctxDelta > 0) {
        const each = ctxDelta / pending.length
        for (const tool of pending) tool.ctxAdded = (tool.ctxAdded ?? 0) + each
      }
      this.pendingAttrib.set(bucketKey, [])

      t.ctxGrowth += ctxDelta

      request = {
        messageId,
        lineNo: base.lineNo,
        agent: agentKey,
        instance: bucketKey,
        label: labelForMessage(content),
        input,
        cacheCreate,
        cacheRead,
        output,
        ctxTotal,
        ctxDelta,
        causeLabel: prev ? prev.label : agentKey === MAIN_AGENT ? '会话初始上下文（system prompt 等）' : '子 agent 初始上下文（agent prompt 等）',
        causeNodeId: prev?.nodeId,
        causeLineNo: prev?.lineNo,
      }
      this.stats.requests.push(request)
      this.requestByMessageId.set(messageId, request)
      this.lastRequestByInstance.set(bucketKey, request)
    }

    /**
     * 统计面板跳转时间线的锚点 = 这条消息产出的第一个节点。
     * 不能用「预测下一个自增 id」的做法：一条消息可能拆成多条事件，
     * 也可能只含被剥离的空思考块、什么节点都不产生，
     * 预测出来的 id 会被后面别的消息拿走，跳转就跳错人了。
     */
    const req = messageId ? this.requestByMessageId.get(messageId) : undefined
    const anchor = (id: string) => {
      if (req && !req.nodeId) req.nodeId = id
    }

    if (typeof content === 'string') {
      if (content.trim()) {
        this.stats.counts.textBlocks++
        const id = this.nextId()
        anchor(id)
        this.bucket(bucketKey).push({ ...base, id, kind: 'text', role: 'assistant', text: content })
      }
      return
    }
    if (!Array.isArray(content)) return

    for (const b of content as Record<string, unknown>[]) {
      switch (b.type) {
        case 'text': {
          const text = String(b.text ?? '')
          if (!text.trim()) break
          this.stats.counts.textBlocks++
          const id = this.nextId()
          anchor(id)
          this.bucket(bucketKey).push({ ...base, id, kind: 'text', role: 'assistant', text })
          break
        }
        case 'thinking': {
          const text = String(b.thinking ?? b.text ?? '')
          this.stats.counts.thinkingBlocks++
          // stream-json 通常只保留 signature、剥掉思考正文；空的思考块渲染出来就是一排空卡片
          if (text.trim()) {
            const id = this.nextId()
            anchor(id)
            this.bucket(bucketKey).push({ ...base, id, kind: 'thinking', text })
          } else {
            this.stats.counts.emptyThinkingBlocks++
          }
          break
        }
        case 'tool_use': {
          const name = String(b.name ?? 'unknown')
          const input = (b.input ?? {}) as Record<string, unknown>
          const toolUseId = String(b.id ?? this.nextId())
          this.stats.counts.toolUses++

          const st = toolStat(this.stats, name)
          st.count++
          bump(st.byAgent, base.agent ?? MAIN_AGENT)

          if (name === 'Skill') {
            const sk = str(input.skill)
            if (sk) bump(this.stats.skillCalls, sk)
          }
          if (name.startsWith('mcp__')) bump(this.stats.mcpCalls, name)

          const nodeId = this.nextId()
          anchor(nodeId)
          const node: ToolNode = {
            ...base,
            id: nodeId,
            kind: 'tool',
            toolUseId,
            name,
            input,
            label: labelForTool(name, input),
            children: [],
          }
          this.toolByUseId.set(toolUseId, node)
          this.bucket(bucketKey).push(node)
          // 等下一次请求的上下文增量来给它归因（按 agent 实例，不是按类型）
          const attrib = this.pendingAttrib.get(bucketKey)
          if (attrib) attrib.push(node)
          else this.pendingAttrib.set(bucketKey, [node])
          this.drainPending(toolUseId)
          break
        }
        default:
          this.bucket(bucketKey).push({
            ...base,
            id: this.nextId(),
            kind: 'system',
            subtype: `assistant/${String(b.type)}`,
            title: `未知内容块 ${String(b.type)}`,
            event: b as RawEvent,
          })
      }
    }
  }

  private onUser(raw: RawEvent, base: NodeBaseFields, bucketKey: string) {
    const msg = (raw.message ?? {}) as Record<string, unknown>
    const content = msg.content
    const structured = raw.tool_use_result as Record<string, unknown> | undefined

    if (typeof content === 'string') {
      this.stats.counts.userMessages++
      this.recordSlash(content)
      this.bucket(bucketKey).push({ ...base, id: this.nextId(), kind: 'text', role: 'user', text: content })
      return
    }
    if (!Array.isArray(content)) return

    for (const b of content as Record<string, unknown>[]) {
      if (b.type === 'tool_result') {
        this.stats.counts.toolResults++
        const useId = String(b.tool_use_id ?? '')
        const isError = b.is_error === true
        const { text, images } = extractResult(b.content)
        this.stats.counts.images += images.length
        const result: ToolResult = {
          isError,
          text,
          images,
          structured: structured && typeof structured === 'object' ? structured : undefined,
        }
        const tool = this.toolByUseId.get(useId)
        if (tool) {
          tool.result = result
          tool.resultTs = base.ts
          if (tool.ts && base.ts) tool.durationMs = base.ts - tool.ts
          const st = toolStat(this.stats, tool.name)
          if (isError) st.error++
          else st.ok++
          if (tool.durationMs) st.totalMs += tool.durationMs
        } else {
          // 找不到配对（日志被截断 / 乱序），单独成卡而不是丢弃
          this.bucket(bucketKey).push({
            ...base,
            id: this.nextId(),
            kind: 'system',
            subtype: 'orphan_tool_result',
            title: `孤立 tool_result ${useId.slice(0, 12)}`,
            event: b as RawEvent,
          })
        }
      } else if (b.type === 'text') {
        const text = String(b.text ?? '')
        this.stats.counts.userMessages++
        this.recordSlash(text)
        this.bucket(bucketKey).push({ ...base, id: this.nextId(), kind: 'text', role: 'user', text })
      } else {
        this.bucket(bucketKey).push({
          ...base,
          id: this.nextId(),
          kind: 'system',
          subtype: `user/${String(b.type)}`,
          title: `未知内容块 ${String(b.type)}`,
          event: b as RawEvent,
        })
      }
    }
  }

  private recordSlash(text: string) {
    const m = /^\s*\/([A-Za-z0-9_:-]+)/.exec(text)
    if (m) bump(this.stats.slashCommands, m[1])
  }

  private drainPending(toolUseId: string) {
    const queue = this.pendingByUseId.get(toolUseId)
    if (!queue) return
    this.pendingByUseId.delete(toolUseId)
    for (const item of queue) this.onSystem(item.raw, item.base, item.bucketKey)
  }

  private onSystem(raw: RawEvent, base: NodeBaseFields, bucketKey: string) {
    const sub = raw.subtype ?? 'unknown'
    const useId = str(raw.tool_use_id)
    const taskId = str(raw.task_id)
    const tool = useId ? this.toolByUseId.get(useId) : undefined

    // 引用了尚未出现的 tool_use（日志里 task_started 常常抢跑一行）→ 挂起等回放
    if (useId && !tool && TASK_SUBTYPES.has(sub)) {
      const q = this.pendingByUseId.get(useId)
      if (q) q.push({ raw, base, bucketKey })
      else this.pendingByUseId.set(useId, [{ raw, base, bucketKey }])
      return
    }

    switch (sub) {
      case 'init': {
        const s = this.session
        s.sessionId = str(raw.session_id)
        s.model = str(raw.model)
        s.cwd = str(raw.cwd)
        s.version = str(raw.claude_code_version)
        s.permissionMode = str(raw.permissionMode)
        s.outputStyle = str(raw.output_style)
        s.tools = Array.isArray(raw.tools) ? (raw.tools as string[]) : []
        s.mcpServers = Array.isArray(raw.mcp_servers) ? (raw.mcp_servers as SessionMeta['mcpServers']) : []
        s.plugins = Array.isArray(raw.plugins) ? (raw.plugins as unknown[]) : []
        s.skills = Array.isArray(raw.skills) ? (raw.skills as unknown[]) : []
        s.slashCommands = Array.isArray(raw.slash_commands) ? (raw.slash_commands as string[]) : []
        this.bucket(bucketKey).push({
          ...base,
          id: this.nextId(),
          kind: 'system',
          subtype: sub,
          title: `会话开始 · ${s.model ?? ''}`,
          event: raw,
        })
        return
      }

      case 'task_started': {
        if (tool && taskId) {
          // task_type=local_agent → 真子 agent（tool 是 Agent 调用）
          // task_type=local_bash → 后台 Bash（tool 是 Bash 调用，没有 subagent_type）
          const subagentType = str(raw.subagent_type)
          const prev = tool.task
          tool.task = {
            ...(prev ?? { progressCount: 0 }),
            taskId,
            taskType: str(raw.task_type),
            subagentType,
            description: str(raw.description),
            prompt: str(raw.prompt),
          }
          this.toolByTaskId.set(taskId, tool)
          if (!this.seenTasks.has(taskId)) {
            this.seenTasks.add(taskId)
            if (subagentType) agentStat(this.stats, subagentType).count++
            else this.stats.backgroundTasks++
          }
        }
        return
      }

      case 'task_progress': {
        const t = tool ?? (taskId ? this.toolByTaskId.get(taskId) : undefined)
        const usage = raw.usage as Record<string, unknown> | undefined
        if (t) {
          const task = (t.task ??= { taskId: taskId ?? '', progressCount: 0 })
          task.progressCount++
          task.lastToolName = str(raw.last_tool_name) ?? task.lastToolName
          if (usage) {
            // task_progress 的 usage 是累计值，取最后一次
            task.totalTokens = Number(usage.total_tokens ?? task.totalTokens ?? 0)
            task.toolUses = Number(usage.tool_uses ?? task.toolUses ?? 0)
            task.agentDurationMs = Number(usage.duration_ms ?? task.agentDurationMs ?? 0)
          }
        }
        return
      }

      case 'task_notification': {
        const t = tool ?? (taskId ? this.toolByTaskId.get(taskId) : undefined)
        if (t) {
          const task = (t.task ??= { taskId: taskId ?? '', progressCount: 0 })
          task.status = str(raw.status) ?? task.status
          task.summary = str(raw.summary) ?? task.summary
          task.outputFile = str(raw.output_file) ?? task.outputFile
        }
        return
      }

      case 'task_updated': {
        const t = taskId ? this.toolByTaskId.get(taskId) : undefined
        const patch = raw.patch as Record<string, unknown> | undefined
        if (t?.task && patch) {
          if (typeof patch.status === 'string') t.task.status = patch.status
        }
        return
      }

      case 'thinking_tokens': {
        this.stats.thinkingTokens = Math.max(this.stats.thinkingTokens, Number(raw.estimated_tokens ?? 0))
        return
      }

      case 'hook_started':
        this.stats.counts.hooks++
        return

      case 'hook_response': {
        this.bucket(bucketKey).push({
          ...base,
          id: this.nextId(),
          kind: 'system',
          subtype: sub,
          title: `Hook ${str(raw.hook_name) ?? ''} → ${str(raw.outcome) ?? ''}`,
          event: raw,
        })
        return
      }

      default: {
        this.bucket(bucketKey).push({
          ...base,
          id: this.nextId(),
          kind: 'system',
          subtype: sub,
          title: `system/${sub}`,
          event: raw,
        })
      }
    }
  }

  finish(): ParsedLog {
    // 把子 agent 的 bucket 挂到对应的 Agent 工具节点下
    for (const [key, nodes] of this.buckets) {
      if (key === MAIN_AGENT) continue
      const tool = this.toolByUseId.get(key)
      if (tool) tool.children = nodes
      else this.bucket(MAIN_AGENT).push(...nodes) // 找不到父调用时不丢，落到主时间线
    }

    for (const tool of this.toolByUseId.values()) {
      if (tool.ctxAdded) toolStat(this.stats, tool.name).ctxAdded += tool.ctxAdded
    }

    // 调用次数与失败数：启动失败的 agent 没有 task_started，只能从工具调用侧统计。
    // 少了这一步，侧栏显示 "claude ×3" 而时间线里有 4 张卡片，对不上。
    for (const tool of this.toolByUseId.values()) {
      if (tool.name !== 'Agent' && tool.name !== 'Task') continue
      const at = tool.task?.subagentType ?? str(tool.input.subagent_type)
      if (!at) continue
      const a = agentStat(this.stats, at)
      a.launches++
      if (tool.result?.isError) a.failed++
    }

    // 子 agent 的 token / 耗时汇总（后台 Bash 任务不算 agent）
    for (const tool of this.toolByUseId.values()) {
      const task = tool.task
      if (!task?.subagentType) continue
      const a = agentStat(this.stats, task.subagentType)
      a.totalTokens += task.totalTokens ?? 0
      a.toolUses += task.toolUses ?? 0
      a.durationMs += task.agentDurationMs ?? 0
    }

    const s = this.session
    if (s.startedAt && s.endedAt) this.stats.wallClockMs = s.endedAt - s.startedAt

    return { session: s, roots: this.buckets.get(MAIN_AGENT) ?? [], stats: this.stats }
  }
}

type NodeBaseFields = {
  lineNo: number
  ts?: number
  agent?: string
  rawJson?: string
}
