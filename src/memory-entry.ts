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
  kind?: MemoryEntryKind
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

function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
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
  return {
    metadata: {
      id: record.id as string | undefined,
      kind: record.kind as MemoryEntryKind | undefined,
      inject: record.inject as MemoryEntryInject | undefined,
      priority: record.priority as MemoryEntryPriority | undefined,
      status: record.status as MemoryEntryStatus | undefined,
      scope: record.scope as MemoryEntryScope | undefined,
      tags: record.tags as string[] | undefined,
      updated_at: record.updated_at as string | undefined,
      valid_until: record.valid_until as string | undefined,
      supersedes: record.supersedes as string | undefined,
      summary: record.summary as string | undefined,
    },
  }
}

/** 将 metadata 嵌入同一条记录；不生成嵌套 § 分隔符。 */
export function serializeMemoryEntry(content: string, metadata?: MemoryEntryMetadataInput): SerializedMemoryEntry {
  const body = content.replace(/\r\n/g, '\n').trim()
  if (!body) return { error: '记忆正文不能为空。' }
  if (ENTRY_DELIMITER_PATTERN.test(body)) return { error: '一条记忆正文不能包含独占行“§”；请拆为多个独立写入。' }
  if (!metadata || Object.keys(metadata).length === 0) return { content: body }

  const id = metadata.id?.trim()
  if (id !== undefined && !isValidId(id)) return { error: 'metadata.id 必须是 1–80 位小写字母、数字、- 或 _，且以字母或数字开头。' }
  if (metadata.kind !== undefined && !KINDS.has(metadata.kind)) return { error: 'metadata.kind 无效。' }
  if (metadata.inject !== undefined && !INJECTS.has(metadata.inject)) return { error: 'metadata.inject 无效。' }
  if (metadata.priority !== undefined && !PRIORITIES.has(metadata.priority)) return { error: 'metadata.priority 无效。' }
  if (metadata.status !== undefined && !STATUSES.has(metadata.status)) return { error: 'metadata.status 无效。' }
  if (metadata.scope !== undefined && !SCOPES.has(metadata.scope)) return { error: 'metadata.scope 无效。' }
  if (metadata.updated_at !== undefined && !isValidDate(metadata.updated_at)) return { error: 'metadata.updated_at 必须是有效的 YYYY-MM-DD。' }
  if (metadata.valid_until !== undefined && !isValidDate(metadata.valid_until)) return { error: 'metadata.valid_until 必须是有效的 YYYY-MM-DD。' }
  if (metadata.supersedes !== undefined && !isValidId(metadata.supersedes)) return { error: 'metadata.supersedes 必须是合法的条目 id。' }
  if (metadata.summary !== undefined && (hasNewlineOrDelimiter(metadata.summary) || metadata.summary.length > 360)) {
    return { error: 'metadata.summary 必须为单行、不得含 §，且不超过 360 字符。' }
  }
  const tags = metadata.tags === undefined ? undefined : [...new Set(metadata.tags.map(tag => tag.trim().toLowerCase()).filter(Boolean))]
  if (tags?.some(tag => hasNewlineOrDelimiter(tag) || tag.length > 64)) return { error: 'metadata.tags 的每个标签必须为单行、不得含 §，且不超过 64 字符。' }

  const fields: Array<[string, string | undefined]> = [
    ['id', id], ['kind', metadata.kind], ['inject', metadata.inject], ['priority', metadata.priority],
    ['status', metadata.status], ['scope', metadata.scope], ['tags', tags === undefined ? undefined : `[${tags.join(', ')}]`],
    ['updated_at', metadata.updated_at], ['valid_until', metadata.valid_until], ['supersedes', metadata.supersedes], ['summary', metadata.summary?.trim()],
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
  header?: string
}

/** 只有连续已知字段随后紧接空行才认作 metadata，避免误解旧格式正文。 */
function splitMetadata(raw: string): SplitMetadata {
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
  if (meta.size === 0 || cursor >= lines.length || (lines[cursor] ?? '').trim() !== '') {
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

export function isDynamicEntry(entry: MemoryEntry, now = new Date()): boolean {
  return entry.inject !== 'never' && entry.status === 'active' && !dateHasPassed(entry.validUntil, now) && entry.body.length > 0
}

export function isUserCoreEntry(entry: MemoryEntry): boolean {
  return isDynamicEntry(entry) && entry.source === 'USER.md' && entry.inject === 'always' && entry.priority === 'permanent' && entry.status === 'active' && entry.scope === 'global' &&
    (entry.kind === 'identity' || entry.kind === 'preference' || entry.kind === 'workflow' || entry.kind === 'safety')
}
