/**
 * dsh-tool-memory —— DeepSeek Harness 跨会话持久记忆插件。
 *
 * 设计参考 Hermes Agent 的 memory 工具（tools/memory_tool.py）：
 *
 *  1. 双存储纯文本文件：MEMORY.md（代理的笔记）/ USER.md（用户画像），
 *     `§` 分隔条目，有字符预算（默认 2200/1375，与 Hermes 一致）。
 *  2. 冻结快照：插件加载与每个新会话（session/created）时从磁盘重建快照，
 *     作为 system prompt section 注入；会话中途的写入只落盘、不改快照，
 *     保住 LLM prefix cache。活状态通过 memory_show 等工具响应可见。
 *  3. 工具面按 DSH 惯例拆成独立工具（Hermes 是单工具 + action 参数）：
 *     memory_add / memory_replace / memory_remove / memory_batch /
 *     memory_show / memory_refresh。
 *  4. 写入安全：进程内互斥 + 原子 rename；外部漂移（无法 round-trip 的
 *     磁盘内容）拒绝写入并保存 .bak 快照；威胁模式（注入/外传/后门）
 *     写前拦截、快照构建时屏蔽。
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
// 类型导入同时把两个包的模块增强（Context.systemPrompt / 'session/created' 事件）纳入编译作用域。
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type { Session } from '@deepseek-ai/dsh-session'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryStore,
  type BatchOperation,
  type MemoryTarget,
  type StoreResult,
} from './store.ts'
import { renderRefresh, renderShow, renderWrite, text, type ShowStore } from './render.ts'
import { ReviewScheduler, runReview } from './review.ts'
import type {} from '@deepseek-ai/dsh-subagent' // 让 ctx.subagents 的类型增强进入编译作用域
import type {} from '@deepseek-ai/dsh-agent' // 让 ctx.agents 的类型增强进入编译作用域

export const name = 'memory'
// 'subagents' 必须注入：评审要走 ctx.subagents 程序化拉起子代理（评审约束 1）；
// 'agents' 用于「session → 当前 agent」反查（评审约束 3）。
export const inject = ['tools', 'systemPrompt', 'agents', 'subagents']

/**
 * 插件配置。所有字段都有 Schemastery 默认值，加载时必被填充。
 */
export interface Config {
  /** 记忆文件目录；留空依次回退环境变量、$DSH_HOME/memories（DSH_HOME 或 ~/.dsh）。 */
  root: string
  /** MEMORY.md 字符预算。 */
  memoryCharLimit: number
  /** USER.md 字符预算。 */
  userCharLimit: number
  /** 每 N 条用户消息自动触发一次后台记忆评审；0=关闭自动评审。 */
  nudgeInterval: number
  /** 评审子代理的 provider；留空=主 agent 的 provider。 */
  reviewProvider: string
  /** 评审子代理的 model；留空=主 agent 的 model（当前随 provider 默认）。 */
  reviewModel: string
  /** 评审完成通知档位：off 不发 / on 简短 / verbose 含条目摘要。 */
  reviewNotify: 'off' | 'on' | 'verbose'
}

export const Config: Schema<Config> = Schema.object({
  root: Schema.string().default(''),
  memoryCharLimit: Schema.number().default(2200),
  userCharLimit: Schema.number().default(1375),
  nudgeInterval: Schema.number().default(10).min(0),
  reviewProvider: Schema.string().default(''),
  reviewModel: Schema.string().default(''),
  reviewNotify: Schema.union(['off', 'on', 'verbose']).default('on'),
})

function resolveRoot(config: Config): string {
  if (config.root) return config.root
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'memories')
}

const OBJECT_OUTPUT = { type: 'object', additionalProperties: true } as const

type JsonObjectValue = Record<string, JsonValue>

/** 记忆工具失败统一抛 HarnessError：message 即模型可见的失败详情。 */
function throwIfFailed(result: StoreResult): void {
  if (!result.success) {
    throw new HarnessError(result.error ?? '记忆操作失败。', 'MEMORY_ERROR')
  }
}

