/**
 * DSH 进程内的动态记忆运行时。
 *
 * 只由 USER.md / MEMORY.md 已读出的 § 条目派生 RAM 缓存；不读写文件、不创建
 * sidecar 或数据库。文件内容变更后通过 fingerprint 自动重建索引与向量缓存。
 */

import { createHash } from 'node:crypto'
import { embed, type EmbedOptions } from './embedder.ts'
import { isDynamicEntry, isUserCoreEntry, parseMemoryEntries, type MemoryEntry } from './memory-entry.ts'
import { buildRecallIndex, searchRecallIndexed, type RecallHit, type RecallIndex, type RecallSourceItem } from './retrieval.ts'

const VECTOR_BATCH_SIZE = 16
const VECTOR_TIMEOUT_MS = 6000
const DEFAULT_CANDIDATE_K = 12
const RECENT_ENTRY_LIMIT = 8

export interface RecallRuntimeInput {
  /** MemoryStore 当前已从 USER.md 读取的原始 § 条目。 */
  userEntries: readonly string[]
  /** MemoryStore 当前已从 MEMORY.md 读取的原始 § 条目。 */
  memoryEntries: readonly string[]
  query: string
  sessionId?: string
  candidateK?: number
  embeddingEnabled?: boolean
  embeddingOptions?: EmbedOptions
  embedTimeoutMs?: number
}

export interface RecallRuntimeHit {
  entry: MemoryEntry
  hit: RecallHit
}

export interface RecallRuntimeResult {
  fingerprint: string
  coreEntries: MemoryEntry[]
  hits: RecallRuntimeHit[]
}

export interface RecallRuntimeStatus {
  fingerprint?: string
  coreEntries: number
  dynamicEntries: number
  vectorState: 'idle' | 'warming' | 'ready'
}

interface CachedRecallIndex {
  fingerprint: string
  coreEntries: MemoryEntry[]
  dynamicEntries: MemoryEntry[]
  index: RecallIndex
  vectors?: Float32Array[]
  vectorWarmup?: Promise<void>
}

/**
 * 在长驻 DSH 进程中复用由共享记忆文件派生的索引。
 *
 * 调用者每个用户回合先刷新 MemoryStore，再调用 recall；本类不会保存文件路径，
 * 因而不会形成第二份持久化记忆源。
 */
export class RecallRuntime {
  private cached: CachedRecallIndex | undefined
  private readonly recentEntriesBySession = new Map<string, string[]>()

  /** 执行当前查询；任何意外异常仅返回可用的常驻核心或空结果。 */
  async recall(input: RecallRuntimeInput): Promise<RecallRuntimeResult> {
    let current: CachedRecallIndex
    try {
      current = this.currentIndex(input.userEntries, input.memoryEntries)
    } catch {
      return { fingerprint: '', coreEntries: [], hits: [] }
    }

    const coreEntries = [...current.coreEntries]
    if (!input.query.trim() || current.dynamicEntries.length === 0) {
      this.ensureVectorWarmup(current, input.embeddingEnabled === true, input.embeddingOptions)
      return { fingerprint: current.fingerprint, coreEntries, hits: [] }
    }

    const embeddingEnabled = input.embeddingEnabled === true
    this.ensureVectorWarmup(current, embeddingEnabled, input.embeddingOptions)
    try {
      const recentKeys = input.sessionId ? new Set(this.recentEntriesBySession.get(input.sessionId) ?? []) : undefined
      const hits = await searchRecallIndexed(current.index, input.query, {
        topK: Math.max(1, Math.min(20, input.candidateK ?? DEFAULT_CANDIDATE_K)),
        embedTimeoutMs: input.embedTimeoutMs,
        semanticCandidates: embeddingEnabled ? undefined : 0,
        precomputedVectors: embeddingEnabled ? current.vectors : undefined,
        recentKeys,
        embeddingOptions: input.embeddingOptions,
      })
      return {
        fingerprint: current.fingerprint,
        coreEntries,
        hits: hits.flatMap(hit => {
          const entry = current.dynamicEntries[hit.index]
          return entry === undefined ? [] : [{ entry, hit }]
        }),
      }
    } catch {
      return { fingerprint: current.fingerprint, coreEntries, hits: [] }
    }
  }

