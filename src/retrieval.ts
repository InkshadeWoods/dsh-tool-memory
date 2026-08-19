/**
 * 无宿主依赖的文件记忆混合检索。
 *
 * 词法覆盖、内存 BM25、短语/标签与可选语义重排通过加权 RRF 融合；索引仅
 * 存在调用进程内。embedding 不可用时自动保留前三个本地通道，不阻断主请求。
 */

import { embed, type EmbedOptions } from './embedder.ts'

export interface RecallSourceItem {
  content: string
  origin?: string
  id?: string
  kind?: string
  summary?: string
  tags?: string[]
  priority?: 'permanent' | 'high' | 'normal' | 'low'
  updated_at?: string
}

export interface RecallHit {
  index: number
  item: RecallSourceItem
  content: string
  origin: string
  id: string
  kind: string
  tags: string[]
  cosine: number | null
  lexical: number
  bm25: number
  bm25Normalized: number
  phrase: number
  rrf: number
  source: 'hybrid' | 'semantic' | 'lexical'
}

export interface SearchOptions {
  topK?: number
  minCosine?: number
  standaloneCosine?: number
  minLexical?: number
  minBm25?: number
  embedTimeoutMs?: number
  semanticCandidates?: number
  /** 由调用方提供的全量内存向量；未提供时仅重排本地候选。 */
  precomputedVectors?: readonly Float32Array[]
  /** 当前会话近期已注入的 origin:id；只作轻微降权。 */
  recentKeys?: ReadonlySet<string>
  /** 可选 embedding 服务配置；只在语义通道启用时使用。 */
  embeddingOptions?: EmbedOptions
}

export interface Bm25Index {
  documents: Array<Map<string, number>>
  lengths: number[]
  df: Map<string, number>
  averageLength: number
}

export interface RecallIndex {
  items: RecallSourceItem[]
  bm25: Bm25Index
}

const RRF_K = 60
const MAX_QUERY_CHARS = 500
const MAX_SEMANTIC_CANDIDATES = 40
const MAX_LEXICAL_CANDIDATES = 16
const MAX_PHRASE_CANDIDATES = 8
const MAX_SEMANTIC_RESULTS = 12
const BM25_K1 = 1.5
const BM25_B = 0.75
const GENERIC_QUERY_TOKENS = new Set(['怎么', '如何', '什么', '为什', '什么是', '请问', '帮我', '一下', '可以', '是否'])

/** ASCII 技术词加中文 bigram；返回去重且稳定的 token 序列。 */
export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase()
  const tokens: string[] = []
  for (const word of normalized.match(/[a-z0-9][a-z0-9_.\-/]+/g) ?? []) tokens.push(word)
  for (const segment of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (segment.length === 1) tokens.push(segment)
    else for (let index = 0; index < segment.length - 1; index++) tokens.push(segment.slice(index, index + 2))
  }
  return [...new Set(tokens.filter(token => !GENERIC_QUERY_TOKENS.has(token)))]
}

function textTokens(item: RecallSourceItem): string[] {
  const tags = (item.tags ?? []).flatMap(tag => Array(2).fill(tokenize(tag))).flat()
  const summary = Array(2).fill(tokenize(item.summary ?? '')).flat()
  return [...tags, ...summary, ...tokenize(item.content ?? '')]
}

function containsToken(text: string, token: string): boolean {
  return text.toLowerCase().includes(token)
}

/** token 覆盖率与中文 bigram 覆盖率的组合，范围为 0 到 1。 */
export function lexicalScore(queryTokens: string[], item: RecallSourceItem): number {
  if (queryTokens.length === 0) return 0
  const searchable = [item.tags?.join(' ') ?? '', item.summary ?? '', item.content ?? ''].join('\n').toLowerCase()
  let allHits = 0
  let cjkTotal = 0
  let cjkHits = 0
  for (const token of queryTokens) {
    const hit = containsToken(searchable, token)
    if (hit) allHits++
    if (/^[\u4e00-\u9fff]{1,2}$/.test(token)) {
      cjkTotal++
      if (hit) cjkHits++
    }
  }
  const coverage = allHits / queryTokens.length
  return cjkTotal === 0 ? coverage : 0.7 * coverage + 0.3 * (cjkHits / cjkTotal)
}

