/**
 * 可选的 embedding 客户端（本地 LM Studio / 远端 OpenAI 兼容服务）。
 *
 * 这是无 DSH 宿主依赖的增强能力：密钥缺失、超时或接口异常都抛给调用方，
 * 由 retrieval.ts 消化后降级至纯本地检索。不会写入向量或其他持久化索引。
 *
 * 配置来源**只有调用方显式传入**的 EmbedOptions：本模块不读环境变量、不读
 * Hermes `.env`、不做任何自动发现。GUI 设置面板（settings-routes.ts）持久化
 * 的 recallEmbeddingBaseUrl / recallEmbeddingApiKey / recallEmbeddingModel
 * 经 index.ts 组装成 EmbedOptions 传下来，用户看到的就是唯一真相。
 *
 * key 语义：本地端点（127.0.0.1 / localhost）天然不需要鉴权，留空即可；
 * 远端端点才要求显式 key，缺 key 直接抛错由调用方降级，绝不静默连一个
 * 注定 401 的地址。
 */

export const DEFAULT_EMBEDDING_BASE_URL = 'http://127.0.0.1:1234/v1'
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-qwen3-embedding-0.6b'
export const EMBED_DIM = 1024
const DEFAULT_TIMEOUT_MS = 4000

/** 本机回环端点不需要鉴权（LM Studio / Ollama / vLLM 本地模式皆然）。 */
function isLocalEndpoint(baseUrl: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(?::\d+)?(\/|$)/i.test(baseUrl)
}

/**
 * 语义通道可用性：本地端点天然可用；远端端点必须显式提供 key。
 *
 * 判定必须落到「实际要用的端点」上，而不是「有没有 key」——否则会出现
 * 明明指向本机 LM Studio 却因为 GUI 里 key 留空而报未配置。
 */
export function embeddingUsable(baseUrl?: string, apiKey?: string): boolean {
  const effective = (baseUrl?.trim() || DEFAULT_EMBEDDING_BASE_URL).replace(/\/+$/, '')
  if (isLocalEndpoint(effective)) return true
  return (apiKey?.trim() ?? '') !== ''
}

export interface EmbedOptions {
  timeoutMs?: number
  baseUrl?: string
  apiKey?: string
  model?: string
}

/**
 * 批量转向量。
 *
 * **契约（修复 17：原文只写「空输入…抛错」，未说明空串会被静默过滤——而返回
 * 向量数因此**不等于**入参数量，是与 MCP 侧对齐后补上的关键说明）**：
 * - 输入中的空串/纯空白会被**过滤**，不抛错；因此**返回的向量数 = 过滤后
 *   的数量**，调用方**不可**按原始 `texts` 下标去对应结果——需要保位时请
 *   自行先 trim/校验，或改用下标映射。
 * - 过滤后为空（即全部为空白）→ 抛错。
 * - 远端端点缺 key、接口异常、HTTP 非 2xx、返回结构不符 → 抛错。
 *
 * 调用方消化后降级：`retrieval.ts` 与 `recall-runtime.ts` 都在 try/catch 内调用，
 * 失败即静默放弃语义通道、退回纯本地检索。
 * 与 MCP 侧（hermes-memory-mcp/src/embedder.ts）契约一致。
 */
export async function embed(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
  const baseUrl = (options.baseUrl?.trim() || DEFAULT_EMBEDDING_BASE_URL).replace(/\/+$/, '')
  const key = options.apiKey?.trim()
  if (!embeddingUsable(baseUrl, key)) {
    throw new Error(`远端 embedding 端点需要 key：请显式传入 apiKey（端点 ${baseUrl}）`)
  }

  const input = texts.map(text => text.trim()).filter(Boolean)
  if (input.length === 0) throw new Error('embed 输入为空')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (key !== undefined && key !== '') headers.Authorization = `Bearer ${key}`
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input, model: options.model?.trim() || DEFAULT_EMBEDDING_MODEL, encoding_format: 'float' }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`embeddings HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)

    // 修复 16：`payload.data?.map(...)` 的可选链只兜 null/undefined，`data` 是
    // 字符串/数字/对象时 `.map` 不存在 → `TypeError: ... is not a function`，
    // 把本应友好的「返回结构异常」变成内部类型错误泄漏。先判数组再 map。
    // 与 MCP 侧（hermes-memory-mcp/src/embedder.ts）一致。
    const payload = (await response.json()) as { data?: unknown }
    if (!Array.isArray(payload.data)) throw new Error('embeddings 返回结构异常')
    const vectors = payload.data.map(item => (item as { embedding?: number[] } | null)?.embedding ?? [])
    if (vectors.length !== input.length || vectors.some(vector => vector.length === 0)) {
      throw new Error('embeddings 返回结构异常')
    }
    return vectors
  } finally {
    clearTimeout(timer)
  }
}
