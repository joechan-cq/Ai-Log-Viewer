/** stream-json 单行原始事件。格式会演进，一律按开放对象处理。 */
export interface RawEvent {
  type: string
  subtype?: string
  uuid?: string
  session_id?: string
  timestamp?: string | number
  parent_tool_use_id?: string | null
  subagent_type?: string
  task_description?: string
  [k: string]: unknown
}

export interface SessionMeta {
  sessionId?: string
  model?: string
  cwd?: string
  version?: string
  permissionMode?: string
  outputStyle?: string
  tools: string[]
  mcpServers: { name: string; status?: string }[]
  plugins: unknown[]
  skills: unknown[]
  slashCommands: string[]
  startedAt?: number
  endedAt?: number
}

export interface ToolStat {
  count: number
  ok: number
  error: number
  /** 由 tool_use → tool_result 的时间差累加 */
  totalMs: number
  /** 归因到该工具的上下文增量合计 */
  ctxAdded: number
  /** 该工具被哪些 agent 调用（main = 主会话） */
  byAgent: Record<string, number>
}

export interface AgentStat {
  /** 真正启动成功的次数（有 task_started 事件） */
  count: number
  /** 发起过多少次调用（Agent/Task 工具调用数，含启动失败的） */
  launches: number
  /** 调用返回错误的次数（例如 model 参数非法，agent 压根没跑起来） */
  failed: number
  totalTokens: number
  toolUses: number
  durationMs: number
}

/** 一次 API 请求的 token 画像（按 message.id 去重后得到） */
export interface TokenRequest {
  messageId: string
  lineNo: number
  /** main 或 subagent_type */
  agent: string
  /** agent 实例键：'main' 或该子 agent 的 parent_tool_use_id。同类型 agent 的多次启动靠它区分 */
  instance: string
  /** 时间线跳转锚点 */
  nodeId?: string
  /** 这次请求产出了什么（工具名 + 摘要 / 文本首行） */
  label: string
  input: number
  /**
   * 本次写入缓存的 token。注意它 **不等于** 上下文增量：
   * 缓存前缀失效时会整段重写，cacheCreate 会暴涨而上下文其实没怎么长
   * （实测有一条 cacheCreate=190,636 而真实增量只有 1,796）。
   */
  cacheCreate: number
  cacheRead: number
  /** message_start 时的快照，严重偏低，不能当输出量用 */
  output: number
  /** 本次请求的上下文总量 = input + cacheCreate + cacheRead */
  ctxTotal: number
  /** 相对同一 agent 实例上一次请求的上下文增量 —— 这才是「这一步多贵」 */
  ctxDelta: number
  /** 这段增量是谁造成的：上一步的动作（首次请求则是该实例的初始上下文） */
  causeLabel: string
  causeNodeId?: string
  causeLineNo?: number
}

export interface Stats {
  bytes: number
  lines: number
  parsed: number
  parseErrors: number
  /** "type" 或 "type/subtype" → 次数 */
  byEventType: Record<string, number>
  /** 工具名 → 统计 */
  toolCalls: Record<string, ToolStat>
  /** Skill 名 → 调用次数（来自 Skill 工具入参 skill 字段） */
  skillCalls: Record<string, number>
  /** mcp__server__tool → 次数 */
  mcpCalls: Record<string, number>
  /** 用户消息里的 /slash-command → 次数 */
  slashCommands: Record<string, number>
  /** subagent_type → 统计（只含 task_type=local_agent） */
  agents: Record<string, AgentStat>
  /** 后台任务数（task_type=local_bash，即被 backgrounded 的 Bash） */
  backgroundTasks: number
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheCreate: number
    /** 所有请求的上下文增量之和 = 整个会话真正进入过上下文的 token 量 */
    ctxGrowth: number
  }
  /** 按 message.id 去重后的逐请求 token 画像 */
  requests: TokenRequest[]
  /** 上下文峰值（单次请求的 ctxTotal 最大值） */
  peakContext: number
  peakContextByAgent: Record<string, number>
  thinkingTokens: number
  counts: {
    assistantMessages: number
    textBlocks: number
    thinkingBlocks: number
    toolUses: number
    toolResults: number
    userMessages: number
    hooks: number
    /** 结果里返回的图片张数（截图） */
    images: number
    /** 内容被剥离的思考块（不渲染，只计数） */
    emptyThinkingBlocks: number
  }
  rateLimits: unknown[]
  wallClockMs?: number
}

export interface ImageRef {
  mediaType: string
  /** base64 数据，直接拼 data: URI 渲染 */
  data: string
}

export interface ToolResult {
  isError: boolean
  text: string
  /** 结果里的图片块（截图类工具会返回，单张可达数百 KB） */
  images: ImageRef[]
  /** tool_use_result 里的结构化负载（Bash 的 stdout/stderr、Agent 的汇总等） */
  structured?: Record<string, unknown>
}

export interface TaskInfo {
  taskId: string
  taskType?: string
  subagentType?: string
  description?: string
  status?: string
  summary?: string
  outputFile?: string
  prompt?: string
  /** 最后一次 task_progress 的累计值 */
  totalTokens?: number
  toolUses?: number
  agentDurationMs?: number
  /** 子 agent 执行过程中最近的工具名序列（去重展示） */
  lastToolName?: string
  progressCount: number
}

export type LogNode = TextNode | ThinkingNode | ToolNode | SystemNode

interface NodeBase {
  id: string
  lineNo: number
  ts?: number
  /** 所属 agent：undefined = 主会话 */
  agent?: string
  /** 原始 JSON（超大行不保留，见 RAW_KEEP_LIMIT） */
  rawJson?: string
}

export interface TextNode extends NodeBase {
  kind: 'text'
  role: 'user' | 'assistant'
  text: string
}

export interface ThinkingNode extends NodeBase {
  kind: 'thinking'
  text: string
}

export interface ToolNode extends NodeBase {
  kind: 'tool'
  toolUseId: string
  name: string
  input: Record<string, unknown>
  label: string
  result?: ToolResult
  resultTs?: number
  durationMs?: number
  task?: TaskInfo
  /**
   * 归因估算：下一次请求的 cacheCreate 分摊到本次调用，
   * 近似「这一步的结果给上下文塞进了多少 token」。
   */
  ctxAdded?: number
  /** 该工具是 Agent/Task 时，子 agent 的完整时间线 */
  children: LogNode[]
}

export interface SystemNode extends NodeBase {
  kind: 'system'
  subtype: string
  title: string
  event: RawEvent
}

export interface ParsedLog {
  session: SessionMeta
  roots: LogNode[]
  stats: Stats
}

export type WorkerRequest = { kind: 'parse'; file: File }

export type WorkerResponse =
  | { kind: 'progress'; bytes: number; total: number; lines: number }
  | { kind: 'done'; payload: ParsedLog }
  | { kind: 'error'; message: string }