export function apply(ctx: Context, config: Config) {
  const root = resolveRoot(config)
  const store = new MemoryStore(root, {
    memoryCharLimit: config.memoryCharLimit,
    userCharLimit: config.userCharLimit,
  })
  store.loadFromDisk()

  console.log(`[memory] plugin loaded (root=${root})`)

  // ── 冻结快照注入 system prompt ───────────────────────────────────
  // 快照在加载/新会话开始时冻结；会话中途写入不改变 system prompt，
  // 保住 prefix cache。空存储时 section 不贡献内容。
  ctx.on('session/created', (_session: Session) => { store.refresh() }, { global: true })

  const notesSection: PromptSection = {
    name: 'memory:notes',
    order: 60,
    text: () => store.snapshotText('memory'),
  }
  const profileSection: PromptSection = {
    name: 'memory:profile',
    order: 61,
    text: () => store.snapshotText('user'),
  }
  const onboardingSection: PromptSection = {
    name: 'memory:onboarding',
    order: 62,
    text: () => store.onboardingPrompt(),
  }
  ctx.systemPrompt.section(notesSection)
  ctx.systemPrompt.section(profileSection)
  ctx.systemPrompt.section(onboardingSection)

  // ── 工具注册 ──────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'memory_show',
    description: '查看记忆的活状态：按 target 列出 memory（我的笔记）或 user（用户画像）的全部条目与占用（usage）。不传 target 则两者都显示。适合核对当前记忆内容或确认写入结果。',
    parameters: {
      target: {
        type: 'string', enum: ['memory', 'user'],
        description: '要查看的存储；省略则两者都显示',
      },
    },
    output: {
      schema: { type: 'array', items: OBJECT_OUTPUT },
      render: (_args, value) => text(renderShow(value as unknown as ShowStore[])),
    },
    async execute(args) {
      const targets: MemoryTarget[] = args.target ? [args.target] : ['memory', 'user']
      return targets.map(target => ({
        target,
        entries: store.entriesFor(target),
        usage: store.usage(target),
      })) as unknown as JsonObjectValue[]
    },
    presentCall: args => ({
      card: 'generic',
      title: args.target ? `查看记忆：${args.target}` : '查看全部记忆',
      kind: 'read',
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_add',
    description: '向记忆追加一条（默认 memory=我的笔记；user=用户画像）。内容会跨会话保留，应写环境事实、项目约定、用户偏好等值得长期记住的信息。超字符预算会返回合并引导错误：请先用 memory_replace/memory_remove 腾出空间，再重试。',
    parameters: {
      content: { type: 'string', required: true, description: '要记住的内容（一条）' },
      target: {
        type: 'string', enum: ['memory', 'user'],
        description: '写入哪个存储；默认 memory',
      },
    },
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => text(renderWrite(value)),
    },
    async execute(args) {
      const result = await store.add(args.target ?? 'memory', args.content)
      throwIfFailed(result)
      return {
        target: args.target ?? 'memory',
        message: result.message,
        usage: result.usage,
        entry_count: result.entry_count,
        note: result.note,
      } as JsonObjectValue
    },
    presentCall: args => ({
      card: 'generic',
      title: `记下：${args.content.slice(0, 30)}${args.content.length > 30 ? '…' : ''}`,
      kind: 'edit',
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_replace',
    description: '用新内容替换「包含 old_text 子串」的那条记忆。old_text 用该条目的短唯一子串（不必全文）；匹配到多条不同条目会报歧义，请更具体。替换后总占用超预算会返回合并引导错误。',
    parameters: {
      old_text: { type: 'string', required: true, description: '目标条目的短唯一子串' },
      new_content: { type: 'string', required: true, description: '替换后的新内容' },
      target: {
        type: 'string', enum: ['memory', 'user'],
        description: '操作哪个存储；默认 memory',
      },
    },
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => text(renderWrite(value)),
    },
    async execute(args) {
      const result = await store.replace(args.target ?? 'memory', args.old_text, args.new_content)
      throwIfFailed(result)
      return {
        target: args.target ?? 'memory',
        message: result.message,
        usage: result.usage,
        entry_count: result.entry_count,
        note: result.note,
      } as JsonObjectValue
    },
    presentCall: () => ({ card: 'generic', title: '替换记忆条目', kind: 'edit' }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_remove',
    description: '删除「包含 old_text 子串」的那条记忆。old_text 用该条目的短唯一子串；匹配到多条不同条目会报歧义，请更具体。',
    parameters: {
      old_text: { type: 'string', required: true, description: '目标条目的短唯一子串' },
      target: {
        type: 'string', enum: ['memory', 'user'],
        description: '操作哪个存储；默认 memory',
      },
    },
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => text(renderWrite(value)),
    },
    async execute(args) {
      const result = await store.remove(args.target ?? 'memory', args.old_text)
      throwIfFailed(result)
      return {
        target: args.target ?? 'memory',
        message: result.message,
        usage: result.usage,
        entry_count: result.entry_count,
        note: result.note,
      } as JsonObjectValue
    },
    presentCall: () => ({ card: 'generic', title: '删除记忆条目', kind: 'edit' }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_batch',
    description: '原子批量修改记忆：一次调用完成多个 add/replace/remove（如「删旧的 + 加新的」）。对最终预算校验，all-or-nothing：任一操作非法、不匹配或最终超限，什么都不写。',
    parameters: {
      operations: {
        type: 'array', required: true,
        description: '操作序列：{action: add|replace|remove, content?, old_text?}（action 必填；add/replace 需 content，replace/remove 需 old_text）',
        items: { type: 'object', additionalProperties: true },
      },
      target: {
        type: 'string', enum: ['memory', 'user'],
        description: '操作哪个存储；默认 memory',
      },
    },
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => text(renderWrite(value)),
    },
    async execute(args) {
      const operations = args.operations as unknown as BatchOperation[]
      const result = await store.applyBatch((args.target as MemoryTarget | undefined) ?? 'memory', operations)
      throwIfFailed(result)
      return {
        target: args.target ?? 'memory',
        message: result.message,
        usage: result.usage,
        entry_count: result.entry_count,
        note: result.note,
      } as JsonObjectValue
    },
    presentCall: () => ({ card: 'generic', title: '批量修改记忆', kind: 'edit' }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_refresh',
    description: '从磁盘重读记忆文件并重建 system prompt 快照。通常无需调用（新会话开始时会自动重建）；当用户手动编辑了 MEMORY.md/USER.md 想立即生效时使用。注意：这会改变本会话的 system prompt（打破 prefix cache），属有意操作。',
    parameters: {},
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => text(renderRefresh(value)),
    },
    async execute() {
      store.refresh()
      return {
        stores: (['memory', 'user'] as MemoryTarget[]).map(target => ({
          target,
          entries: store.entriesFor(target),
          usage: store.usage(target),
        })),
      } as unknown as JsonObjectValue
    },
    presentCall: () => ({ card: 'generic', title: '刷新记忆快照', kind: 'other' }),
  }))

  // ── 后台记忆评审（REQ-003）────────────────────────────────────────
  // 每 N 条用户消息自动触发一次隔离子代理评审，把对话中暴露的偏好/纠正/
  // 环境事实沉淀进记忆，完成后发通知。评审走同一个 MemoryStore 实例
  // （store.ts 的写路径互斥 + 锁内重读），不与主会话并发写冲突。
  const scheduler = new ReviewScheduler({
    nudgeInterval: config.nudgeInterval,
    run: (session) => runReview({ ctx, config, store, session }),
  })
  ctx.on('session/event', (session: Session, event) => {
    // 同步热路径：只计数与调度，不 await；评审与通知都在微任务中 fire-and-forget
    // （append 不可重入，见 review.ts 顶部依据）。
    scheduler.onSessionEvent(session, event)
  }, { global: true })
  ctx.on('session/disposed', (session: Session) => {
    scheduler.onSessionDisposed(session)
  }, { global: true })
}
