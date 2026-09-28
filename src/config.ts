/**
 * 插件配置定义。独立成模块：host 入口与设置面板路由都要引用它，
 * 放在 index.ts 会形成运行时循环导入（ESM 命名导出 TDZ）。
 */
import Schema from '@deepseek-ai/schemastery'

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
  /** 注入策略：snapshot 保持旧版冻结行为；recall 按当前请求动态召回。 */
  injectionMode: 'snapshot' | 'recall'
  /**
   * recall 模式最终渲染的动态条目数。
   *
   * 这是「条数上限」而非固定条数：渲染按预算/顺序自适应填充，装得下几条就
   * 注入几条。运行时上限还会被当前动态池实际条目数进一步收紧（池里只有 5 条
   * 时不可能注入 6 条），因此 schema 不设 max，由 RecallRuntime 按池大小夹取。
   */
  recallTopK: number
  /** recall 模式动态记忆总字符预算；0 或留空=不设上限（默认）。 */
  recallMaxChars: number
  /** recall 模式单条动态记忆字符预算；0=不设上限（默认，零截断）。 */
  recallPerItemChars: number
  /** 是否允许 recall 模式使用可选 embedding 语义增强；默认关闭，不主动联网。 */
  recallEmbeddingEnabled: boolean
  /** OpenAI 兼容 embedding API 根地址；请求时自动追加 /embeddings。 */
  recallEmbeddingBaseUrl: string
  /** 仅存于本机 profile 的 embedding API Key；状态接口永不回传。 */
  recallEmbeddingApiKey: string
  /** embedding 模型标识；默认与本机 LM Studio 常用模型一致。 */
  recallEmbeddingModel: string
}

export const Config: Schema<Config> = Schema.object({
  root: Schema.string().default(''),
  memoryCharLimit: Schema.number().default(2200),
  userCharLimit: Schema.number().default(1375),
  nudgeInterval: Schema.number().default(10).min(0),
  reviewProvider: Schema.string().default(''),
  reviewModel: Schema.string().default(''),
  reviewNotify: Schema.union(['off', 'on', 'verbose']).default('on'),
  injectionMode: Schema.union(['snapshot', 'recall']).default('snapshot'),
  // 条数上限：默认 6，最小 1；上限不写死在 schema，运行时按动态池大小夹取。
  recallTopK: Schema.number().default(6).min(1),
  // 字符预算：默认 0=不设上限；用户可在设置里填具体数值覆盖。
  recallMaxChars: Schema.number().default(0).min(0),
  // 单条字符预算：默认 0=不设上限（零截断）；用户可填具体数值收紧。
  recallPerItemChars: Schema.number().default(0).min(0),
  recallEmbeddingEnabled: Schema.boolean().default(false),
  // 默认指向本机 LM Studio（无需鉴权），与 embedder.ts 的
  // DEFAULT_EMBEDDING_BASE_URL / DEFAULT_EMBEDDING_MODEL 逐字一致：
  // schema 默认值若与 embedder 默认值分叉，用户清空配置后行为会突变。
  recallEmbeddingBaseUrl: Schema.string().default('http://127.0.0.1:1234/v1'),
  recallEmbeddingApiKey: Schema.string().default(''),
  recallEmbeddingModel: Schema.string().default('text-embedding-qwen3-embedding-0.6b'),
})

/** recall 三个数值字段的合法区间；越界值在这里夹取而不是让 schema 抛错。 */
const RECALL_NUMERIC_BOUNDS = {
  recallTopK: { min: 1, max: Number.MAX_SAFE_INTEGER },
  recallMaxChars: { min: 0, max: Number.MAX_SAFE_INTEGER },
  recallPerItemChars: { min: 0, max: Number.MAX_SAFE_INTEGER },
} as const

/**
 * 加载配置并夹取 recall 数值字段。
 *
 * Schemastery 对越界值是抛 ValidationError，而这里由 host 入口直接调用；用户
 * 在设置里手填 0 / 负数 / 小数会让整个插件加载失败。因此先按区间夹取再交给
 * schema，保证「填错了也能起来，只是按最接近的合法值运行」。
 */
export function loadConfig(rawConfig: unknown): Config {
  const raw = (rawConfig ?? {}) as Record<string, unknown>
  const sanitized: Record<string, unknown> = { ...raw }
  for (const [key, bounds] of Object.entries(RECALL_NUMERIC_BOUNDS)) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    // 非数字交给 schema 报错（那是真正的结构性错误），数字则先夹取再校验。
    if (typeof value === 'number' && Number.isFinite(value)) {
      sanitized[key] = Math.min(bounds.max, Math.max(bounds.min, Math.floor(value)))
    }
  }
  // Schemastery 的调用签名要求 Config 形状，这里只做了区间夹取、字段集未变，
  // 因此需要一次类型断言；真正的结构校验仍由 schema 完成。
  const config = Config(sanitized as unknown as Config)
  return {
    ...config,
    recallTopK: clamp(config.recallTopK, RECALL_NUMERIC_BOUNDS.recallTopK),
    recallMaxChars: clamp(config.recallMaxChars, RECALL_NUMERIC_BOUNDS.recallMaxChars),
    recallPerItemChars: clamp(config.recallPerItemChars, RECALL_NUMERIC_BOUNDS.recallPerItemChars),
  }
}

function clamp(value: number, bounds: { min: number; max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(value)))
}