function buildBm25Index(items: RecallSourceItem[]): Bm25Index {
  const documents = items.map(item => {
    const document = new Map<string, number>()
    for (const token of textTokens(item)) document.set(token, (document.get(token) ?? 0) + 1)
    return document
  })
  const df = new Map<string, number>()
  for (const document of documents) for (const token of document.keys()) df.set(token, (df.get(token) ?? 0) + 1)
  const lengths = documents.map(document => [...document.values()].reduce((sum, value) => sum + value, 0))
  const averageLength = lengths.length === 0 ? 0 : lengths.reduce((sum, value) => sum + value, 0) / lengths.length
  return { documents, lengths, df, averageLength }
}

/** 构建可被长期运行时复用的纯内存索引；调用方可随时丢弃后重建。 */
export function buildRecallIndex(items: RecallSourceItem[]): RecallIndex {
  return { items: [...items], bm25: buildBm25Index(items) }
}

function bm25Score(index: Bm25Index, documentIndex: number, queryTokens: string[]): number {
  const document = index.documents[documentIndex]
  const length = index.lengths[documentIndex] ?? 0
  if (!document || length === 0 || index.averageLength === 0) return 0

  let score = 0
  for (const token of queryTokens) {
    const tf = document.get(token) ?? 0
    const df = index.df.get(token) ?? 0
    if (tf === 0 || df === 0) continue
    const idf = Math.log(1 + (index.documents.length - df + 0.5) / (df + 0.5))
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (length / index.averageLength))
    score += idf * ((tf * (BM25_K1 + 1)) / denominator)
  }
  return score
}

function normalizedBm25(score: number): number {
  return score <= 0 ? 0 : score / (score + 1.5)
}

function extractStrongTerms(query: string): string[] {
  const terms = new Set<string>()
  for (const quoted of query.matchAll(/[`'“”"]([^`'“”"]{2,80})[`'“”"]/g)) {
    const term = quoted[1]?.toLowerCase()
    if (term) terms.add(term)
  }
  for (const token of query.toLowerCase().match(/[a-z0-9][a-z0-9_.\-/]+/g) ?? []) {
    if (token.length >= 3 || /[._/-]/.test(token)) terms.add(token)
  }
  return [...terms]
}

/**
 * 带连字符、路径分隔符或点号的技术 token 是比通用中文 bigram 更可靠的锚点。
 * 当查询显式给出这类锚点时，候选必须包含其中至少一个，避免“任务”“运行”等
 * 泛词把无关条目抬进有限的动态注入预算。
 */
function extractAnchorTerms(query: string): string[] {
  return [...new Set(
    (query.toLowerCase().match(/[a-z0-9][a-z0-9_.\-/]+/g) ?? [])
      // `memory_*` 是常见的工具禁止语句，不是业务检索锚点；把它纳入会让
      // 任何提及记忆工具的普通工作流条目挤占明确技术条目的注入名额。
      .filter(token => /[._/-]/.test(token) && token !== 'memory_'),
  )]
}

function matchesAnchorTerm(item: RecallSourceItem, anchorTerms: readonly string[]): boolean {
  if (anchorTerms.length === 0) return true
  const searchable = [item.tags?.join(' ') ?? '', item.summary ?? '', item.content ?? ''].join('\n').toLowerCase()
  return anchorTerms.some(term => searchable.includes(term))
}

function phraseAndTagScore(query: string, item: RecallSourceItem): number {
  const lowerQuery = query.toLowerCase()
  const body = [item.summary ?? '', item.content ?? ''].join('\n').toLowerCase()
  let score = 0
  for (const tag of item.tags ?? []) if (lowerQuery.includes(tag.toLowerCase())) score += 1
  for (const term of extractStrongTerms(query)) if (body.includes(term)) score += 0.75
  return score
}

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftMagnitude += leftValue * leftValue
    rightMagnitude += rightValue * rightValue
  }
  return leftMagnitude === 0 || rightMagnitude === 0 ? 0 : dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude))
}

