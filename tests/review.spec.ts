/**
 * 后台记忆评审测试（REQ-003）：
 *  - ReviewScheduler：计数触发、取模对齐（跨会话恢复）、纯工具回合不计入、并发防抖、0=关闭
 *  - buildReviewInput：USER:/ASSISTANT: 转写、工具调用只列名字、正文截断、24 条窗口
 *  - runReview：子代理拉起（toolFilter 白名单 / 提示词内容）、store diff 报告、
 *    通知三档 off/on/verbose、provider/agent 缺失降级
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import {
  buildReviewInput,
  REVIEW_BODY_LIMIT,
  REVIEW_PROMPT,
  REVIEW_TOOL_ALLOWLIST,
  ReviewScheduler,
  reviewNoticeText,
  runReview,
} from '../src/review.ts'
import type { ReviewReport } from '../src/review.ts'
import { MemoryStore } from '../src/store.ts'

// -- helpers ---------------------------------------------------------------

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-review-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响断言结果
    }
  }
})

function userEvent(session: Session, text: string): SessionEvent {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function assistantEvent(session: Session, content: ContentBlock[]): SessionEvent {
  return session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content,
      source: { kind: 'model', provider: 'test', model: 'test' },
    }),
  }, { surfaceOp: 'append' })
}

function toolEvents(session: Session): void {
  session.append('tool/call', {
    turn: 1, step: 1, callId: CallId('c1'), name: 'memory_show', arguments: '{}',
  })
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({
      callId: CallId('c1'),
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
}

/** 追加一条用户消息并立即喂给调度器（模拟 session/event 监听器）。 */
function feed(scheduler: ReviewScheduler, session: Session, event: SessionEvent): void {
  scheduler.onSessionEvent(session, event)
}

// -- ReviewScheduler ---------------------------------------------------------

