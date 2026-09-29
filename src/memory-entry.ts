/**
 * 共享文件记忆的条目协议。
 *
 * USER.md 与 MEMORY.md 始终是唯一持久化真源。每个 § 段落仍是一个普通
 * 文本条目；metadata 只位于条目开头，旧客户端可继续将其当作正文读取。
 */

import { createHash } from 'node:crypto'

export type MemoryEntrySource = 'USER.md' | 'MEMORY.md'
export type MemoryEntryKind =
  | 'identity'
  | 'preference'
  | 'workflow'
  | 'safety'
  | 'project'
  | 'decision'
  | 'technical-context'
  | 'history'
  | 'unknown'
/**
 * 修复 10·L3-a：写入端可接受的 kind —— 排除解析侧专有的 `unknown`。
 *
 * `unknown` 只作为「旧格式条目缺 kind」的解析兜底出现，不是可写入值。
 * `KINDS` 白名单本来就不含它，但输入类型曾写成完整的 `MemoryEntryKind`，
 * 于是 TS 调用方写 `{kind: 'unknown'}` 能过编译、运行期才报「metadata.kind 无效」，
 * 属读写不对称。收紧后编译期即拦住。
 * 与 MCP 侧（hermes-memory-mcp/src/memory-entry.ts:30）同名同构。
 */
export type WritableEntryKind = Exclude<MemoryEntryKind, 'unknown'>
export type MemoryEntryInject = 'always' | 'retrieve' | 'never'
export type MemoryEntryPriority = 'permanent' | 'high' | 'normal' | 'low'
export type MemoryEntryStatus = 'active' | 'superseded' | 'archived'
export type MemoryEntryScope = 'global' | 'contextual'

export interface MemoryEntry {
  source: MemoryEntrySource
  index: number
  key: string
  id: string
  raw: string
  body: string
  kind: MemoryEntryKind
  inject: MemoryEntryInject
  priority: MemoryEntryPriority
  status: MemoryEntryStatus
  scope: MemoryEntryScope
  tags: string[]
  updatedAt?: string
  validUntil?: string
  supersedes?: string
  summary?: string
}

/** 写入端可选元数据；序列化后仍是同一个 § 条目的普通文本。 */
export interface MemoryEntryMetadataInput {
  id?: string
  kind?: WritableEntryKind
  inject?: MemoryEntryInject
  priority?: MemoryEntryPriority
  status?: MemoryEntryStatus
  scope?: MemoryEntryScope
  tags?: string[]
  updated_at?: string
  valid_until?: string
  supersedes?: string
  summary?: string
}

export type SerializedMemoryEntry = { content: string; error?: never } | { content?: never; error: string }
export type ParsedMetadataInput = { metadata?: MemoryEntryMetadataInput; error?: never } | { metadata?: never; error: string }

const META_KEYS = new Set([
  'id', 'kind', 'inject', 'priority', 'status', 'scope', 'tags',
  'updated_at', 'valid_until', 'supersedes', 'summary',
])
const KINDS = new Set<MemoryEntryKind>(['identity', 'preference', 'workflow', 'safety', 'project', 'decision', 'technical-context', 'history'])
const INJECTS = new Set<MemoryEntryInject>(['always', 'retrieve', 'never'])
const PRIORITIES = new Set<MemoryEntryPriority>(['permanent', 'high', 'normal', 'low'])
const STATUSES = new Set<MemoryEntryStatus>(['active', 'superseded', 'archived'])
const SCOPES = new Set<MemoryEntryScope>(['global', 'contextual'])
const ENTRY_DELIMITER_PATTERN = /(?:^|\r?\n)§(?:\r?\n|$)/

function asKnown<T extends string>(value: string | undefined, allowed: Set<T>, fallback: T): T {
  return value !== undefined && allowed.has(value as T) ? value as T : fallback
}

function parseTags(value: string | undefined): string[] {
  if (!value) return []
  const text = value.trim().replace(/^\[/, '').replace(/\]$/, '')
  return [...new Set(text.split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean))]
}

function isValidId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,79}$/.test(value)
}

/**
 * 修复 7：真正的日历校验。
 *
 * 修复前只做「格式像日期 + Date.parse 不是 NaN」，但 Date.parse 会把
 * `2026-02-30`、`2026-13-01` 这类非法日期**滚动**到次月的合法日期上
 * （V8 对 ISO 格式也这么做），因此「2026-02-30」曾被判为有效并写入——
 * valid_until 写进一个不存在的日期，语义上无法预期何时过期。
 * 改为构造 UTC 日期后逐字段回读比对：非法日期必然在回读时错位。
 *
 * 与 MCP 侧（hermes-memory-mcp/src/memory-entry.ts）的 `isValidDate` 是
 * **同名同构的独立实现**——两侧代码禁止耦合、禁止跨侧 import，只能靠
 * 行为契约保持一致。改动此处须同步核对另一侧。
 */
