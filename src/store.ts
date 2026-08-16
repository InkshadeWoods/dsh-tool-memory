/**
 * MemoryStore —— Hermes memory_tool.py 的 TypeScript 移植。
 *
 * 双存储、纯文本、有界记忆：
 *   - MEMORY.md：代理自己的笔记（环境事实、项目约定、工具怪癖）
 *   - USER.md：代理对用户的了解（偏好、沟通风格、工作习惯）
 *
 * 核心设计（与 Hermes 一致）：
 *   - 条目以 `\n§\n` 分隔，字符预算计数（与模型无关），超限引导合并后重试；
 *   - replace/remove 用「短唯一子串」匹配条目，而非全文或 ID；
 *   - 快照在加载时冻结（注入 system prompt），会话中途写入只落盘、不改快照，
 *     保住 prefix cache；快照在下次会话开始时重建；
 *   - 写入前在锁内重新读盘；检测外部漂移（无法 round-trip 的内容）→
 *     拒绝写入并保存 .bak.<ts> 快照（绝不静默丢弃外部写入）；
 *   - 文件写入用「临时文件 + 原子 rename」，读者永远看到完整旧文件或完整新文件。
 *
 * 与 Hermes 的差异（有意为之，README 有说明）：
 *   - 进程内串行化用 promise 互斥，跨进程由原子 rename + 漂移保护兜底
 *     （Hermes 用 fcntl 锁文件，Node 无标准等价物，且 DSH 单进程已覆盖主要场景）；
 *   - 没有每回合合并失败上限（Hermes issue #42405 的循环保护，DSH 工具调用
 *     模型侧自带预算约束）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { firstThreatMessage, scanThreats } from './threat.ts'

export type MemoryTarget = 'memory' | 'user'

export interface StoreLimits {
  /** MEMORY.md 字符预算（默认 2200，与 Hermes 一致）。 */
  memoryCharLimit?: number
  /** USER.md 字符预算（默认 1375，与 Hermes 一致）。 */
  userCharLimit?: number
}

export type BatchAction = 'add' | 'replace' | 'remove'

export interface BatchOperation {
  action: BatchAction
  /** add/replace 的内容。 */
  content?: string
  /** replace/remove 要匹配的短唯一子串。 */
  old_text?: string
}

/** 工具返回的规范结果；success=false 时由插件层转为 HarnessError 抛给模型。 */
export interface StoreResult {
  success: boolean
  /** 成功响应的终态标记：写入已完成，模型不应重复调用。 */
  done?: boolean
  target?: string
  message?: string
  /** 成功提示：写入已完成，不要重复执行。 */
  note?: string
  /** 占用情况，如 `32% — 714/2200 chars`。 */
  usage?: string
  entry_count?: number
  /** 失败原因。 */
  error?: string
  /** 合并引导：当前全部条目（供模型决定删/并哪些）。 */
  current_entries?: string[]
  /** 子串匹配到多个不同条目的预览。 */
  matches?: string[]
  /** 漂移保护：外部内容快照路径。 */
  drift_backup?: string
  /** 漂移恢复指引。 */
  remediation?: string
}

export const ENTRY_DELIMITER = '\n§\n'

/** 快照块的 46 字符分隔线（Hermes 同款）。 */
export const BLOCK_SEPARATOR = '═'.repeat(46)

/** system-prompt 快照块标题。 */
export const BLOCK_HEADERS: Record<MemoryTarget, string> = {
  memory: 'MEMORY（我的笔记）',
  user: 'USER PROFILE（用户画像）',
}

/**
 * 首次使用引导（初始化模式）：用户画像为空时注入 system prompt，
 * 引导用户做一次简短自我介绍；画像有内容后自动消失（初始化完成），
 * 无需删除任何文件——判据就是「USER.md 是否为空」。
 */