  /** 只在上下文实际写入本轮消息后调用，用于后续回合的轻度重复降权。 */
  recordInjectedEntries(sessionId: string | undefined, entries: readonly MemoryEntry[]): void {
    if (!sessionId || entries.length === 0) return
    const latest = [...new Set(entries.map(entry => entry.key).filter(Boolean))]
    if (latest.length === 0) return
    const previous = this.recentEntriesBySession.get(sessionId) ?? []
    const next = [...previous.filter(key => !latest.includes(key)), ...latest].slice(-RECENT_ENTRY_LIMIT)
    this.recentEntriesBySession.set(sessionId, next)
  }

  /** 供设置页显示不含内容、向量或密钥的运行时摘要。 */
  status(): RecallRuntimeStatus {
    if (!this.cached) return { coreEntries: 0, dynamicEntries: 0, vectorState: 'idle' }
    return {
      fingerprint: this.cached.fingerprint,
      coreEntries: this.cached.coreEntries.length,
      dynamicEntries: this.cached.dynamicEntries.length,
      vectorState: this.cached.vectors ? 'ready' : this.cached.vectorWarmup ? 'warming' : 'idle',
    }
  }

  /** 释放一个已结束会话的轻量去重状态；文件派生索引仍可被其他会话复用。 */
  clearSession(sessionId: string | undefined): void {
    if (sessionId) this.recentEntriesBySession.delete(sessionId)
  }

  private currentIndex(userEntries: readonly string[], memoryEntries: readonly string[]): CachedRecallIndex {
    const fingerprint = sourceFingerprint(userEntries, memoryEntries)
    if (this.cached?.fingerprint === fingerprint) return this.cached

    const parsedUser = parseMemoryEntries([...userEntries], 'USER.md')
    const parsedMemory = parseMemoryEntries([...memoryEntries], 'MEMORY.md')
    const coreEntries = parsedUser.filter(isUserCoreEntry)
    const dynamicEntries = [
      ...parsedUser.filter(entry => isDynamicEntry(entry) && !isUserCoreEntry(entry)),
      ...parsedMemory.filter(entry => isDynamicEntry(entry)),
    ]
    const next: CachedRecallIndex = {
      fingerprint,
      coreEntries,
      dynamicEntries,
      index: buildRecallIndex(dynamicEntries.map(asRecallSource)),
    }
    this.cached = next
    return next
  }

  private ensureVectorWarmup(current: CachedRecallIndex, enabled: boolean, embeddingOptions?: EmbedOptions): void {
    if (!enabled || current.dynamicEntries.length === 0 || current.vectors || current.vectorWarmup) return
    current.vectorWarmup = this.buildVectors(current, embeddingOptions).finally(() => {
      if (this.cached === current) current.vectorWarmup = undefined
    })
  }

  private async buildVectors(current: CachedRecallIndex, embeddingOptions?: EmbedOptions): Promise<void> {
    const vectors: Float32Array[] = []
    try {
      for (let offset = 0; offset < current.dynamicEntries.length; offset += VECTOR_BATCH_SIZE) {
        const batch = current.dynamicEntries.slice(offset, offset + VECTOR_BATCH_SIZE)
        const texts = batch.map(entry => [entry.summary ?? '', entry.body].filter(Boolean).join('\n'))
        const embeddings = await embed(texts, { ...embeddingOptions, timeoutMs: VECTOR_TIMEOUT_MS })
        if (embeddings.length !== batch.length) return
        vectors.push(...embeddings.map(vector => Float32Array.from(vector)))
      }
      if (this.cached === current && vectors.length === current.dynamicEntries.length) current.vectors = vectors
    } catch {
      // embedding 只是增强通道；下次文件变更或进程重启后可重新尝试。
    }
  }
}

function asRecallSource(entry: MemoryEntry): RecallSourceItem {
  return {
    content: entry.body,
    origin: entry.source,
    id: entry.id,
    kind: entry.kind,
    summary: entry.summary,
    tags: entry.tags,
    priority: entry.priority,
    updated_at: entry.updatedAt,
  }
}

/** 将两份文件的全部原始条目纳入指纹，使核心与动态条目都能及时失效。 */
function sourceFingerprint(userEntries: readonly string[], memoryEntries: readonly string[]): string {
  const hasher = createHash('sha256')
  for (const entry of userEntries) hasher.update(`USER.md\0${entry}\0`)
  for (const entry of memoryEntries) hasher.update(`MEMORY.md\0${entry}\0`)
  return hasher.digest('hex')
}
