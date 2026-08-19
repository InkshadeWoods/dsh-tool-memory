/**
 * 可选的 ModelScope Qwen3-Embedding-8B 客户端。
 *
 * 这是无 DSH 宿主依赖的增强能力：密钥缺失、超时或接口异常都抛给调用方，
 * 由 retrieval.ts 消化后降级至纯本地检索。不会写入向量或其他持久化索引。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_EMBEDDING_BASE_URL = 'https://api-inference.modelscope.cn/v1'
export const DEFAULT_EMBEDDING_MODEL = 'Qwen/Qwen3-Embedding-8B'
export const EMBED_DIM = 4096
const DEFAULT_TIMEOUT_MS = 4000

const HERMES_HOME = process.env.HERMES_HOME ?? 'C:/Users/L2645/AppData/Local/hermes'

/** 从 Hermes `.env` 读取兼容密钥；文件不可读或未配置时不报错。 */
function readHermesEnvKey(name: string): string | undefined {
  let raw: string
  try {
    raw = readFileSync(join(HERMES_HOME, '.env'), 'utf8')
  } catch {
    return undefined
  }

  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
    if (match !== null && match[1] === name) {
      const value = (match[2] ?? '').trim().replace(/^["']|["']$/g, '')
      return value.length > 0 && !value.startsWith('your') ? value : undefined
    }
  }
  return undefined
}

let cachedKey: string | undefined | null = null

/** 优先读取环境变量，再兼容 Hermes 现有 `.env`，且不会暴露密钥内容。 */
export function embeddingApiKey(): string | undefined {
  if (cachedKey !== null) return cachedKey
  cachedKey = process.env.SCOPE_RECALL_EMBEDDING_API_KEY?.trim() || readHermesEnvKey('SCOPE_RECALL_EMBEDDING_API_KEY')
  return cachedKey
}

export interface EmbedOptions {
  timeoutMs?: number
  baseUrl?: string
  apiKey?: string
  model?: string
}

/** 批量转为向量；空输入、缺少密钥或远端异常均抛错，由调用方安全降级。 */
export async function embed(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
  const key = options.apiKey?.trim() || embeddingApiKey()
  if (key === undefined) throw new Error('未找到 embedding key（SCOPE_RECALL_EMBEDDING_API_KEY）')

  const input = texts.map(text => text.trim()).filter(Boolean)
  if (input.length === 0) throw new Error('embed 输入为空')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const baseUrl = (options.baseUrl?.trim() || DEFAULT_EMBEDDING_BASE_URL).replace(/\/+$/, '')
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, model: options.model?.trim() || DEFAULT_EMBEDDING_MODEL, encoding_format: 'float' }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`embeddings HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)

    const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> }
    const vectors = payload.data?.map(item => item.embedding ?? [])
    if (vectors === undefined || vectors.length !== input.length || vectors.some(vector => vector.length === 0)) {
      throw new Error('embeddings 返回结构异常')
    }
    return vectors
  } finally {
    clearTimeout(timer)
  }
}
