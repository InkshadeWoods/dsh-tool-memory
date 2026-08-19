/**
 * dsh-tool-memory —— 设置面板的 host 半边路由。
 *
 * 浏览器设置面板（lib/client.js）通过同源 fetch 访问：
 *   GET  /memory-plugin/api/state     当前生效配置 + 两个存储的占用统计
 *   POST /memory-plugin/api/settings  校验并保存配置
 *
 * 保存策略：行编辑 profile 的 cordis.patch.yml（保留文件头注释与其它
 * 条目），再尝试 ctx.loader 热重载让新配置立即生效。patch 文件是唯一
 * 持久化源——cordis loader 对 patched entry 的 tree.write 序列化的是
 * Include 层的原始 data，patch 覆盖不会落盘，因此持久化必须自己写
 * patch 文件，热重载只借 loader.update 的内存生效部分。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config } from './config.ts'
import type { RecallRuntime } from './recall-runtime.ts'
import type { MemoryStore, MemoryTarget } from './store.ts'

const STATE_ROUTE = '/memory-plugin/api/state'
const SETTINGS_ROUTE = '/memory-plugin/api/settings'
const MAX_BODY_BYTES = 64 * 1024
const CONFIG_KEYS = [
  'root', 'memoryCharLimit', 'userCharLimit', 'nudgeInterval',
  'reviewProvider', 'reviewModel', 'reviewNotify', 'injectionMode',
  'recallTopK', 'recallMaxChars', 'recallPerItemChars', 'recallEmbeddingEnabled',
  'recallEmbeddingBaseUrl', 'recallEmbeddingApiKey', 'recallEmbeddingModel',
] as const

/** webServer 服务的最小结构（避免为类型声明引入 host-webserver 依赖）。 */
interface WebServerLike {
  register(options: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): (() => void) | void
}

/** 仅暴露模型选择需要的公开路由元数据；不读取或返回任何凭据、地址或其他配置。 */
interface LlmCatalogLike {
  listProviders(): Array<{ id: string; name: string }>
  listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>>
}

interface PublicModelRoute {
  provider: string
  providerName: string
  model: string
  modelName: string
}