describe('ReviewScheduler 计数触发', () => {
  it('session/event（global）能收到真实会话 store 的 append 事件（插件接线前提）', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const received: string[] = []
    ctx.on('session/event', (_session, event) => {
      received.push(event.type)
    }, { global: true })

    const session = ctx.sessions.create(SessionId('integration'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    expect(received).toContain('user/message')
  })

  it('每 N 条用户消息触发一次，未到 N 不触发', async () => {
    const session = Session.create(SessionId('count'))
    const run = vi.fn(async () => {})
    const scheduler = new ReviewScheduler({ nudgeInterval: 3, run })

    feed(scheduler, session, userEvent(session, '第一条'))
    feed(scheduler, session, assistantEvent(session, [{ type: 'text', text: '回复' }]))
    feed(scheduler, session, userEvent(session, '第二条'))
    expect(run).not.toHaveBeenCalled()

    feed(scheduler, session, userEvent(session, '第三条'))
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(run.mock.calls[0]![0]).toBe(session)
  })

  it('纯工具回合（tool/call、tool/result）不计入计数', async () => {
    const session = Session.create(SessionId('tools'))
    const run = vi.fn(async () => {})
    const scheduler = new ReviewScheduler({ nudgeInterval: 2, run })

    // 历史日志：2 条用户消息 + 4 个工具事件（模拟历史里大量纯工具回合）
    userEvent(session, '历史1')
    toolEvents(session)
    toolEvents(session)
    userEvent(session, '历史2')

    // 新进程首个被调度事件：懒初始化从日志对齐（历史 user=2，含当前=3）
    feed(scheduler, session, userEvent(session, '新1')) // count=3 → 3%2=1
    expect(run).not.toHaveBeenCalled()
    feed(scheduler, session, userEvent(session, '新2')) // count=4 → 4%2=0 → 触发
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
  })

  it('跨会话恢复：从历史事件流对齐取模，续上 N 的节奏', async () => {
    const session = Session.create(SessionId('resume'))
    const run = vi.fn(async () => {})
    const scheduler = new ReviewScheduler({ nudgeInterval: 4, run })

    // 上一进程留下的 5 条历史用户消息（本进程从未逐个见到）
    for (let i = 0; i < 5; i += 1) userEvent(session, `历史${i}`)

    feed(scheduler, session, userEvent(session, '新1')) // 6%4=2
    feed(scheduler, session, userEvent(session, '新2')) // 7%4=3
    expect(run).not.toHaveBeenCalled()
    feed(scheduler, session, userEvent(session, '新3')) // 8%4=0 → 触发
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
  })

  it('同一会话并发防抖：在途评审未结束时不会启动第二个', async () => {
    const session = Session.create(SessionId('debounce'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run = vi.fn(() => gate)
    const scheduler = new ReviewScheduler({ nudgeInterval: 2, run })

    feed(scheduler, session, userEvent(session, 'u1'))
    feed(scheduler, session, userEvent(session, 'u2')) // 触发 #1（在途）
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    // 在途期间又到 N 的倍数：跳过，不启动第二个
    feed(scheduler, session, userEvent(session, 'u3'))
    feed(scheduler, session, userEvent(session, 'u4')) // count=4 → 4%2=0 但在途 → 跳过
    await Promise.resolve()
    await Promise.resolve()
    expect(run).toHaveBeenCalledTimes(1)

    // 释放后在途标记清除，后续到 N 恢复触发
    release()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    feed(scheduler, session, userEvent(session, 'u5'))
    feed(scheduler, session, userEvent(session, 'u6')) // count=6 → 6%2=0 → 触发 #2
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
  })

  it('nudgeInterval=0 关闭自动评审', async () => {
    const session = Session.create(SessionId('disabled'))
    const run = vi.fn(async () => {})
    const scheduler = new ReviewScheduler({ nudgeInterval: 0, run })

    for (let i = 0; i < 5; i += 1) feed(scheduler, session, userEvent(session, `m${i}`))
    await Promise.resolve()
    expect(run).not.toHaveBeenCalled()
  })
})

// -- buildReviewInput ---------------------------------------------------------

describe('buildReviewInput 对话打包', () => {
  it('USER:/ASSISTANT: verbatim 转写，工具调用只列名字', () => {
    const session = Session.create(SessionId('pack'))
    userEvent(session, '你好，请记住这个项目')
    assistantEvent(session, [{ type: 'text', text: '好的，已记住。' }])
    assistantEvent(session, [
      { type: 'text', text: '我来查一下记忆' },
      { type: 'tool-call', id: CallId('c1'), name: 'memory_show', arguments: '{}' },
      { type: 'tool-call', id: CallId('c2'), name: 'memory_add', arguments: '{"content":"x"}' },
    ])

    const input = buildReviewInput(session.events)
    expect(input).toContain('USER: 你好，请记住这个项目')
    expect(input).toContain('ASSISTANT: 好的，已记住。')
    expect(input).toContain('ASSISTANT[tools: memory_show, memory_add]: 我来查一下记忆')
  })

  it('正文超过 200 字符被截断', () => {
    const session = Session.create(SessionId('trunc'))
    const long = '长'.repeat(300)
    userEvent(session, long)
    const input = buildReviewInput(session.events)
    expect(input).toContain(`USER: ${'长'.repeat(REVIEW_BODY_LIMIT)}…`)
    expect(input).not.toContain('长'.repeat(REVIEW_BODY_LIMIT + 1))
  })

  it('超过 24 条只保留最近 24 条，更早省略并注明', () => {
    const session = Session.create(SessionId('window'))
    for (let i = 0; i < 30; i += 1) userEvent(session, `消息${i}`)
    const input = buildReviewInput(session.events)
    expect(input).toContain('更早的 6 条消息省略')
    expect(input).toContain('USER: 消息29')
    expect(input).not.toContain('USER: 消息0')
    const userLines = input.split('\n').filter(line => line.startsWith('USER: '))
    expect(userLines).toHaveLength(24)
  })

  it('纯工具事件不进入转写', () => {
    const session = Session.create(SessionId('no-tools'))
    userEvent(session, 'hi')
    toolEvents(session)
    assistantEvent(session, [{ type: 'text', text: 'done' }])
    const input = buildReviewInput(session.events)
    const lines = input.split('\n').filter(line => line.startsWith('USER:') || line.startsWith('ASSISTANT'))
    expect(lines).toHaveLength(2)
    expect(input).not.toContain('tool-result')
  })
})

// -- reviewNoticeText ----------------------------------------------------------

describe('reviewNoticeText 通知三档', () => {
  const saved: ReviewReport = {
    saved: true,
    added: 2,
    changes: ['+ 新增（MEMORY）：条目甲', '+ 新增（USER）：偏好乙'],
  }
  const nothing: ReviewReport = { saved: false, added: 0, changes: [] }

  it('off 不发通知', () => {
    expect(reviewNoticeText('off', saved)).toBeUndefined()
    expect(reviewNoticeText('off', nothing)).toBeUndefined()
  })

  it('on：💾 Memory updated（+n 条） / Nothing to save', () => {
    expect(reviewNoticeText('on', saved)).toBe('💾 Memory updated（+2 条）')
    expect(reviewNoticeText('on', nothing)).toBe('Nothing to save')
  })

  it('verbose：追加具体增删改条目摘要', () => {
    const text = reviewNoticeText('verbose', saved)
    expect(text).toContain('💾 Memory updated（+2 条）')
    expect(text).toContain('+ 新增（MEMORY）：条目甲')
    expect(text).toContain('+ 新增（USER）：偏好乙')
    // verbose 且无写入仍是 Nothing to save
    expect(reviewNoticeText('verbose', nothing)).toBe('Nothing to save')
  })
})

// -- runReview ----------------------------------------------------------------

interface MakeContextOptions {
  /** 不注册 subagents 服务（缺服务降级）。 */
  noSubagents?: boolean
  /** 没有注册任何 subagent provider（list 为空）。 */
  providerMissing?: boolean
  /** 唯一注册的 provider 不支持 toolFilter 能力。 */
  noToolFilter?: boolean
  /** 无活 agent（agents.get 返回 undefined）。 */
  noAgent?: boolean
  /** 评审子代理是否真的写入记忆（false=什么都不写）。 */
  write?: boolean
}

function makeContext(options: MakeContextOptions = {}) {
  const ctx = new Context()
  const store = new MemoryStore(tempDir())
  const session = Session.create(SessionId('run'))
  const agent = options.noAgent ? undefined : ({
    id: session.id,
    options: { provider: 'main-provider', model: 'main-model' },
    status: 'idle',
    followup: vi.fn(),
    inject: vi.fn(),
  } as unknown as Agent)
  ctx.provide('agents', { get: () => agent })

  const names = options.providerMissing ? [] : ['spawn']
  const started: SubagentStartRequest[] = []
  const runtime = {
    list: vi.fn(() => names),
    getProvider: vi.fn((name: string) => {
      if (options.providerMissing) return undefined
      return {
        name,
        capabilities: {
          outputSchema: false,
          depthLimit: false,
          toolFilter: options.noToolFilter ? false : true,
          persona: false,
        },
      }
    }),
    start: vi.fn(async (_name: string, request: SubagentStartRequest) => {
      started.push(request)
      return {
        id: SessionId('memory-review-run'),
        localAgent: undefined,
        result: (async () => {
          if (options.write !== false) {
            await store.add('memory', '评审写入的条目甲')
            await store.add('memory', '评审写入的条目乙')
            await store.add('user', '用户偏好：评审记录')
          }
          return { output: [], stopReason: 'completed' as const }
        })(),
        dispose: async () => {},
      }
    }),
  }
  if (!options.noSubagents) ctx.provide('subagents', runtime)

  return { ctx, store, session, agent, runtime, started }
}

function reviewConfig(overrides: Partial<{ reviewProvider: string; reviewModel: string; reviewNotify: 'off' | 'on' | 'verbose' }> = {}) {
  return {
    reviewProvider: '',
    reviewModel: '',
    reviewNotify: 'on' as const,
    ...overrides,
  }
}

function delivered(agent: Agent | undefined): string[] {
  if (agent === undefined) return []
  const messages: string[] = []
  for (const call of (agent.followup as ReturnType<typeof vi.fn>).mock.calls) {
    const block = (call[0] as { content: ContentBlock[] }).content[0]
    if (block?.type === 'text') messages.push(block.text)
  }
  for (const call of (agent.inject as ReturnType<typeof vi.fn>).mock.calls) {
    const block = (call[0] as { content: ContentBlock[] }).content[0]
    if (block?.type === 'text') messages.push(block.text)
  }
  return messages
}

describe('runReview 评审执行', () => {
  it('拉起评审子代理：toolFilter 白名单 + 提示词含评审纪律与对话转写', async () => {
    const { ctx, store, session, agent, started } = makeContext()
    userEvent(session, '请记住这个项目用反向工作流')

    const report = await runReview({ ctx, config: reviewConfig(), store, session })

    expect(report.saved).toBe(true)
    expect(report.added).toBe(3)
    expect(started).toHaveLength(1)
    expect(started[0]!.label).toBe('memory-review')
    expect(started[0]!.parent).toBe(agent)
    expect(started[0]!.toolFilter).toEqual({ allow: REVIEW_TOOL_ALLOWLIST })
    const block = started[0]!.prompt[0]
    expect(block?.type).toBe('text')
    if (block?.type === 'text') {
      expect(block.text).toContain(REVIEW_PROMPT)
      expect(block.text).toContain('USER: 请记住这个项目用反向工作流')
      expect(block.text).toContain('memory_show') // 评审纪律要求先读活状态
    }
  })

  it('通知 on：💾 Memory updated（+n 条），agent idle 走 followup', async () => {
    const { ctx, store, session, agent } = makeContext()
    await runReview({ ctx, config: reviewConfig(), store, session })

    const texts = delivered(agent)
    expect(texts).toEqual(['💾 Memory updated（+3 条）'])
    expect(agent!.followup).toHaveBeenCalledTimes(1)
    expect(agent!.inject).not.toHaveBeenCalled()
  })

  it('通知 on：无写入时 Nothing to save', async () => {
    const { ctx, store, session, agent } = makeContext({ write: false })
    await runReview({ ctx, config: reviewConfig(), store, session })
    expect(delivered(agent)).toEqual(['Nothing to save'])
  })

  it('通知 verbose：追加具体条目摘要', async () => {
    const { ctx, store, session, agent } = makeContext()
    await runReview({ ctx, config: reviewConfig({ reviewNotify: 'verbose' }), store, session })

    const texts = delivered(agent)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('💾 Memory updated（+3 条）')
    expect(texts[0]).toContain('+ 新增（MEMORY）：评审写入的条目甲')
    expect(texts[0]).toContain('+ 新增（USER）：用户偏好：评审记录')
  })

  it('通知 off：不投递任何消息', async () => {
    const { ctx, store, session, agent } = makeContext()
    await runReview({ ctx, config: reviewConfig({ reviewNotify: 'off' }), store, session })
    expect(delivered(agent)).toEqual([])
    expect(agent!.followup).not.toHaveBeenCalled()
    expect(agent!.inject).not.toHaveBeenCalled()
  })

  it('agent 忙（running）时通知走 inject 排队', async () => {
    const { ctx, store, session, agent } = makeContext()
    Object.defineProperty(agent, 'status', { value: 'running' })
    await runReview({ ctx, config: reviewConfig(), store, session })
    expect(agent!.inject).toHaveBeenCalledTimes(1)
    expect(agent!.followup).not.toHaveBeenCalled()
  })

  it('reviewProvider/reviewModel 作为评审子代理的 LLM 路由覆盖（留空=主模型）', async () => {
    const { ctx, store, session, started } = makeContext()
    await runReview({
      ctx,
      config: reviewConfig({ reviewProvider: 'cheap-provider', reviewModel: 'cheap-model' }),
      store,
      session,
    })
    expect(started).toHaveLength(1)
    expect(started[0]!.agentOptions).toEqual({ provider: 'cheap-provider', model: 'cheap-model' })
  })

  it('reviewProvider/reviewModel 留空：不传 agentOptions（子代理继承主 agent 路由）', async () => {
    const { ctx, store, session, started } = makeContext()
    await runReview({ ctx, config: reviewConfig(), store, session })
    expect(started).toHaveLength(1)
    expect(started[0]!.agentOptions).toBeUndefined()
  })

  it('传输 provider 默认 spawn（第一个注册且支持 toolFilter 的 provider）', async () => {
    const { ctx, store, session, runtime, started } = makeContext()
    await runReview({ ctx, config: reviewConfig(), store, session })
    expect(started).toHaveLength(1)
    expect(runtime.start).toHaveBeenCalledWith('spawn', expect.anything())
  })

  it('没有注册任何 subagent provider：降级，不拉起子代理、不发通知、不崩溃', async () => {
    const { ctx, store, session, agent, started } = makeContext({ providerMissing: true })
    const report = await runReview({ ctx, config: reviewConfig(), store, session })
    expect(report).toEqual({ saved: false, added: 0, changes: [] })
    expect(started).toHaveLength(0)
    expect(delivered(agent)).toEqual([])
  })

  it('注册的 provider 不支持 toolFilter：降级跳过（三档配置仍保留）', async () => {
    const { ctx, store, session, agent, started } = makeContext({ noToolFilter: true })
    const report = await runReview({ ctx, config: reviewConfig(), store, session })
    expect(report.saved).toBe(false)
    expect(started).toHaveLength(0)
    expect(delivered(agent)).toEqual([])
  })

  it('会话没有活 agent：降级，不拉起子代理', async () => {
    const { ctx, store, session, started } = makeContext({ noAgent: true })
    const report = await runReview({ ctx, config: reviewConfig(), store, session })
    expect(report.saved).toBe(false)
    expect(started).toHaveLength(0)
  })

  it('subagents 服务未注册：降级，不崩溃', async () => {
    const { ctx, store, session, started } = makeContext({ noSubagents: true })
    const report = await runReview({ ctx, config: reviewConfig(), store, session })
    expect(report.saved).toBe(false)
    expect(started).toHaveLength(0)
  })
})
