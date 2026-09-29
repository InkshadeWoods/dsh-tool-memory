/**
 * 可达性判定（工具入口层）——回答「修复 4 / 修复 10 是否需要修」。
 *
 * 姊妹文件：`store-reachability.spec.ts`（store + prompt 装配链）、
 * `recall-reachability.spec.ts`（召回 / 注入链）。本文件覆盖**工具入口**。
 *
 *   - 修复 4：`operations` 非数组。store 层没有守卫，插件靠 DSH 宿主的 schema
 *     校验兜底。要验的是：非数组能不能**穿过宿主**到达 store。
 *   - 修复 10：`kind` 读写不对称。运行期一直是对的（KINDS 白名单不含 unknown），
 *     缺的是**类型层**不许写。本文件同时用 `@ts-expect-error` 机器校验类型收紧。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { apply, loadConfig } from '../src/index.ts'
import { serializeMemoryEntry, type MemoryEntryMetadataInput } from '../src/memory-entry.ts'
import { MemoryStore } from '../src/store.ts'

const testSignal = new AbortController().signal
let root: string
let ctx: Context

function rendered(result: ToolExecutionResult): string {
  return result.content.map(b => (b.type === 'text' ? b.text : '')).join('')
}

async function execute(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testSignal,
    callId: CallId(`memory-${name}-${Math.random()}`),
    name,
    arguments: args,
  })
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dsh-memory-toollayer-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  apply(ctx, loadConfig({ root, memoryCharLimit: 80_000, userCharLimit: 16_000 }))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 修复 4：operations 非数组
// ---------------------------------------------------------------------------

describe('修复 4 可达性：非数组 operations 能否穿过宿主到达 store', () => {
  it('store 层确实没有守卫：直接调 applyBatch 会抛内层 TypeError', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-reach4-'))
    try {
      const store = new MemoryStore(dir, { memoryCharLimit: 80_000, userCharLimit: 16_000 })
      store.loadFromDisk()
      // 这是 store 层的现状（与 MCP 侧的 store 层一致，守卫在更外层）
      await expect(
        store.applyBatch('memory', 'not-an-array' as unknown as never[]),
      ).rejects.toThrow(TypeError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('宿主 schema 层拦下：非数组到不了 store，也不泄漏内层 TypeError', async () => {
    const outcome = await execute('memory_batch', { operations: 'not-an-array' })
      .catch((error: unknown) => error)

    const isThrown = outcome instanceof Error
    const text = isThrown
      ? String((outcome as Error).message)
      : rendered(outcome as ToolExecutionResult)

    // 宿主（@deepseek-ai/dsh-tools）按 memory_batch 声明的 JSON Schema 校验参数并拒绝。
    // 实测原文：invalid arguments: "operations" must be an array
    expect(text).toMatch(/must be an array/)
    // 关键：**不是内层 TypeError 的原文** —— 说明调用根本没穿到 store，
    // 因此修复 4 在工具路径上不需要修。
    expect(text).not.toMatch(/is not a function/)
  })

  it('每个 operations 元素非对象时，同样被拦在宿主层', async () => {
    const outcome = await execute('memory_batch', { operations: [42] })
      .catch((error: unknown) => error)
    const isThrown = outcome instanceof Error
    const text = isThrown
      ? String((outcome as Error).message)
      : rendered(outcome as ToolExecutionResult)
    // 实测原文：invalid arguments: "operations[0]" must be an object
    expect(text).toMatch(/operations\[0\].*must be an object/)
    expect(text).not.toMatch(/is not a function/)
  })
})

// ---------------------------------------------------------------------------
// 修复 10：kind 读写不对称
// ---------------------------------------------------------------------------

describe('修复 10 可达性：kind: unknown 的写入路径', () => {
  it('运行期：kind: unknown 始终被拒（KINDS 白名单不含它）', () => {
    // 类型层已排除 unknown（见文件末尾 typeLevelAssertion），这里用断言模拟
    // "未加类型标注的调用方"，验证运行期守卫本来就在。
    const metadata = { kind: 'unknown' } as unknown as MemoryEntryMetadataInput
    expect(serializeMemoryEntry('正文', metadata).error).toBe('metadata.kind 无效。')
  })

  it('运行期：合法的 8 个 kind 全部可写（收紧未误伤任何一个）', () => {
    const writable = ['identity', 'preference', 'workflow', 'safety', 'project', 'decision', 'technical-context', 'history']
    for (const kind of writable) {
      const result = serializeMemoryEntry('正文', { kind: kind as MemoryEntryMetadataInput['kind'] })
      expect(result.error, `kind=${kind} 应可写`).toBeUndefined()
      expect(result.content).toContain(`kind: ${kind}`)
    }
  })

  it('类型层收紧已生效（真正的断言在编译期，见文件末尾）', () => {
    expect(typeLevelAssertion).toBeInstanceOf(Function)
  })
})

// -- 类型层承重断言 ---------------------------------------------------------

/**
 * 编译期断言（**永不执行**）——修复 10 的类型收紧由类型系统持续保证。
 *
 * `WritableEntryKind = Exclude<MemoryEntryKind, 'unknown'>`，故 `kind: 'unknown'`
 * 必须编译失败。若将来有人把该字段放宽回 `MemoryEntryKind`，这行就不再报错
 * → `@ts-expect-error` 变成"多余指令" → tsc 报 TS2578 → `npm run typecheck` 拦住。
 *
 * 写成函数而非放进 `it`：编译期检查与运行无关，且这行**执行**时不会抛错
 * （只是被 KINDS 拒），但保持"只声明不调用"的写法与 recall-reachability 一致。
 */
function typeLevelAssertion(): void {
  // @ts-expect-error 修复 10：kind: 'unknown' 不是可写入值（WritableEntryKind 已排除）
  serializeMemoryEntry('正文', { kind: 'unknown' })
}
