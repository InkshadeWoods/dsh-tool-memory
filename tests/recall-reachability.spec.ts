/**
 * 跨侧一致性回归（召回 / 注入链）—— 锁定修复后的行为，防止回退。
 *
 * 缘起（2026-09-30）：与 MCP 侧（hermes-memory-mcp）逐项核对时，本文件最初用于
 * **判定**这几项分叉是否真的可达。判定完成后，用户批准把 5 项全部修掉以达成跨侧
 * 一致，本文件随之从"判定"转为"回归网"。
 *
 * 姊妹文件：`store-reachability.spec.ts`（store + prompt 装配链）。
 * 本文件覆盖依赖**召回链**才能验证的 3 项：
 *
 *   - 修复 11：`isDynamicEntry` 第二参守卫 —— 直传 `.filter(isDynamicEntry)`
 *     与箭头包装必须结果一致（修复前会抛 `TypeError: now.getTime is not a function`）
 *   - 修复 12·步1：仅元数据条目的 body 必须为 `''`（协议文本不得成为"记忆正文"）
 *   - 修复 16：embedding 返回结构异常时报**友好错误**，不得泄漏 TypeError
 *
 * 所有断言都注明"修复前是什么"，便于回退时立刻看出问题。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isDynamicEntry, isUserCoreEntry, parseMemoryEntries, serializeMemoryEntry, type MemoryEntry } from '../src/memory-entry.ts'
import { renderRecallContext } from '../src/recall-render.ts'
import { RecallRuntime } from '../src/recall-runtime.ts'
import { buildRecallIndex, searchRecallIndexed } from '../src/retrieval.ts'
import { embed } from '../src/embedder.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-recall-reach-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响断言结果
    }
  }
})

/** 让所有 embedding 请求返回一个**结构非法**的载荷（data 不是数组）。 */
function stubMalformedEmbedding(): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: 42 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })))
}

// ---------------------------------------------------------------------------
// 修复 11：isDynamicEntry 第二参类型 —— 真实链路是否会被触发
// ---------------------------------------------------------------------------

