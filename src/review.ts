/**
 * 后台记忆评审（REQ-003）：每 N 条用户消息自动触发一次隔离子代理评审，
 * 把对话中暴露的用户偏好 / 纠正 / 环境事实沉淀进 MEMORY.md / USER.md，
 * 完成后向用户会话发简短通知。解决「对话内容不自动进入记忆」的问题。
 *
 * 关键 DSH 框架依据（以本地 checkout packages/ 为准，行号随版本可能漂移）：
 *  - `session/event` 签名 (session, event)：packages/core/session/src/index.ts:76
 *  - 用户消息事件类型 `user/message`：packages/core/session/src/known-event-types.ts:62
 *  - 同款 session/event 监听先例：packages/core/agent-loop/src/runtime-context.ts:46
 *  - append 不可重入（监听器内同步 append 会抛错，reentrant-observer 用例）：
 *    packages/core/session/src/index.ts:624、packages/core/session/tests/session.spec.ts:1526
 *  - `ctx.subagents.start(provider, { prompt, parent, toolFilter, ... })`：
 *    packages/subagent/subagent/src/index.ts:414
 *  - `toolFilter` 能力校验（provider 不支持则 start 拒绝）：
 *    packages/subagent/subagent/src/index.ts:485、types.ts:140
 *  - spawn provider 声明支持 toolFilter：packages/subagent/subagent-spawn-in-process/src/index.ts:42
 *  - session → 当前 agent 映射：`ctx.agents.get(session.id)`（agent.id === session.id）：
 *    packages/core/agent/src/index.ts:476、:583
 *  - 后台通知投递先例（idle→followup 唤醒 / busy→inject 排队，form:'notice'）：
 *    packages/jobs/tool-jobs/src/index.ts:279、packages/plan/plan-mode/src/index.ts:469
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { MemoryStore, MemoryTarget } from './store.ts'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 评审打包的对话窗口：最近 24 条用户/助手消息，更早省略。 */
export const REVIEW_WINDOW = 24

/** 单条消息正文的截断长度（字符）。 */
export const REVIEW_BODY_LIMIT = 200

/** 评审子代理的工具白名单：只有 memory_*（验收项「无法执行 shell/读写文件/其他工具」）。 */
export const REVIEW_TOOL_ALLOWLIST = [
  'memory_show',
  'memory_add',
  'memory_replace',
  'memory_remove',
  'memory_batch',
  'memory_refresh',
] as const

/**
 * 评审提示词（中文，常量内嵌，不落盘）。
 *
 * 硬约束（评审要求）：
 *  1. 必须先 memory_show 读活状态——注入 system prompt 的 MEMORY/USER 块是
 *     会话开始（或上次 refresh）冻结的，可能落后于最近写入；
 *  2. 容量超限用 replace/remove 合并后写入（store 的 add 超限会返回合并引导错误）。
 */
export const REVIEW_PROMPT = [
  '你是一个「记忆评审代理」。你的任务：从下面这段对话转写中，提炼出值得长期记住的信息，写入持久记忆库。',
  '',
  '## 你拥有的能力',
  '你只拥有 memory_* 工具（memory_show / memory_add / memory_replace / memory_remove / memory_batch / memory_refresh）。',
  '你没有 shell、文件读写或任何其他工具——所有写入必须通过 memory_* 工具完成。',
  '',
  '## 工作纪律（必须遵守）',
  '1. 先调用 memory_show 读取两个存储（MEMORY.md / USER.md）的当前活状态。',
  '   不要依赖 system prompt 里冻结的 MEMORY/USER 快照——那是会话开始时（或上次刷新时）的版本，可能已落后于最近的写入。',
  '2. 对照对话转写判断哪些信息值得长期记住：',
  '   - 用户偏好、纠正、沟通风格、身份信息 → 写入 USER.md（target=user）',
  '   - 环境事实、项目约定、工具/工作流怪癖 → 写入 MEMORY.md（target=memory）',
  '   - 一次性任务细节、临时闲聊、已过时的信息 → 不写。',
  '3. 已存在的条目不要重复添加；内容有更新的用 memory_replace 更新；过时或无用的用 memory_remove 删除。',
  '4. 容量超限时（memory_add 会返回合并引导错误）：先用 memory_replace 合并重叠条目或 memory_remove 删除过时条目腾出空间，再重试；',
  '   需要「删旧 + 加新」时可用一次 memory_batch 原子完成。',
  '5. 每条目应简短、自包含、跨会话可独立理解；不要写入对话中的逐字原文。',
  '6. 只修改与本次评审相关的条目，不要顺手改动无关内容；写入完成后立即停止，不要反复调用工具确认。',
  '',
  '## 输出',
  '完成写入后，用一句话总结你的决定（例如「新增 2 条用户偏好，更新 1 条项目约定」）。',
].join('\n')