export const ONBOARDING_TEXT = [
  '【记忆初始化 · 仅首次】你的用户画像（USER.md）还是空的。为了让后续对话更贴合你，请简单说几句（一两句即可）：',
  '1. 怎么称呼你？',
  '2. 你主要做什么工作 / 最近在做什么项目？',
  '3. 有什么沟通或工作偏好？（语言、风格、习惯等）',
  '我会把回答整理进用户画像并只记录这一次；画像有内容后，本引导不再出现。暂时不想介绍就回复「跳过」——我会在下次会话再问。',
].join('\n')

/** 快照渲染时替换威胁条目的占位符前缀。 */
const BLOCKED_PREFIX = '[BLOCKED:'

/** system prompt 的 `{{variable}}` 插值转义：在花括号间插入零宽空格，破坏 `{{` 字面量。 */
export function escapePromptText(text: string): string {
  return text.replace(/\{\{/g, '{\u200B{')
}

// ---------------------------------------------------------------------------
// 文件读写：原子写 + 严格读（区分「不存在」与「读失败」）
// ---------------------------------------------------------------------------

function filePath(dir: string, target: MemoryTarget): string {
  return join(dir, target === 'user' ? 'USER.md' : 'MEMORY.md')
}

/** 读原始文本，返回 (raw, ok)。ok=false 仅当文件存在但读不了（绝不视为空库）。 */
function readRawChecked(path: string): { raw: string; ok: boolean } {
  try {
    const text = readFileSync(path, 'utf8')
    return { raw: text.replace(/^\uFEFF/, ''), ok: true } // utf-8-sig：剥 BOM
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { raw: '', ok: true }
    return { raw: '', ok: false }
  }
}

/** 解析条目：按分隔符切分（兼容 CRLF/LF 行尾——Windows 端写入方可能产生 \r\n§\r\n 分隔）、strip、去空。 */
export function parseEntries(raw: string): string[] {
  if (!raw.trim()) return []
  return raw
    .split(/\r?\n§\r?\n/)
    .map(entry => entry.replace(/\r\n/g, '\n').trim())
    .filter(entry => entry.length > 0)
}

/** 原子写：同目录临时文件 + rename，读者永远看到完整文件。 */
function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
}

// ---------------------------------------------------------------------------

export class MemoryStore {
  /** 记忆文件目录（MEMORY.md / USER.md 所在）。 */
  readonly dir: string
  private readonly memoryCharLimit: number
  private readonly userCharLimit: number

  /** 活状态（工具响应反映它）；原始文本，含被快照屏蔽的条目。 */
  private memoryEntries: string[] = []
  private userEntries: string[] = []

  /** 冻结快照（进入 system prompt 的版本）；加载后不再变动，直到下次 loadFromDisk。 */
  private snapshot: Record<MemoryTarget, string> = { memory: '', user: '' }

  /** 进程内写串行化（同一进程内多个 agent 并发写记忆）。 */
  private lockChain: Promise<unknown> = Promise.resolve()

  constructor(dir: string, limits: StoreLimits = {}) {
    this.dir = dir
    this.memoryCharLimit = limits.memoryCharLimit ?? 2200
    this.userCharLimit = limits.userCharLimit ?? 1375
  }

  // -- 查询 ---------------------------------------------------------

  entriesFor(target: MemoryTarget): string[] {
    return target === 'user' ? this.userEntries : this.memoryEntries
  }

  /** 字符预算（整个存储，含分隔符，与 Hermes 一致）。 */
  charLimit(target: MemoryTarget): number {
    return target === 'user' ? this.userCharLimit : this.memoryCharLimit
  }

  charCount(target: MemoryTarget): number {
    const entries = this.entriesFor(target)
    return entries.length === 0 ? 0 : entries.join(ENTRY_DELIMITER).length
  }

  usage(target: MemoryTarget): string {
    const current = this.charCount(target)
    const limit = this.charLimit(target)
    const pct = Math.min(100, Math.round((current / limit) * 100))
    return `${pct}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars`
  }

  /** 冻结快照块文本；空存储返回 ''（装配时该 section 不贡献内容）。 */
  snapshotText(target: MemoryTarget): string {
    return this.snapshot[target]
  }

  /**
   * 首次使用引导文本：用户画像为空时返回引导（注入 system prompt），
   * 画像有内容后返回 ''（引导自动消失，即「初始化文档已删除」）。
   * 刻意读活状态而非冻结快照：用户在本会话回答后引导立即消失，
   * 不需要等快照重建。
   */
  onboardingPrompt(): string {
    return this.userEntries.length === 0 ? ONBOARDING_TEXT : ''
  }

  // -- 加载与快照 -----------------------------------------------------

  /**
   * 从磁盘读取两个存储，重建冻结快照。
   * 读取是只读路径，读失败按空处理（无害）；威胁条目在快照中被占位符
   * 替换，但活状态保留原文，用户可检查并删除。
   */
  loadFromDisk(): void {
    this.memoryEntries = this.readEntries('memory')
    this.userEntries = this.readEntries('user')
    this.snapshot = {
      memory: this.renderBlock('memory'),
      user: this.renderBlock('user'),
    }
  }

  /**
   * 同 loadFromDisk：手动/新会话开始时重建快照。
   * 刻意保持同步——session/created 的 emit 不等待 listener，若这里是异步，
   * 紧随其后的 assemble 会在微任务队列刷新前读到旧快照（竞态）。
   * 只读路径不需要互斥；写操作在锁内自行重读磁盘，不存在脏读写回。
   */
  refresh(): void {
    this.loadFromDisk()
  }

  private readEntries(target: MemoryTarget): string[] {
    const { raw, ok } = readRawChecked(filePath(this.dir, target))
    if (!ok) return [] // 只读路径：读失败按空处理，不会写回
    return [...new Set(parseEntries(raw))] // 去重，保序，留首现
  }

  /** 渲染 system-prompt 块：标题 + 占用指示 + 条目；威胁条目替换为占位符。 */
  private renderBlock(target: MemoryTarget): string {
    const entries = this.entriesFor(target)
    if (entries.length === 0) return ''
    const sanitized = entries.map((entry) => {
      if (!entry || entry.startsWith(BLOCKED_PREFIX)) return entry
      const hits = scanThreats(entry)
      if (hits.length === 0) return entry
      return (
        `${BLOCKED_PREFIX} ${target === 'user' ? 'USER.md' : 'MEMORY.md'} 条目包含威胁模式` +
        `（${hits.join(', ')}），已从 system prompt 移除；` +
        '可用 memory_remove 删除原条目。]'
      )
    })
    const content = escapePromptText(sanitized.join(ENTRY_DELIMITER))
    const current = content.length
    const limit = this.charLimit(target)
    const pct = Math.min(100, Math.round((current / limit) * 100))
    const header = `${BLOCK_HEADERS[target]} [${pct}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars]`
    return `${BLOCK_SEPARATOR}\n${header}\n${BLOCK_SEPARATOR}\n${content}`
  }

  // -- 写操作 ---------------------------------------------------------

  /**
   * 追加一条。超出预算返回合并引导错误；重复条目幂等返回成功。
   * append-only 路径跳过漂移保护（追加不会覆盖既有内容）。
   */
  add(target: MemoryTarget, content: string): Promise<StoreResult> {
    return this.withLock(async () => {
      const clean = content.trim()
      if (!clean) return fail('内容不能为空。')

      const threat = firstThreatMessage(clean)
      if (threat) return fail(threat)

      // 锁内重新读盘，拾取其他会话的写入；不可读则拒绝（绝不把「读不了」当「空」覆写）。
      const reload = this.reloadTarget(target, { skipDrift: true })
      if (!reload.ok) return readFailedResult(filePath(this.dir, target))

      const entries = this.entriesFor(target)
      if (entries.includes(clean)) {
        return success(target, this, '条目已存在（未重复添加）。')
      }
      const total = [...entries, clean].join(ENTRY_DELIMITER).length
      const limit = this.charLimit(target)
      if (total > limit) {
        return this.consolidationError(
          target,
          `内存已达 ${this.usage(target)}。添加这条（${clean.length} 字符）会超限。` +
            '请先用 replace 合并重叠条目或 remove 删除过时条目腾出空间（见下方当前条目），然后本轮内重试 add。',
        )
      }
      this.setEntries(target, [...entries, clean])
      this.save(target)
      return success(target, this, '条目已添加。')
    })
  }

  /** 用新内容替换「包含 oldText 子串」的条目。 */
  replace(target: MemoryTarget, oldText: string, newContent: string): Promise<StoreResult> {
    return this.withLock(async () => {
      const oldTextClean = oldText.trim()
      const newClean = newContent.trim()
      if (!oldTextClean) return fail("replace 需要 old_text（要替换条目的短唯一子串）。")
      if (!newClean) return fail('new_content 不能为空；删除条目请用 remove。')

      const threat = firstThreatMessage(newClean)
      if (threat) return fail(threat)

      const reload = this.reloadTarget(target)
      if (!reload.ok) return readFailedResult(filePath(this.dir, target))
      if (reload.driftBackup) return driftResult(reload.driftBackup)

      const entries = this.entriesFor(target)
      const matched = matchEntries(entries, oldTextClean)
      if (!matched) return this.noMatchError(target, oldTextClean, 'replace')
      if (matched.multiple) return this.multipleMatchError(target, matched.matches, 'replace')

      const idx = matched.index
      const test = [...entries]
      test[idx] = newClean
      const total = test.join(ENTRY_DELIMITER).length
      const limit = this.charLimit(target)
      if (total > limit) {
        return this.consolidationError(
          target,
          `替换后内存将达 ${total.toLocaleString()}/${limit.toLocaleString()} chars，超限。` +
            '请缩短新内容，或用 remove 删除其他过时条目腾出空间（见下方当前条目），然后本轮内重试 replace。',
        )
      }
      test[idx] = newClean
      this.setEntries(target, test)
      this.save(target)
      return success(target, this, '条目已替换。')
    })
  }

  /** 删除包含 oldText 子串的条目。 */
  remove(target: MemoryTarget, oldText: string): Promise<StoreResult> {
    return this.withLock(async () => {
      const oldTextClean = oldText.trim()
      if (!oldTextClean) return fail('remove 需要 old_text（要删除条目的短唯一子串）。')

      const reload = this.reloadTarget(target)
      if (!reload.ok) return readFailedResult(filePath(this.dir, target))
      if (reload.driftBackup) return driftResult(reload.driftBackup)

      const entries = this.entriesFor(target)
      const matched = matchEntries(entries, oldTextClean)
      if (!matched) return this.noMatchError(target, oldTextClean, 'remove')
      if (matched.multiple) return this.multipleMatchError(target, matched.matches, 'remove')

      const idx = matched.index
      const next = [...entries]
      next.splice(idx, 1)
      this.setEntries(target, next)
      this.save(target)
      return success(target, this, '条目已删除。')
    })
  }

  /**
   * 原子批量：add/replace/remove 序列一次性应用，对「最终预算」校验。
   * all-or-nothing：任一操作非法、不匹配或最终超限，什么都不写。
   * 这样模型可以在一次调用里完成「删旧的 + 加新的」，免去多轮合并舞蹈。
   */
  applyBatch(target: MemoryTarget, operations: BatchOperation[]): Promise<StoreResult> {
    return this.withLock(async () => {
      if (operations.length === 0) return fail('operations 不能为空。')

      for (const [i, op] of operations.entries()) {
        if (op.action !== 'add' && op.action !== 'replace' && op.action !== 'remove') {
          return fail(`第 ${i + 1} 个操作：未知 action（应为 add/replace/remove）。`)
        }
        if ((op.action === 'add' || op.action === 'replace') && op.content?.trim()) {
          const threat = firstThreatMessage(op.content.trim())
          if (threat) return fail(`第 ${i + 1} 个操作：${threat}`)
        }
      }

      const reload = this.reloadTarget(target)
      if (!reload.ok) return readFailedResult(filePath(this.dir, target))
      if (reload.driftBackup) return driftResult(reload.driftBackup)

      const working = [...this.entriesFor(target)]
      const limit = this.charLimit(target)
      for (const [i, op] of operations.entries()) {
        const pos = `第 ${i + 1} 个操作（${op.action}）`
        const content = (op.content ?? '').trim()
        const oldText = (op.old_text ?? '').trim()

        if (op.action === 'add') {
          if (!content) return this.batchError(target, `${pos}：content 必填。`, working)
          if (working.includes(content)) continue // 幂等：重复添加跳过，不使整批失败
          working.push(content)
        } else if (op.action === 'replace') {
          if (!oldText) return this.batchError(target, `${pos}：old_text 必填。`, working)
          if (!content) return this.batchError(target, `${pos}：content 必填（删除用 remove）。`, working)
          const matched = matchEntries(working, oldText)
          if (!matched) return this.batchError(target, `${pos}：没有条目匹配「${oldText}」。`, working)
          if (matched.multiple) return this.batchError(target, `${pos}：「${oldText}」匹配多个不同条目，请更具体。`, working)
          working[matched.index] = content
        } else {
          if (!oldText) return this.batchError(target, `${pos}：old_text 必填。`, working)
          const matched = matchEntries(working, oldText)
          if (!matched) return this.batchError(target, `${pos}：没有条目匹配「${oldText}」。`, working)
          if (matched.multiple) return this.batchError(target, `${pos}：「${oldText}」匹配多个不同条目，请更具体。`, working)
          working.splice(matched.index, 1)
        }
      }

      const total = working.length === 0 ? 0 : working.join(ENTRY_DELIMITER).length
      if (total > limit) {
        return this.consolidationError(
          target,
          `应用全部 ${operations.length} 个操作后内存将达 ${total.toLocaleString()}/${limit.toLocaleString()} chars，超限。` +
            '请在同一个 batch 里再删/缩短一些条目（见下方当前条目），然后重试。',
        )
      }
      this.setEntries(target, working)
      this.save(target)
      return success(target, this, `已应用 ${operations.length} 个操作。`)
    })
  }

  // -- 内部 -----------------------------------------------------------

  private setEntries(target: MemoryTarget, entries: string[]): void {
    if (target === 'user') this.userEntries = entries
    else this.memoryEntries = entries
  }

  private save(target: MemoryTarget): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileAtomic(filePath(this.dir, target), this.entriesFor(target).join(ENTRY_DELIMITER))
  }

  /** 锁内重读磁盘；返回漂移备份路径（replace/remove/batch 必须中止）或读失败标记。 */
  private reloadTarget(
    target: MemoryTarget,
    opts: { skipDrift?: boolean } = {},
  ): { ok: boolean; driftBackup?: string } {
    const path = filePath(this.dir, target)
    const { raw, ok } = readRawChecked(path)
    if (!ok) return { ok: false }
    const driftBackup = opts.skipDrift ? undefined : this.detectDrift(target, raw)
    this.setEntries(target, [...new Set(parseEntries(raw))])
    return { ok: true, driftBackup }
  }

  /**
   * 漂移检测：磁盘内容无法被工具 round-trip（外部用编辑器/脚本追加了自由格式），
   * 或存在超过整个存储预算的单条（外部自由格式会被工具当作一条）。
   * 发现即把原始内容快照到 .bak.<ts> 并拒绝本次写入，绝不静默丢弃。
   */
  private detectDrift(target: MemoryTarget, raw: string): string | undefined {
    if (!raw.trim()) return undefined
    const parsed = parseEntries(raw)
    const roundtrip = parsed.join(ENTRY_DELIMITER)
    // CRLF 原文与规范化（LF）写出格式比较前先统一行尾，否则 CRLF 文件恒判漂移
    const normalized = raw.trim().replace(/\r\n/g, '\n')
    const maxEntry = parsed.reduce((max, e) => Math.max(max, e.length), 0)
    const drifted = normalized !== roundtrip || maxEntry > this.charLimit(target)
    if (!drifted) return undefined
    const bak = `${filePath(this.dir, target)}.bak.${Math.floor(Date.now() / 1000)}`
    try {
      writeFileAtomic(bak, raw)
    } catch {
      return `${bak} (备份失败——磁盘文件未改动)`
    }
    return bak
  }

  /** 每回合合并失败保护：不实现 Hermes 的计数器，但成功响应是终态的（见 success）。 */
  private consolidationError(target: MemoryTarget, error: string): StoreResult {
    return {
      success: false,
      error,
      current_entries: this.entriesFor(target),
      usage: this.usage(target),
    }
  }

  private noMatchError(target: MemoryTarget, oldText: string, action: string): StoreResult {
    return {
      success: false,
      error: `没有条目匹配「${oldText}」。请对照下方 current_entries，用其中某条的唯一子串重试 ${action}。`,
      current_entries: this.entriesFor(target),
      usage: this.usage(target),
    }
  }

  private multipleMatchError(target: MemoryTarget, matches: string[], action: string): StoreResult {
    return {
      success: false,
      error: `「匹配多个不同条目」：请用更具体的子串重试 ${action}。`,
      matches: matches.map(e => preview(e)),
      current_entries: this.entriesFor(target),
      usage: this.usage(target),
    }
  }

  /** 批量中止错误：报告活状态（未提交）与真实预算。 */
  private batchError(target: MemoryTarget, error: string, working: string[]): StoreResult {
    const current = working.length === 0 ? 0 : working.join(ENTRY_DELIMITER).length
    return {
      success: false,
      error: error + ' 整批未应用（all-or-nothing）。',
      current_entries: working,
      usage: `${current.toLocaleString()}/${this.charLimit(target).toLocaleString()} chars`,
    }
  }

  private withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.lockChain.then(fn, fn)
    this.lockChain = run.catch(() => undefined)
    return run
  }
}