async function availableModelRoutes(ctx: Context): Promise<PublicModelRoute[]> {
  try {
    const llm = ctx.reflect.get('llm', false) as LlmCatalogLike | undefined
    if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return []
    const providers = llm.listProviders().filter(item => typeof item.id === 'string' && item.id.length > 0)
    const lists = await Promise.all(providers.map(async (provider) => {
      try {
        const models = await llm.listModels(provider.id)
        return models
          .filter(model => model.provider === provider.id && typeof model.id === 'string' && model.id.length > 0)
          .map(model => ({
            provider: provider.id,
            providerName: provider.name || provider.id,
            model: model.id,
            modelName: model.name || model.id,
          }))
      } catch {
        return []
      }
    }))
    return lists.flat()
  } catch {
    // 模型目录只是设置页辅助信息；运行时不可用时仍允许使用“继承当前会话”。
    return []
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function isSameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const referer = req.headers.referer
  const host = req.headers.host
  const source = typeof origin === 'string' ? origin : referer
  if (typeof source !== 'string' || typeof host !== 'string') return false
  try {
    return new URL(source).host === host
  } catch {
    return false
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** YAML 单引号标量（路径、枚举值等全是简单标量）。 */
function yamlScalar(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return `'${String(value).replaceAll("'", "''")}'`
}

/** patch 文件定位：环境变量优先，回退当前 profile 布局。 */
function locatePatchFile(): string | null {
  const env = process.env.DSH_MEMORY_PATCH_FILE
  if (env) return env
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profile = process.env.DSH_PROFILE ?? 'web'
  const candidate = join(home, 'profiles', profile, 'cordis.patch.yml')
  return existsSync(candidate) ? candidate : null
}

function renderConfigBlock(config: Config, indent: string): string[] {
  const lines = [`${indent}config:`]
  for (const key of CONFIG_KEYS) {
    lines.push(`${indent}  ${key}: ${yamlScalar(config[key])}`)
  }
  return lines
}

type PatchEdit = { ok: true; content: string } | { ok: false; error: string }

/**
 * 行编辑 patch 文件内容：替换（或插入/追加）id=memory 条目的 config 块。
 * 只动 config 块内部的行，头部注释、其它条目、其它字段原样保留；任何
 * 结构不匹配都整体失败，不产出半成品内容。
 */
function editPatchContent(raw: string, newConfig: Config): PatchEdit {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split(/\r?\n/)
  // 组合包的默认结构把插件条目缩进在 `- insert:` 下；同时兼容 profile
  // 中顶格的 `- id: memory`。结束位置必须按同级 list item 判断，不能把
  // 嵌套条目误认成当前插件块的边界。
  const memoryEntryMatch = (line: string) => /^(\s*)-\s*id:\s*['"]?memory['"]?\s*(#.*)?$/.exec(line)
  const listItemIndent = (line: string) => /^(\s*)-\s/.exec(line)?.[1]?.length
  const configLineRe = /^(\s*)config:\s*(?:[#}].*)?$/

  let start = lines.findIndex(line => memoryEntryMatch(line) !== null)
  if (start < 0) {
    // 无该条目：追加到文件末尾（保留原有内容与末尾空行语义）。
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    lines.push('', '- id: memory', ...renderConfigBlock(newConfig, '  '))
    return { ok: true, content: lines.join(eol) + eol }
  }

  const entryIndent = listItemIndent(lines[start]!) ?? 0
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (listItemIndent(lines[i]!) === entryIndent) { end = i; break }
  }

  let configIdx = -1
  let configIndent = ''
  for (let i = start + 1; i < end; i++) {
    const match = lines[i]!.match(configLineRe)
    if (match) { configIdx = i; configIndent = match[1] ?? ''; break }
  }

  if (configIdx < 0) {
    // 条目存在但无 config：对齐条目内现有子键缩进，插到条目末尾。
    let indent = '  '
    for (let i = start + 1; i < end; i++) {
      const match = lines[i]!.match(/^(\s+)\S/)
      if (match) { indent = match[1] ?? '  '; break }
    }
    let insertAt = end
    while (insertAt > start + 1 && lines[insertAt - 1]!.trim() === '') insertAt--
    lines.splice(insertAt, 0, ...renderConfigBlock(newConfig, indent))
    return { ok: true, content: lines.join(eol) }
  }

  // config 块范围：到条目内下一个缩进不深于 config 的键行为止。
  let blockEnd = end
  for (let i = configIdx + 1; i < end; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    const match = line.match(/^(\s*)\S/)
    if (match && (match[1] ?? '').length <= configIndent.length) { blockEnd = i; break }
  }
  lines.splice(configIdx, blockEnd - configIdx, ...renderConfigBlock(newConfig, configIndent))
  return { ok: true, content: lines.join(eol) }
}

/** 写 patch 文件的原子落盘（tmp + rename，与 store.ts 写路径同款）。 */
function writePatchFile(path: string, content: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
}

/** 尝试 loader 热重载；loader 不可用或失败都返回 false（面板提示重启）。 */
async function tryHotReload(ctx: Context, newConfig: Config): Promise<boolean> {
  try {
    const loader = (ctx as unknown as {
      loader?: {
        entries?: () => Iterable<{ id?: string; options?: Record<string, unknown> }>
        update?: (id: string, options: Record<string, unknown>) => Promise<unknown>
      }
    }).loader
    if (!loader || typeof loader.update !== 'function' || typeof loader.entries !== 'function') return false
    const entry = Array.from(loader.entries()).find(e => e.id === 'memory')
    if (!entry?.options) return false
    await loader.update('memory', { ...entry.options, config: newConfig })
    return true
  } catch {
    return false
  }
}

/**
 * 在 webServer 上挂设置面板路由。ctx 需来自 webServer 服务可用的注入
 * （index.ts 里用 ctx.inject(['webServer'], ...) 延迟注入）；返回 disposer。
 */
export function registerMemorySettingsRoutes(
  ctx: Context,
  config: Config,
  store: MemoryStore,
  recallRuntime: RecallRuntime,
): () => void {
  const server = (ctx as unknown as { webServer?: WebServerLike }).webServer
  const disposers: Array<() => void> = []
  if (typeof server?.register !== 'function') return () => {}

  const stateRoute = server.register({
    kind: 'exact',
    path: STATE_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'GET' || !isSameOriginRequest(req)) {
        writeJson(res, req.method !== 'GET' ? 405 : 403, { ok: false, error: 'forbidden' })
        return
      }
      const stats: Record<string, { entries: number; chars: number; limit: number }> = {}
      for (const target of ['memory', 'user'] as MemoryTarget[]) {
        stats[target] = {
          entries: store.entriesFor(target).length,
          chars: store.charCount(target),
          limit: store.charLimit(target),
        }
      }
      const { fingerprint, ...recallStatus } = recallRuntime.status()
      const modelRoutes = await availableModelRoutes(ctx)
      // 路由也独立归一化，防止热重载过渡期仍持有旧 shape 的 config。
      const normalizedConfig = Config(config)
      const publicConfig = { ...normalizedConfig, recallEmbeddingApiKey: '' }
      writeJson(res, 200, {
        ok: true,
        config: publicConfig,
        embeddingApiKeyConfigured: normalizedConfig.recallEmbeddingApiKey.trim().length > 0,
        resolvedRoot: store.dir,
        patchFile: locatePatchFile(),
        stats,
        modelRoutes,
        // 指纹本身不暴露给浏览器，仅以布尔值区分“尚未建立运行时索引”与“已建立但条目为零”。
        recallStatus: { ...recallStatus, indexLoaded: typeof fingerprint === 'string' && fingerprint.length > 0 },
      })
    },
  })
  if (typeof stateRoute === 'function') disposers.push(stateRoute)

  const settingsRoute = server.register({
    kind: 'exact',
    path: SETTINGS_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST' || !isSameOriginRequest(req)) {
        writeJson(res, req.method !== 'POST' ? 405 : 403, { ok: false, error: 'forbidden' })
        return
      }
      let rawConfig: unknown
      try {
        const body = JSON.parse(await readBody(req)) as { config?: unknown; clearEmbeddingApiKey?: unknown }
        rawConfig = body.config
        if (rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)) {
          const incoming = rawConfig as Record<string, unknown>
          const incomingKey = typeof incoming.recallEmbeddingApiKey === 'string' ? incoming.recallEmbeddingApiKey.trim() : ''
          rawConfig = {
            ...incoming,
            recallEmbeddingApiKey: body.clearEmbeddingApiKey === true ? '' : incomingKey || config.recallEmbeddingApiKey,
          }
        }
      } catch {
        writeJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }
      let merged: Config
      try {
        merged = Config(rawConfig as Config | null | undefined)
      } catch (error) {
        writeJson(res, 400, { ok: false, error: `配置校验失败：${error instanceof Error ? error.message : String(error)}` })
        return
      }
      const patchFile = locatePatchFile()
      if (!patchFile) {
        writeJson(res, 400, { ok: false, error: '找不到 cordis.patch.yml；请设置 DSH_MEMORY_PATCH_FILE 环境变量' })
        return
      }
      try {
        const edit = editPatchContent(readFileSync(patchFile, 'utf8'), merged)
        if (!edit.ok) {
          writeJson(res, 400, { ok: false, error: edit.error })
          return
        }
        writePatchFile(patchFile, edit.content)
      } catch (error) {
        writeJson(res, 500, { ok: false, error: `写入 patch 文件失败：${error instanceof Error ? error.message : String(error)}` })
        return
      }
      const reloaded = await tryHotReload(ctx, merged)
      // 仅回传“是否已配置”的布尔值，用于 UI 安全地确认保存结果；绝不回传 Key 本文。
      writeJson(res, 200, {
        ok: true,
        reloaded,
        embeddingApiKeyConfigured: merged.recallEmbeddingApiKey.trim().length > 0,
      })
    },
  })
  if (typeof settingsRoute === 'function') disposers.push(settingsRoute)

  return () => { for (const dispose of disposers) dispose() }
}