// ---------------------------------------------------------------------------
// 对话打包：最近 REVIEW_WINDOW 条 verbatim 转写
// ---------------------------------------------------------------------------

function textOf(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join(' ')
}

function clip(text: string, limit = REVIEW_BODY_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function transcribe(event: SessionEvent): string {
  switch (event.type) {
    case 'user/message':
      return `USER: ${clip(textOf(event.data.content))}`
    case 'assistant/message': {
      // assistant/message：data = { turn, step, message }（packages/core/session/src/types.ts:273）
      const message = event.data.message
      const toolNames = [...new Set(
        message.content.filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call').map(block => block.name),
      )]
      const tools = toolNames.length > 0 ? `[tools: ${toolNames.join(', ')}]` : ''
      const body = clip(textOf(message.content))
      return body ? `ASSISTANT${tools}: ${body}` : `ASSISTANT${tools}`
    }
    default:
      return ''
  }
}

/**
 * 把会话事件流打包成评审输入：最近 24 条用户/助手消息 verbatim 转写
 * （USER:/ASSISTANT:，工具调用只列名字、正文截 200 字符），更早省略。
 * 纯工具回合（tool/call、tool/result）不进入转写——评审的信息来源是用户消息。
 */
export function buildReviewInput(events: readonly SessionEvent[]): string {
  const messages = events.filter(event => event.type === 'user/message' || event.type === 'assistant/message')
  const total = messages.length
  const window = messages.slice(-REVIEW_WINDOW)
  const lines: string[] = []
  if (total > window.length) {
    lines.push(`（更早的 ${total - window.length} 条消息省略）`)
  }
  for (const event of window) lines.push(transcribe(event))
  return [
    `── 对话转写（最近 ${window.length} 条${total > window.length ? ` / 共 ${total} 条` : ''}，更早省略）──`,
    ...lines,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 评审结果：对评审前后 store 活状态做 diff，得到新增/删除摘要
// ---------------------------------------------------------------------------

export interface ReviewReport {
  /** 是否有任何写入（add/replace/remove）发生。 */
  readonly saved: boolean
  /** 净新增条数（两个存储合计）。 */
  readonly added: number
  /** 变更摘要（「+ 新增 / − 删除」条目列表），供 verbose 通知。 */
  readonly changes: string[]
}

function snapshotEntries(store: MemoryStore): Record<MemoryTarget, string[]> {
  return { memory: [...store.entriesFor('memory')], user: [...store.entriesFor('user')] }
}

function diffReport(
  before: Record<MemoryTarget, string[]>,
  after: Record<MemoryTarget, string[]>,
): ReviewReport {
  const changes: string[] = []
  let added = 0
  for (const target of ['memory', 'user'] as const) {
    const tag = target === 'user' ? 'USER' : 'MEMORY'
    const beforeSet = new Set(before[target])
    const afterSet = new Set(after[target])
    for (const entry of after[target]) {
      if (!beforeSet.has(entry)) {
        added += 1
        changes.push(`+ 新增（${tag}）：${clip(entry, 80)}`)
      }
    }
    for (const entry of before[target]) {
      if (!afterSet.has(entry)) {
        changes.push(`− 删除（${tag}）：${clip(entry, 80)}`)
      }
    }
  }
  return { saved: changes.length > 0, added, changes }
}

// ---------------------------------------------------------------------------
// 通知（三档 off / on / verbose）
// ---------------------------------------------------------------------------

export type ReviewNotifyMode = 'off' | 'on' | 'verbose'

/** 生成通知文本；off 返回 undefined（不发）。 */
export function reviewNoticeText(notify: ReviewNotifyMode, report: ReviewReport): string | undefined {
  if (notify === 'off') return undefined
  if (!report.saved) return 'Nothing to save'
  const head = report.added > 0 ? `💾 Memory updated（+${report.added} 条）` : '💾 Memory updated'
  if (notify === 'verbose' && report.changes.length > 0) {
    return `${head}\n${report.changes.map(line => `  ${line}`).join('\n')}`
  }
  return head
}

/**
 * 向会话投递通知。走 agent 的 inbox（tool-jobs 同款：idle→followup 唤醒、
 * busy→inject 排队到下一步），绝不直接 session.append——那会在 session/event
 * 发布窗口内重入（core/session 的 reentrant-observer 用例拒绝重入 append）。
 * 没有活 agent 时降级 console.log（评审约束 4）。
 */
function deliverReviewNotice(
  notify: ReviewNotifyMode,
  report: ReviewReport,
  agent: Agent | undefined,
): void {
  const text = reviewNoticeText(notify, report)
  if (text === undefined) return
  const summary = text.split('\n', 1)[0] ?? text
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    // form:'notice'：GUI 折叠展示的一行摘要（tool-jobs 同款，packages/jobs/tool-jobs/src/index.ts:281）。
    source: { kind: 'plugin', plugin: 'memory', form: 'notice', summary },
  })
  if (agent !== undefined) {
    // idle→followup 唤醒让用户立即看到；busy→inject 排队到当前回合的下一步。
    // 依据：packages/core/agent/src/runtime-types.ts:117（followup）、:143（inject）。
    if (agent.status === 'idle') agent.followup(message)
    else agent.inject(message)
  } else {
    console.log(`[memory] ${text}`)
  }
}

// ---------------------------------------------------------------------------
// runReview：打包 → 拉评审子代理 → 收集结果 → 发通知
// ---------------------------------------------------------------------------

export interface RunReviewOptions {
  ctx: Context
  config: {
    /**
     * 评审子代理的 LLM provider（agentOptions.provider）；留空=主 agent 的 provider
     * （子代理默认继承父路由，见 child-agent.ts:68-83 的 resolveChildAgentOptions）。
     */
    reviewProvider: string
    /** 评审子代理的 LLM model（agentOptions.model）；留空=主 agent 的 model。 */
    reviewModel: string
    /** 通知档位：off / on / verbose。 */
    reviewNotify: ReviewNotifyMode
  }
  store: MemoryStore
  session: Session
}

/** cordis 服务安全读取：未注入/未提供的服务直接访问会抛错（vendor/cordis/src/reflect.ts:144），用非抛错读取探测。 */
function safeService<T>(ctx: Context, name: string): T | undefined {
  return ctx.reflect.get(name, false) as T | undefined
}

function lookupAgent(ctx: Context, session: Session): Agent | undefined {
  // session → 当前 agent：agent.id 与 session.id 是同一标识（packages/core/agent/src/index.ts:476），
  // 经 ctx.agents 注册表按 session id 反查（packages/core/agent/src/index.ts:583）。
  return safeService<{ get(id: SessionId): Agent | undefined }>(ctx, 'agents')?.get(session.id)
}

interface ReviewSubagents {
  /** 已注册的 subagent provider 名（插入序），subagent/src/index.ts:400。 */
  list(): string[]
  getProvider(name: string): { capabilities: { toolFilter: boolean } } | undefined
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
}

/**
 * 选择评审的「传输」provider（ctx.subagents.start 的第一个参数，如 spawn/fork/acp）。
 * 默认标准进程内 spawn（base 组合包已加载，bundle/base/cordis.patch.yml:296）；
 * spawn 未注册或不支持 toolFilter 时回退到第一个注册且支持 toolFilter 的 provider；
 * 都不可用时返回 undefined（评审约束 4 的降级入口）。
 */
function resolveTransportProvider(runtime: ReviewSubagents): string | undefined {
  const capable = runtime.list().filter(name => runtime.getProvider(name)?.capabilities.toolFilter)
  if (capable.includes('spawn')) return 'spawn'
  return capable[0]
}

function logSkip(reason: string): void {
  console.log(`[memory] 后台记忆评审跳过：${reason}`)
}

/**
 * 执行一次后台记忆评审（fire-and-forget 的调用方不 await 本函数）。
 * 任何失败只记录日志并返回空报告，绝不向调用方抛错（评审约束 4：不因缺 provider 崩溃）。
 */
export async function runReview(options: RunReviewOptions): Promise<ReviewReport> {
  const { ctx, config, store, session } = options
  const empty: ReviewReport = { saved: false, added: 0, changes: [] }
  try {
    const agent = lookupAgent(ctx, session)
    if (agent === undefined) {
      logSkip(`会话 ${session.id} 没有关联的活 agent（评审子代理需要 parent 做 lineage，见 subagent/types.ts:110）。`)
      return empty
    }

    const runtime = safeService<ReviewSubagents>(ctx, 'subagents')
    if (runtime === undefined) {
      logSkip('subagents 服务未注册（未加载 @deepseek-ai/dsh-subagent）。')
      return empty
    }

    // 传输 provider：默认 spawn，回退第一个支持 toolFilter 的 provider。
    const providerName = resolveTransportProvider(runtime)
    if (providerName === undefined) {
      logSkip('没有支持 toolFilter 能力的 subagent provider（检查是否加载 dsh-subagent-spawn-in-process 等传输插件）。')
      return empty
    }

    // 模型路由：reviewProvider/reviewModel 留空时子代理继承主 agent 路由
    // （resolveChildAgentOptions：child-agent.ts:68-83），配置了则覆盖（便宜模型省成本）。
    const agentOptions: AgentOptions = {}
    if (config.reviewProvider) agentOptions.provider = config.reviewProvider
    if (config.reviewModel) agentOptions.model = config.reviewModel

    // 评审前后的活状态 diff 得出报告（评审代理与主会话共用同一 MemoryStore 实例，
    // 写路径的互斥与锁内重读由 store.ts 保证，见 DESIGN.md 风险表）。
    const before = snapshotEntries(store)

    const promptText = `${REVIEW_PROMPT}\n\n${buildReviewInput(session.events)}`
    const request: SubagentStartRequest = {
      label: 'memory-review',
      prompt: [{ type: 'text', text: promptText }],
      parent: agent,
      // 每次评审一个独立 AbortController；会话销毁不等待评审（评审写记忆独立于会话存活）。
      signal: new AbortController().signal,
      // 工具白名单：评审代理只拥有 memory_*（subagent/types.ts:140 的 ToolRestriction）。
      toolFilter: { allow: REVIEW_TOOL_ALLOWLIST },
      // reviewProvider/reviewModel 留空时不传 agentOptions，子代理继承主 agent 路由。
      ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
    }
    const run = await runtime.start(providerName, request)
    try {
      await run.result
    } finally {
      // SubagentRun 契约：必须 dispose 以释放资源（subagent/types.ts:249-275）。
      await run.dispose()
    }

    const report = diffReport(before, snapshotEntries(store))
    deliverReviewNotice(config.reviewNotify, report, agent)
    return report
  } catch (error) {
    console.warn(`[memory] 后台记忆评审失败：${String(error)}`)
    return empty
  }
}

// ---------------------------------------------------------------------------
// ReviewScheduler：计数 + 取模对齐 + 并发防抖 + 触发
// ---------------------------------------------------------------------------

export interface ReviewSchedulerOptions {
  /** 每 N 条用户消息触发一次评审；<= 0 表示关闭自动评审。 */
  readonly nudgeInterval: number
  /** 触发评审。调用方（session/event 监听器）不 await 返回的 promise。 */
  readonly run: (session: Session) => Promise<unknown>
}

interface SessionReviewState {
  /** 已计数的用户消息数（含历史事件流对齐）。 */
  count: number
  /** 该会话是否已有评审在途（并发防抖）。 */
  inReview: boolean
}

function countUserMessages(events: readonly SessionEvent[]): number {
  let count = 0
  for (const event of events) if (event.type === 'user/message') count += 1
  return count
}

export class ReviewScheduler {
  private readonly sessions = new Map<SessionId, SessionReviewState>()

  constructor(private readonly options: ReviewSchedulerOptions) {}

  /**
   * 由插件级 session/event 监听器同步调用（热路径，绝不 await）。
   * 只计数 user/message 事件（纯工具回合不计入）；触发走微任务，fire-and-forget。
   */
  onSessionEvent(session: Session, event: SessionEvent): void {
    if (this.options.nudgeInterval <= 0) return
    if (event.type !== 'user/message') return
    const state = this.stateFor(session)
    state.count += 1
    if (state.count % this.options.nudgeInterval !== 0) return
    if (state.inReview) return // 防抖：在途评审未结束时不再触发第二个
    state.inReview = true
    void Promise.resolve()
      .then(() => this.options.run(session))
      .catch((error: unknown) => {
        console.warn(`[memory] 后台记忆评审失败：${String(error)}`)
      })
      .finally(() => {
        const current = this.sessions.get(session.id)
        if (current) current.inReview = false
      })
  }

  /** 会话销毁时清理计数与在途标记，防 Map 泄漏。 */
  onSessionDisposed(session: Session): void {
    this.sessions.delete(session.id)
  }

  private stateFor(session: Session): SessionReviewState {
    let state = this.sessions.get(session.id)
    if (state === undefined) {
      // 首次见到该会话：从历史事件流对齐取模（会话恢复/续接后续上 N 的节奏）。
      // session/event 的 listener 在 log.push 之后运行（packages/core/session/src/index.ts:643-647），
      // 当前事件已在 session.events 里，先回退 1，再由 onSessionEvent 统一 +1。
      const total = countUserMessages(session.events)
      state = { count: Math.max(0, total - 1), inReview: false }
      this.sessions.set(session.id, state)
    }
    return state
  }
}