// ---------------------------------------------------------------------------
// 工具函数与结果构造
// ---------------------------------------------------------------------------

function fail(error: string): StoreResult {
  return { success: false, error }
}

function readFailedResult(path: string): StoreResult {
  return {
    success: false,
    error:
      `拒绝写入 ${path}：文件存在但当前无法读取（被其他程序锁定、权限变化或编码损坏）。` +
      '把「读不了的库」当成空库保存会抹掉全部记忆，因此本次写入被拒绝，磁盘未改动，请稍后重试。',
  }
}

function driftResult(bak: string): StoreResult {
  return {
    success: false,
    error:
      '拒绝写入：磁盘上的记忆文件包含无法通过记忆工具 round-trip 的内容' +
      '（可能由外部编辑器、脚本或并发会话追加）。' +
      `已把原始内容快照到 ${bak}。请先解决漂移——把文件整理成干净的 § 分隔条目列表，` +
      '或用 memory_add 把 .bak 里的内容逐条补回——然后重试。该保护防止静默数据丢失。',
    drift_backup: bak,
    remediation:
      `打开 ${bak}，把缺失条目通过 memory_add 逐条补回，然后把原文件整理成干净状态（或用 memory_remove 处理多余内容）。`,
  }
}

/** 成功响应是终态的：确认写入、报占用，不回显条目列表（避免模型「找更多可改的」而重复调用）。 */
function success(target: MemoryTarget, store: MemoryStore, message: string): StoreResult {
  return {
    success: true,
    done: true,
    target,
    usage: store.usage(target),
    entry_count: store.entriesFor(target).length,
    message,
    note: '写入已完成，本操作到此为止，不要重复执行。',
  }
}

function preview(entry: string, width = 80): string {
  return entry.length > width ? `${entry.slice(0, width)}…` : entry
}

interface MatchResult {
  index: number
  /** 命中多个且内容各不相同。 */
  multiple: boolean
  matches: string[]
}

/** 子串匹配：唯一命中返回 index；多个相同内容视为一个（操作第一个）；多个不同内容报歧义。 */
function matchEntries(entries: string[], oldText: string): MatchResult | null {
  const matches = entries
    .map((entry, index) => ({ entry, index }))
    .filter(m => m.entry.includes(oldText))
  if (matches.length === 0) return null
  const uniqueTexts = new Set(matches.map(m => m.entry))
  const multiple = uniqueTexts.size > 1
  return { index: matches[0]!.index, multiple, matches: matches.map(m => m.entry) }
}