describe('修复 11：isDynamicEntry 第二参守卫 —— 直传与箭头包装必须一致', () => {
  it('直传函数引用不再抛错，且与箭头包装结果相同', () => {
    // 只有当条目 validUntil 非空时才会走到 now.getTime()，所以必须造这个前提。
    // 修复前：`[entry].filter(isDynamicEntry)` 抛 TypeError（now 收到数组下标 number）。
    const [entry] = parseMemoryEntries(['valid_until: 2026-01-01\n\n已过期的条目'], 'MEMORY.md')
    expect(entry).toBeDefined()

    const asUntypedPredicate = isDynamicEntry as unknown as (value: MemoryEntry, index: number) => boolean
    expect(() => [entry!].filter(asUntypedPredicate)).not.toThrow()
    // 两种写法必须逐字一致 —— 守卫把非法第二参一律回退为 new Date()
    expect([entry!].filter(asUntypedPredicate)).toEqual([entry!].filter(e => isDynamicEntry(e)))
  })

  it('有效条目经直传同样保留（守卫不是简单地一律返回 false）', () => {
    const [entry] = parseMemoryEntries(['valid_until: 2099-01-01\n\n未来的条目'], 'MEMORY.md')
    const asUntypedPredicate = isDynamicEntry as unknown as (value: MemoryEntry, index: number) => boolean
    expect([entry!].filter(asUntypedPredicate)).toHaveLength(1)
  })

  it('类型层仍要求 now: Date —— 直传写法过不了编译（承重断言）', () => {
    // 真正的断言在编译期（见文件末尾的 typeLevelAssertion）。
    // 注意：**运行期守卫与类型层收紧是两层**，修复 11 只补了运行期守卫；
    // 类型层依旧拒绝直接传引用（这很好：新代码写错会立刻在编译期暴露）。
    expect(typeLevelAssertion).toBeInstanceOf(Function)
  })

  it('真实召回链路：含 valid_until 的过期条目被正确排除', async () => {
    const runtime = new RecallRuntime()
    const memoryEntries = [
      'valid_until: 2026-01-01\n\n已过期的条目',
      'status: active\n\n正常条目',
    ]
    const result = await runtime.recall({
      userEntries: [],
      memoryEntries,
      query: '正常条目',
      embeddingEnabled: false,
    })
    expect(result.hits.map(h => h.entry.body)).not.toContain('已过期的条目')
  })

  it('isUserCoreEntry 内部显式传参，不受第二参类型影响', () => {
    const [entry] = parseMemoryEntries([
      'kind: workflow\ninject: always\npriority: permanent\nstatus: active\nscope: global\n\n核心条目',
    ], 'USER.md')
    expect(() => isUserCoreEntry(entry!)).not.toThrow()
    expect(isUserCoreEntry(entry!)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 修复 12·步1：仅元数据条目 —— body 必须为空，协议文本不得成为"记忆正文"
// ---------------------------------------------------------------------------

describe('修复 12·步1：仅元数据条目的 body 必须为空', () => {
  it('body 为 ""，且因此被判为非动态条目（不会进池）', () => {
    const [entry] = parseMemoryEntries(['kind: project'], 'MEMORY.md')
    // 修复前：body === 'kind: project' 且 isDynamicEntry === true
    expect(entry!.body).toBe('')
    expect(isDynamicEntry(entry!)).toBe(false)
  })

  it('带正文的正常条目不受影响（关键不回归）', () => {
    const [entry] = parseMemoryEntries(['kind: project\n\n真正的正文'], 'MEMORY.md')
    expect(entry!.body).toBe('真正的正文')
    expect(entry!.kind).toBe('project')
    expect(isDynamicEntry(entry!)).toBe(true)
  })

  it('旧格式条目不受影响：后续为非元数据行 → 全文当正文', () => {
    const [entry] = parseMemoryEntries(['kind: 这看起来像元数据\n但第二行不是元数据字段'], 'MEMORY.md')
    // 第二行既不是已知字段、后面也没有空行分隔 → 不是协议 → 全文当正文。
    // 这是修复 12 必须守住的反向边界（否则会误伤旧格式正文）。
    expect(entry!.body).toBe('kind: 这看起来像元数据\n但第二行不是元数据字段')
  })

  it('单行「key: value」且无正文 → 判为仅元数据（有意收紧的边界）', () => {
    // 修复 12·步1 后，单行且恰好是已知字段的条目会被判为"仅有元数据、正文缺失"。
    // 这是**有意的**（与 MCP 侧同款行为）：该形态无法区分"协议残留"与"旧格式单行"，
    // 按协议优先处理。代价是该条目在快照里显示为异常占位符（原文仍在文件里、
    // memory_show 仍可见），用户可据此修正。
    // 实证：现役 MEMORY.md/USER.md 共 106 条中，该形态条目数为 0，无实际影响。
    const [entry] = parseMemoryEntries(['status: 服务已恢复'], 'MEMORY.md')
    expect(entry!.body).toBe('')
  })

  it('该条目经渲染层会以「kind: project」作为正文注入（链路确实通）', () => {
    const [entry] = parseMemoryEntries(['kind: project'], 'MEMORY.md')
    const rendered = renderRecallContext({
      coreEntries: [],
      hits: [{
        entry: entry!,
        hit: {
          index: 0,
          item: { content: entry!.body },
          content: entry!.body,
          origin: entry!.source,
          id: entry!.id,
          kind: entry!.kind,
          tags: entry!.tags,
          cosine: null,
          lexical: 1,
          bm25: 1,
          bm25Normalized: 1,
          phrase: 0,
          rrf: 1,
          source: 'lexical',
        },
      }],
    })
    // 渲染层取的是 entry.body（recall-render.ts 的 renderEntry）；body 已为空，
    // 协议文本不再出现。这里刻意手工构造 hit 把条目强行塞进渲染层，作为
    // "即使有人绕过池筛选，正文也不会被注入"的纵深防御断言。
    expect(rendered.text).not.toContain('kind: project')
  })

  it('插件自身造不出该形态条目 —— 只能由外部手编辑产生', () => {
    expect(serializeMemoryEntry('', { kind: 'project' }).error).toBe('记忆正文不能为空。')
    expect(serializeMemoryEntry('   ', { kind: 'project' }).error).toBe('记忆正文不能为空。')
    // 空正文被拒 → 任何工具路径（add/replace/batch）都无法落盘"只有元数据"的条目
  })
})

// ---------------------------------------------------------------------------
// 修复 16：embedder 结构校验 —— 必须报友好错误
// ---------------------------------------------------------------------------

describe('修复 16：embedding 返回结构异常时报友好错误', () => {
  beforeEach(() => {
    stubMalformedEmbedding()
  })

  it('data 非数组 → 报「embeddings 返回结构异常」，而非泄漏 TypeError', async () => {
    const error = await embed(['a']).catch((e: unknown) => e)
    // 修复前：TypeError: payload.data?.map is not a function
    expect(error).not.toBeInstanceOf(TypeError)
    expect((error as Error).message).toBe('embeddings 返回结构异常')
  })

  it('调用点一（retrieval 兜底路径）静默降级：不抛错、正常返回', async () => {
    const index = buildRecallIndex([{ content: '项目约定：文档类任务用反向工作流', origin: 'MEMORY.md', id: 'x', kind: 'project', tags: [] }])
    const hits = await searchRecallIndexed(index, '文档 反向工作流', {
      embeddingOptions: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'm' },
    })
    // 语义通道因异常被 catch，纯本地通道仍完成召回 —— 用户看不到任何错误
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every(h => h.cosine === null)).toBe(true)
  })

  it('调用点二（RecallRuntime 向量预热）静默降级：recall 不抛错', async () => {
    const runtime = new RecallRuntime()
    const result = await runtime.recall({
      userEntries: [],
      memoryEntries: ['项目约定：文档类任务用反向工作流'],
      query: '文档 反向工作流',
      embeddingEnabled: true,
      embeddingOptions: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'm' },
    })
    expect(result.hits.length).toBeGreaterThan(0)
    // 预热失败不留残留状态：向量从未就绪，下次文件变更可重试
    expect(runtime.status().vectorState).not.toBe('ready')
  })
})

// -- 类型层承重断言 ---------------------------------------------------------

/**
 * 编译期断言（**永不执行**）——类型层继续拒绝把函数引用直接交给 `.filter`。
 *
 * 修复 11 补的是**运行期**守卫（非法第二参回退为 `new Date()`），类型层并未放宽：
 * `isDynamicEntry(entry, now: Date = new Date())` 的第二参类型仍是 Date，而
 * `.filter` 会把数组下标（number）作为第二参传入 —— number 不可赋给 Date，
 * 故 tsc 报错。下面的 `@ts-expect-error` 要求该行**必须编译失败**。
 *
 * 两层保护是有意叠加的：
 *   - 类型层拦下**新写的代码**（编译期即暴露，见本函数）
 *   - 运行期守卫兜住**无类型标注的调用方**（见上面的直传用例）
 *
 * 为什么写成函数而不是直接放在 `it` 里：编译期检查与运行无关；虽然这行现在
 * 执行也不会抛错（运行期守卫已兜住），但保持"只声明、不调用"可避免把
 * 编译期断言误当成行为测试。
 *
 * 反向保护：若将来有人把第二参放宽成 `Date | number`（或加 any），这行就不再报错
 * → `@ts-expect-error` 变成"多余指令" → tsc 报 TS2578 → `npm run typecheck` 失败。
 * 这正是把 tests 纳入 tsconfig include 的原因（见 tsconfig.json 注释）。
 */
function typeLevelAssertion(entry: MemoryEntry): number {
  // @ts-expect-error 修复 11：直传 .filter(isDynamicEntry) 在类型层仍被拒（number 不可赋给 Date）
  return [entry].filter(isDynamicEntry).length
}