function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  // 正则已保证恰为 3 段数字，默认值只为满足 noUncheckedIndexedAccess：
  // 万一取不到，Date.UTC 得到 NaN → 回读比对必然不等 → 安全返回 false。
  const [y = Number.NaN, m = Number.NaN, d = Number.NaN] = value.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  )
}

function hasNewlineOrDelimiter(value: string): boolean {
  return /[\r\n]/.test(value) || value.includes('§')
}

/** 校验工具边界传入的未知 metadata，避免把任意对象带入序列化层。 */
export function parseMemoryEntryMetadata(value: unknown): ParsedMetadataInput {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'metadata 必须是对象。' }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) if (!META_KEYS.has(key)) return { error: `metadata 不支持字段「${key}」。` }
  for (const [key, field] of Object.entries(record)) {
    if (key === 'tags') continue
    if (typeof field !== 'string') return { error: `metadata.${key} 必须是字符串。` }
  }
  if (record.tags !== undefined && (!Array.isArray(record.tags) || record.tags.some(tag => typeof tag !== 'string'))) {
    return { error: 'metadata.tags 必须是字符串数组。' }
  }
  // 只收集「显式提供」的键。
  // 若把未提供的字段也以 undefined 形式放进返回对象，调用方把它当作已解析结果
  // 再喂回本函数时（store.ts 的 prepareReplacementContent 就是这样），第二遍会遍历
  // 到这些 undefined 键并撞上上面的「必须是字符串」，报出「metadata.id 必须是字符串」
  // ——而调用方根本没提供 id。只返回真实存在的键即可根除这类双重解析失败。
  const metadata: MemoryEntryMetadataInput = {}
  if (record.id !== undefined) metadata.id = record.id as string
  // 断言到 WritableEntryKind（而非完整的 MemoryEntryKind）：取值仍由 serializeMemoryEntry
  // 的 KINDS 白名单在运行期把关，这里只保证类型不宣称接受 `unknown`（修复 10·L3-a）。
  if (record.kind !== undefined) metadata.kind = record.kind as WritableEntryKind
  if (record.inject !== undefined) metadata.inject = record.inject as MemoryEntryInject
  if (record.priority !== undefined) metadata.priority = record.priority as MemoryEntryPriority
  if (record.status !== undefined) metadata.status = record.status as MemoryEntryStatus
  if (record.scope !== undefined) metadata.scope = record.scope as MemoryEntryScope
  if (record.tags !== undefined) metadata.tags = record.tags as string[]
  if (record.updated_at !== undefined) metadata.updated_at = record.updated_at as string
  if (record.valid_until !== undefined) metadata.valid_until = record.valid_until as string
  if (record.supersedes !== undefined) metadata.supersedes = record.supersedes as string
  if (record.summary !== undefined) metadata.summary = record.summary as string
  return Object.keys(metadata).length === 0 ? {} : { metadata }
}