function rankMap(scored: Array<{ index: number; score: number }>): Map<number, number> {
  const ranks = new Map<number, number>()
  scored.forEach((entry, offset) => ranks.set(entry.index, offset + 1))
  return ranks
}

function freshnessAdjustment(updatedAt: string | undefined): number {
  if (!updatedAt || !/^\d{4}-\d{2}-\d{2}$/.test(updatedAt)) return 0
  const timestamp = Date.parse(`${updatedAt}T00:00:00Z`)
  if (Number.isNaN(timestamp)) return 0
  const ageDays = (Date.now() - timestamp) / 86_400_000
  return ageDays >= 0 && ageDays <= 90 ? 0.001 : 0
}

function priorityAdjustment(priority: RecallSourceItem['priority']): number {
  if (priority === 'high') return 0.002
  if (priority === 'low') return -0.001
  return 0
}

/** 对条目执行多通道检索；没有强相关证据时返回空数组而不是尾部回退。 */
export async function searchRecall(
  items: RecallSourceItem[],
  query: string,
  options: SearchOptions = {},
): Promise<RecallHit[]> {
  return searchRecallIndexed(buildRecallIndex(items), query, options)
}

/** 使用预建索引检索；预计算向量存在时可成为独立的语义召回通道。 */
export async function searchRecallIndexed(
  recallIndex: RecallIndex,
  query: string,
  options: SearchOptions = {},
): Promise<RecallHit[]> {
  const items = recallIndex.items
  const topK = Math.max(1, Math.min(20, options.topK ?? 3))
  const minLexical = options.minLexical ?? 0.12
  const minBm25 = options.minBm25 ?? 0.18
  const minCosine = options.minCosine ?? 0.55
  const standaloneCosine = options.standaloneCosine ?? 0.7
  const semanticCap = options.semanticCandidates === undefined
    ? MAX_SEMANTIC_CANDIDATES
    : Math.max(0, options.semanticCandidates)
  const trimmed = query.trim().slice(0, MAX_QUERY_CHARS)
  if (!trimmed || items.length === 0) return []

  const queryTokens = tokenize(trimmed)
  if (queryTokens.length === 0) return []
  const anchorTerms = extractAnchorTerms(trimmed)

  const lexicalRanked = items
    .map((item, index) => ({ index, score: lexicalScore(queryTokens, item) }))
    .filter(entry => entry.score >= minLexical)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_LEXICAL_CANDIDATES)
  const bm25Ranked = items
    .map((_item, itemIndex) => {
      const score = bm25Score(recallIndex.bm25, itemIndex, queryTokens)
      return { index: itemIndex, score, normalized: normalizedBm25(score) }
    })
    .filter(entry => entry.normalized >= minBm25)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_LEXICAL_CANDIDATES)
  const phraseRanked = items
    .map((item, index) => ({ index, score: phraseAndTagScore(trimmed, item) }))
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_PHRASE_CANDIDATES)

  const lexicalByIndex = new Map(lexicalRanked.map(entry => [entry.index, entry.score]))
  const bm25ByIndex = new Map(bm25Ranked.map(entry => [entry.index, entry]))
  const phraseByIndex = new Map(phraseRanked.map(entry => [entry.index, entry.score]))
  const semanticCandidates = [...new Set([...lexicalRanked, ...bm25Ranked, ...phraseRanked].map(entry => entry.index))].slice(0, semanticCap)
  const semanticByIndex = new Map<number, number>()

  const precomputedVectors = options.precomputedVectors
  if (precomputedVectors !== undefined && precomputedVectors.length === items.length) {
    try {
      const [queryEmbedding] = await embed([trimmed], { ...options.embeddingOptions, timeoutMs: options.embedTimeoutMs ?? 1800 })
      const queryVector = Float32Array.from(queryEmbedding ?? [])
      precomputedVectors.forEach((vector, index) => {
        const score = cosine(queryVector, vector)
        if (score >= minCosine) semanticByIndex.set(index, score)
      })
    } catch {
      // 语义增强不可用时，本地词法、BM25 与短语通道仍可完成召回。
    }
  } else if (semanticCandidates.length > 0) {
    try {
      const semanticItems = semanticCandidates.flatMap(itemIndex => {
        const item = items[itemIndex]
        return item === undefined ? [] : [{ itemIndex, item }]
      })
      if (semanticItems.length > 0) {
        const texts = [trimmed, ...semanticItems.map(({ item }) => [item.summary ?? '', item.content].filter(Boolean).join('\n'))]
        const vectors = await embed(texts, { ...options.embeddingOptions, timeoutMs: options.embedTimeoutMs ?? 1800 })
        const queryVector = Float32Array.from(vectors[0] ?? [])
        semanticItems.forEach(({ itemIndex }, offset) => {
          const score = cosine(queryVector, Float32Array.from(vectors[offset + 1] ?? []))
          if (score >= minCosine) semanticByIndex.set(itemIndex, score)
        })
      }
    } catch {
      // 在线重排失败不会影响本轮的纯本地候选。
    }
  }

  const lexicalRanks = rankMap(lexicalRanked)
  const bm25Ranks = rankMap(bm25Ranked)
  const phraseRanks = rankMap(phraseRanked)
  const semanticRanked = [...semanticByIndex.entries()]
    .map(([index, score]) => ({ index, score }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_SEMANTIC_RESULTS)
  const semanticRanks = rankMap(semanticRanked)
  const candidates = new Set<number>([...lexicalRanks.keys(), ...bm25Ranks.keys(), ...phraseRanks.keys(), ...semanticRanks.keys()])

  const hits: RecallHit[] = []
  for (const itemIndex of candidates) {
    const item = items[itemIndex]
    if (item === undefined) continue
    const lexical = lexicalByIndex.get(itemIndex) ?? 0
    const bm25 = bm25ByIndex.get(itemIndex)?.score ?? 0
    const bm25Normalized = bm25ByIndex.get(itemIndex)?.normalized ?? 0
    const phrase = phraseByIndex.get(itemIndex) ?? 0
    const semantic = semanticByIndex.get(itemIndex) ?? null
    const strongEvidence = phrase > 0 || lexical >= 0.22 || bm25Normalized >= 0.3 ||
      (semantic !== null && (semantic >= standaloneCosine || (semantic >= 0.6 && lexical >= minLexical)))
    if (!strongEvidence) continue
    if (!matchesAnchorTerm(item, anchorTerms)) continue

    let rrf = 0
    const lexicalRank = lexicalRanks.get(itemIndex)
    const bm25Rank = bm25Ranks.get(itemIndex)
    const phraseRank = phraseRanks.get(itemIndex)
    const semanticRank = semanticRanks.get(itemIndex)
    if (lexicalRank !== undefined) rrf += 0.9 / (RRF_K + lexicalRank)
    if (bm25Rank !== undefined) rrf += 1.1 / (RRF_K + bm25Rank)
    if (phraseRank !== undefined) rrf += 0.6 / (RRF_K + phraseRank)
    if (semanticRank !== undefined) rrf += 1 / (RRF_K + semanticRank)
    rrf += priorityAdjustment(item.priority) + freshnessAdjustment(item.updated_at)
    if (options.recentKeys?.has(`${item.origin ?? ''}:${item.id ?? String(itemIndex)}`)) rrf -= 0.004

    const channelCount = Number(lexicalRank !== undefined) + Number(bm25Rank !== undefined) +
      Number(phraseRank !== undefined) + Number(semanticRank !== undefined)
    hits.push({
      index: itemIndex,
      item,
      content: item.content,
      origin: item.origin ?? '',
      id: item.id ?? String(itemIndex),
      kind: item.kind ?? 'unknown',
      tags: item.tags ?? [],
      cosine: semantic,
      lexical: Number(lexical.toFixed(4)),
      bm25: Number(bm25.toFixed(4)),
      bm25Normalized: Number(bm25Normalized.toFixed(4)),
      phrase: Number(phrase.toFixed(4)),
      rrf: Number(rrf.toFixed(6)),
      source: channelCount > 1 ? 'hybrid' : semantic !== null ? 'semantic' : 'lexical',
    })
  }

  return hits.sort((left, right) => right.rrf - left.rrf || left.index - right.index).slice(0, topK)
}
