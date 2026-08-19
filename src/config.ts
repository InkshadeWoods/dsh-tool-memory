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
  /** recall 模式最终渲染的动态条目数。 */
  recallTopK: number
  /** recall 模式动态记忆总字符预算。 */
  recallMaxChars: number
  /** recall 模式单条动态记忆字符预算。 */
  recallPerItemChars: number
  /** 是否允许 recall 模式使用可选 embedding 语义增强；默认关闭，不主动联网。 */
  recallEmbeddingEnabled: boolean
  /** OpenAI 兼容 embedding API 根地址；请求时自动追加 /embeddings。 */
  recallEmbeddingBaseUrl: string
  /** 仅存于本机 profile 的 embedding API Key；状态接口永不回传。 */
  recallEmbeddingApiKey: string
  /** embedding 模型标识；默认与既有 ModelScope 实现一致。 */
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
  recallTopK: Schema.number().default(3).min(1).max(6),
  recallMaxChars: Schema.number().default(1200).min(200).max(4000),
  recallPerItemChars: Schema.number().default(420).min(80).max(1200),
  recallEmbeddingEnabled: Schema.boolean().default(false),
  recallEmbeddingBaseUrl: Schema.string().default('https://api-inference.modelscope.cn/v1'),
  recallEmbeddingApiKey: Schema.string().default(''),
  recallEmbeddingModel: Schema.string().default('Qwen/Qwen3-Embedding-8B'),
})