/** 将 metadata 嵌入同一条记录；不生成嵌套 § 分隔符。 */
export function serializeMemoryEntry(content: string, metadata?: MemoryEntryMetadataInput): SerializedMemoryEntry {
  const body = content.replace(/\r\n/g, '\n').trim()
  if (!body) return { error: '记忆正文不能为空。' }
  if (ENTRY_DELIMITER_PATTERN.test(body)) return { error: '一条记忆正文不能包含独占行“§”；请拆为多个独立写入。' }
  if (!metadata || Object.keys(metadata).length === 0) return { content: body }

  // 修复 9：空串一律等同未提供。修复前 `id: ''` / `scope: ''` / `supersedes: ''`
  // 会走完 trim 得到 ''，再被 isValidId / SCOPES.has 硬拒绝，而 `summary: ''`
  // 却被 header 过滤静默丢弃——同一个空串三种命运。现在先归一化：
  // 为空即视为未提供。把变量插值成空串是常见场景，不应打断写入。
  const id = metadata.id?.trim()
  if (id !== undefined && id !== '' && !isValidId(id)) return { error: 'metadata.id 必须是 1–80 位小写字母、数字、- 或 _，且以字母或数字开头。' }
  if (metadata.kind !== undefined && !KINDS.has(metadata.kind)) return { error: 'metadata.kind 无效。' }
  if (metadata.inject !== undefined && !INJECTS.has(metadata.inject)) return { error: 'metadata.inject 无效。' }
  if (metadata.priority !== undefined && !PRIORITIES.has(metadata.priority)) return { error: 'metadata.priority 无效。' }
  if (metadata.status !== undefined && !STATUSES.has(metadata.status)) return { error: 'metadata.status 无效。' }
  // String(...) 包裹的原因：scope 声明为封闭联合 MemoryEntryScope，但工具边界
  // 传入的是任意字符串（parseMemoryEntryMetadata 只校验字段名，不校验取值），
  // 运行期确实可能是 ''。直接写 `metadata.scope !== ''` 会被 TS 判为
  // 「类型无重叠」(TS2367)，进而有被当成死代码删掉的风险——而它正是修复 9 的一半。
  if (metadata.scope !== undefined && String(metadata.scope) !== '' && !SCOPES.has(metadata.scope)) return { error: 'metadata.scope 无效。' }
  if (metadata.updated_at !== undefined && !isValidDate(metadata.updated_at)) return { error: 'metadata.updated_at 必须是有效的 YYYY-MM-DD。' }
  if (metadata.valid_until !== undefined && !isValidDate(metadata.valid_until)) return { error: 'metadata.valid_until 必须是有效的 YYYY-MM-DD。' }
  if (metadata.supersedes !== undefined && metadata.supersedes !== '' && !isValidId(metadata.supersedes)) return { error: 'metadata.supersedes 必须是合法的条目 id。' }
  if (metadata.summary !== undefined && (hasNewlineOrDelimiter(metadata.summary) || metadata.summary.length > 360)) {
    return { error: 'metadata.summary 必须为单行、不得含 §，且不超过 360 字符。' }
  }
  const tags = metadata.tags === undefined ? undefined : [...new Set(metadata.tags.map(tag => tag.trim().toLowerCase()).filter(Boolean))]
  if (tags?.some(tag => hasNewlineOrDelimiter(tag) || tag.length > 64)) return { error: 'metadata.tags 的每个标签必须为单行、不得含 §，且不超过 64 字符。' }

  const fields: Array<[string, string | undefined]> = [
    ['id', id], ['kind', metadata.kind], ['inject', metadata.inject], ['priority', metadata.priority],
    ['status', metadata.status], ['scope', metadata.scope],
    // 修复 8：空数组等同未提供。修复前空数组经 join 得到字符串 '[]'，
    // 而下一行的过滤只拦 `value !== ''`，于是输出一个 `tags: []` 头——
    // 它既不携带信息，又会让「无 tags」的条目在落盘上与携 tags 者不同。
    ['tags', tags === undefined || tags.length === 0 ? undefined : `[${tags.join(', ')}]`],
    ['updated_at', metadata.updated_at], ['valid_until', metadata.valid_until], ['supersedes', metadata.supersedes],
    // 修复 9：空串等同未提供，与 header 过滤的 `value !== ''` 口径对齐。
    ['summary', metadata.summary?.trim()],
  ]
  const header = fields.filter(([, field]) => field !== undefined && field !== '').map(([key, field]) => `${key}: ${field}`)
  return header.length === 0 ? { content: body } : { content: `${header.join('\n')}\n\n${body}` }
}

function legacyId(source: MemoryEntrySource, raw: string): string {
  return `legacy-${createHash('sha256').update(`${source}\0${raw}`).digest('hex').slice(0, 12)}`
}

interface SplitMetadata {
  meta: Map<string, string>
  body: string
  /** 原样保留的 header 文本（`key: value` 逐行）；undefined 表示无 header。 */
  header?: string
}

/**
 * 只将「开头连续的已知字段 + 空行」识别为元数据，以免把旧格式正文误判成协议。
 *
 * 导出（修复 12 方案 B 第 2 步）：`store.renderBlock` 需要在不构造完整 `MemoryEntry`
 * 的前提下判断某条原始文本是否「仅有元数据、正文缺失」，以便在快照里放异常提示
 * 占位符，而不是把 `kind: project` 这类协议文本当正文注入。复用同一函数可避免
 * 协议判定在两处各写一份而分叉。
 */
export function splitMetadata(raw: string): SplitMetadata {
  const normalized = raw.replace(/\r\n/g, '\n').trim()
  const lines = normalized.split('\n')
  const meta = new Map<string, string>()
  let cursor = 0
  while (cursor < lines.length) {
    const match = /^([a-z_]+):\s*(.*)$/i.exec(lines[cursor] ?? '')
    const key = match?.[1]?.toLowerCase()
    if (!key || !META_KEYS.has(key)) break
    meta.set(key, (match?.[2] ?? '').trim())
    cursor++
  }

  // 协议元数据必须由空行与正文隔开；否则保持旧格式的完整正文。
  //
  // 修复 12·步1：原判定 `meta.size === 0 || cursor >= lines.length || lines[cursor].trim() !== ''`
  // 把「识别到元数据但正文为空」也归入回退分支。由于 raw.trim() 已吃掉尾部空行，
  // `'kind: project\n\n'` 会变成 lines=['kind: project']、cursor=1，于是
  // `cursor >= lines.length` 为真 → 回退 → **body 变成 'kind: project'**，
  // 协议文本被当作正文注入，且 body 非空还会被判为动态条目。
  // 现在区分两种情况：只有「压根没识别到元数据」才是真·旧格式（回退全文）；
  // 「识别到元数据但无正文」返回空 body，交由上层（store.renderBlock）标记异常。
  if (meta.size === 0 || (cursor < lines.length && (lines[cursor] ?? '').trim() !== '')) {
    return { meta: new Map(), body: normalized }
  }
  const header = lines.slice(0, cursor).join('\n')
  while (cursor < lines.length && (lines[cursor] ?? '').trim() === '') cursor++
  return { meta, body: lines.slice(cursor).join('\n').trim(), header }
}

