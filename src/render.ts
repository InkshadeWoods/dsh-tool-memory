/**
 * 渲染：把工具的规范 JSON 值转成模型可见的中文文本。
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-tools'

export function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** memory_show 的规范值：按 target 列出条目与占用。 */
export interface ShowStore {
  target: string
  entries: string[]
  usage: string
}

export function renderShow(stores: ShowStore[]): string {  const blocks = stores.map((store) => {
    const title = store.target === 'user' ? 'USER.md（用户画像）' : 'MEMORY.md（我的笔记）'
    if (store.entries.length === 0) {
      return `${title}　${store.usage}　（暂无条目）`
    }
    const rows = store.entries.map((entry, i) => `${i + 1}. ${entry}`)
    return [`${title}　${store.usage}　${store.entries.length} 条`, ...rows].join('\n')
  })
  return blocks.join('\n\n')
}

/** 写操作结果的通用渲染。 */
export function renderWrite(value: Record<string, JsonValue>): string {
  const lines: string[] = []
  if (typeof value.message === 'string') lines.push(`✔ ${value.message}`)
  if (typeof value.usage === 'string') lines.push(`  占用：${value.usage}`)
  if (typeof value.entry_count === 'number') lines.push(`  条目数：${value.entry_count}`)
  if (typeof value.note === 'string') lines.push(`  ${value.note}`)
  return lines.join('\n')
}

/** memory_refresh 的渲染。 */
export function renderRefresh(value: Record<string, JsonValue>): string {
  const lines: string[] = [`✔ 已从磁盘重读记忆并重建快照（system prompt 将在后续步骤生效）：`]
  const stores = value.stores
  if (Array.isArray(stores)) {
    for (const store of stores as unknown as ShowStore[]) {
      const title = store.target === 'user' ? 'USER.md（用户画像）' : 'MEMORY.md（我的笔记）'
      lines.push(`  ${title}　${store.usage}　${store.entries.length} 条`)
    }
  }
  return lines.join('\n')
}
