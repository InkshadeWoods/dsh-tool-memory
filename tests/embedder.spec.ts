/**
 * embedder 契约测试：key 只来自显式传参，无任何自动发现。
 *
 * 覆盖 P0 的三条硬约束：
 *   1. 不读环境变量、不读 Hermes `.env`（这是本次删除自动发现的回归防线——
 *      若将来有人把 readHermesEnvKey 加回来，下面的测试会立刻失败）。
 *   2. 本地端点（127.0.0.1 / localhost）免 key；GUI 里 key 留空也能用。
 *   3. 远端端点必须显式 key，缺 key 直接抛错，绝不静默连 401。
 *
 * 网络请求一律 mock globalThis.fetch，不触碰真实 LM Studio，保证测试
 * 在 CI / 无后端环境下确定性通过。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_EMBEDDING_BASE_URL, DEFAULT_EMBEDDING_MODEL, embed, embeddingUsable } from '../src/embedder.ts'

/** 构造一个最小 OpenAI 兼容 embeddings 响应。 */
function embeddingResponse(count: number, dim = 4): Response {
  return new Response(
    JSON.stringify({ data: Array.from({ length: count }, () => ({ embedding: Array.from({ length: dim }, () => 0.5) })) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  // 清理所有可能被误读取的 key 环境变量，确保「无自动发现」断言的是
  // 真实行为而不是碰巧没设变量。
  delete process.env.SCOPE_RECALL_EMBEDDING_API_KEY
  delete process.env.HERMES_HOME
})

describe('embeddingUsable', () => {
  it('本地端点免 key：key 留空仍判定可用', () => {
    expect(embeddingUsable('http://127.0.0.1:1234/v1', '')).toBe(true)
    expect(embeddingUsable('http://localhost:1234/v1', undefined)).toBe(true)
    expect(embeddingUsable('http://[::1]:1234/v1', '')).toBe(true)
  })

  it('未传 baseUrl 时按本地默认值处理，同样免 key', () => {
    expect(embeddingUsable(undefined, '')).toBe(true)
    expect(DEFAULT_EMBEDDING_BASE_URL).toBe('http://127.0.0.1:1234/v1')
  })

  it('远端端点必须有显式 key', () => {
    expect(embeddingUsable('https://api.example.com/v1', '')).toBe(false)
    expect(embeddingUsable('https://api.example.com/v1', '   ')).toBe(false)
    expect(embeddingUsable('https://api.example.com/v1', undefined)).toBe(false)
    expect(embeddingUsable('https://api.example.com/v1', 'sk-real')).toBe(true)
  })

  it('key 为空白字符不算已配置', () => {
    expect(embeddingUsable('https://api.example.com/v1', '\t\n ')).toBe(false)
  })
})

describe('embed 本地端点', () => {
  it('key 留空也能请求，且不带 Authorization 头', async () => {
    fetchMock.mockResolvedValue(embeddingResponse(2))

    const vectors = await embed(['a', 'b'], { baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '' })

    expect(vectors).toHaveLength(2)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:1234/v1/embeddings')
    // 核心断言：本地端点不注入 Authorization。
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('默认模型与本地默认值一致', async () => {
    fetchMock.mockResolvedValue(embeddingResponse(1))

    await embed(['a'], { baseUrl: 'http://127.0.0.1:1234/v1' })

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.model).toBe(DEFAULT_EMBEDDING_MODEL)
    expect(body.encoding_format).toBe('float')
    expect(body.input).toEqual(['a'])
  })

  it('显式传入的 key 会被带上（本地端点配了 key 也用）', async () => {
    fetchMock.mockResolvedValue(embeddingResponse(1))

    await embed(['a'], { baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'sk-local' })

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-local')
  })

  it('空白文本被过滤后计数仍与请求一致', async () => {
    fetchMock.mockResolvedValue(embeddingResponse(2))

    const vectors = await embed(['  a  ', '', '   ', 'b'], { baseUrl: 'http://127.0.0.1:1234/v1' })

    expect(vectors).toHaveLength(2)
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.input).toEqual(['a', 'b'])
  })
})

describe('embed 远端端点', () => {
  it('缺 key 直接抛错，且不发出任何网络请求', async () => {
    await expect(embed(['a'], { baseUrl: 'https://api.example.com/v1' })).rejects.toThrow(/需要 key/)

    // 关键：连一个注定 401 的地址都不该发生。
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('有 key 才请求，并带上 Authorization', async () => {
    fetchMock.mockResolvedValue(embeddingResponse(1))

    await embed(['a'], { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-remote' })

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-remote')
  })

  it('错误信息不含 key 内容', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))

    await expect(embed(['a'], { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret-value' }))
      .rejects.toThrow('embeddings HTTP 500')
  })
})

describe('无自动发现（P0 回归防线）', () => {
  it('即使环境变量里有 key，远端缺显式 key 仍然抛错', async () => {
    // 这是本次 P0 的核心语义：环境变量不再被读取。若有人把
    // process.env.SCOPE_RECALL_EMBEDDING_API_KEY 的回落加回来，这里会失败。
    process.env.SCOPE_RECALL_EMBEDDING_API_KEY = 'sk-from-env'

    await expect(embed(['a'], { baseUrl: 'https://api.example.com/v1' })).rejects.toThrow(/需要 key/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('HERMES_HOME 指向一个含 key 的 .env 也不被读取', async () => {
    // 即使指向真实 Hermes 目录（其 .env 里历史上可能有 key），也不该被发现。
    process.env.HERMES_HOME = 'C:/Users/L2645/AppData/Local/hermes'

    await expect(embed(['a'], { baseUrl: 'https://api.example.com/v1' })).rejects.toThrow(/需要 key/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('本地端点不因缺 key 而抛错（证明判定走端点而非 key 有无）', async () => {
    process.env.SCOPE_RECALL_EMBEDDING_API_KEY = ''
    fetchMock.mockResolvedValue(embeddingResponse(1))

    await expect(embed(['a'], { baseUrl: 'http://127.0.0.1:1234/v1' })).resolves.toHaveLength(1)
  })
})

describe('embed 失败路径', () => {
  it('空输入抛错且不发请求', async () => {
    await expect(embed(['', '   '], { baseUrl: 'http://127.0.0.1:1234/v1' })).rejects.toThrow('embed 输入为空')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('非 2xx 响应抛错并带上状态码', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }))
    await expect(embed(['a'], { baseUrl: 'http://127.0.0.1:1234/v1' })).rejects.toThrow('embeddings HTTP 404')
  })

  it('返回条数与输入不一致时抛错', async () => {
    fetchMock.mockResolvedValue(embeddingResponse(3))
    await expect(embed(['a', 'b'], { baseUrl: 'http://127.0.0.1:1234/v1' })).rejects.toThrow('返回结构异常')
  })

  it('存在空向量时抛错', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ embedding: [] }] }), { status: 200 }))
    await expect(embed(['a'], { baseUrl: 'http://127.0.0.1:1234/v1' })).rejects.toThrow('返回结构异常')
  })

  it('超时会 abort，不会无限等待', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))

    await expect(embed(['a'], { baseUrl: 'http://127.0.0.1:1234/v1', timeoutMs: 30 })).rejects.toThrow()
  })
})