export function parseMemoryEntry(raw: string, source: MemoryEntrySource, index: number): MemoryEntry {
  const normalizedRaw = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()
  const { meta, body } = splitMetadata(normalizedRaw)
  const id = meta.get('id') || legacyId(source, normalizedRaw)
  return {
    source,
    index,
    key: `${source}:${id}`,
    id,
    raw: normalizedRaw,
    body,
    kind: asKnown(meta.get('kind'), KINDS, 'unknown'),
    inject: asKnown(meta.get('inject'), INJECTS, 'retrieve'),
    priority: asKnown(meta.get('priority'), PRIORITIES, 'normal'),
    status: asKnown(meta.get('status'), STATUSES, 'active'),
    scope: asKnown(meta.get('scope'), SCOPES, 'contextual'),
    tags: parseTags(meta.get('tags')),
    updatedAt: meta.get('updated_at'),
    validUntil: meta.get('valid_until'),
    supersedes: meta.get('supersedes'),
    summary: meta.get('summary') || undefined,
  }
}

export function parseMemoryEntries(entries: string[], source: MemoryEntrySource): MemoryEntry[] {
  const parsed = entries.map((raw, index) => parseMemoryEntry(raw, source, index))
  const lastById = new Map<string, MemoryEntry>()
  for (const entry of parsed) lastById.set(entry.id, entry)
  return parsed.filter(entry => lastById.get(entry.id) === entry)
}

/** 若未显式传 metadata，更新结构化条目正文时保留其原有 header。 */
export function replaceMemoryEntryBody(existing: string, content: string, metadata?: MemoryEntryMetadataInput): SerializedMemoryEntry {
  const explicit = serializeMemoryEntry(content, metadata)
  if (explicit.error || metadata !== undefined) return explicit
  const existingSplit = splitMetadata(existing)
  const incomingSplit = splitMetadata(content)
  if (!existingSplit.header || incomingSplit.header) return explicit
  return { content: `${existingSplit.header}\n\n${explicit.content}` }
}

function dateHasPassed(value: string | undefined, now = new Date()): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T23:59:59.999Z`)
  return !Number.isNaN(date.getTime()) && date.getTime() < now.getTime()
}

/**
 * 修复 11：防御第二参数类型。
 *
 * 原签名是 `now = new Date()`。当作为回调直接传给 `.filter()` 时，
 * `Array.prototype.filter` 会把**数组下标**（number）当作第二参传入，覆盖默认值；
 * 随后 `dateHasPassed(entry.validUntil, now)` 里调 `now.getTime()` 抛
 * `TypeError: now.getTime is not a function`。
 *
 * 触发条件隐蔽：只有批内存在 `validUntil` 非空的条目时才会走到 `now.getTime()`；
 * 若全批 `validUntil` 都为 undefined，`dateHasPassed` 提前 return，不抛错——
 * 但静默给出错误结果。
 *
 * 现在把非法的第二参一律回退为 `new Date()`：`.filter(isDynamicEntry)` 与
 * `.filter(e => isDynamicEntry(e))` 得到完全一致的结果。
 * 与 MCP 侧（hermes-memory-mcp/src/memory-entry.ts）同名同构。
 */
export function isDynamicEntry(entry: MemoryEntry, now: Date = new Date()): boolean {
  const at = now instanceof Date ? now : new Date()
  return entry.inject !== 'never' && entry.status === 'active' && !dateHasPassed(entry.validUntil, at) && entry.body.length > 0
}

export function isUserCoreEntry(entry: MemoryEntry): boolean {
  return isDynamicEntry(entry) && entry.source === 'USER.md' && entry.inject === 'always' && entry.priority === 'permanent' && entry.status === 'active' && entry.scope === 'global' &&
    (entry.kind === 'identity' || entry.kind === 'preference' || entry.kind === 'workflow' || entry.kind === 'safety')
}
