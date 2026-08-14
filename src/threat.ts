/**
 * 记忆内容威胁扫描 —— Hermes tools/threat_patterns.py（strict 作用域）的精简移植。
 *
 * 记忆条目会以「冻结快照」形式注入 system prompt，且由用户长期持有，
 * 因此写入时采用最严格的检查集：经典提示注入、越狱、回连/外传、
 * 后门、硬编码密钥，以及不可见 Unicode 字符。命中即拒绝写入；
 * 快照构建时对历史命中条目替换为占位符（原文保留在文件中供用户检查删除）。
 *
 * 模式刻意锚定在明确的攻击词汇上，而不是宽泛的命令式英语
 * （"you must…" 这类措辞在正常指令文本中太常见）。
 */

/** 两次关键 token 之间允许的填充词数量（防止插入几个词绕过，同时避免灾难性回溯）。 */
const FILLER = '(?:\\w+\\s+){0,8}'

interface Pattern {
  id: string
  re: RegExp
}

const MAX_SCAN_CHARS = 65_536

const PATTERNS: Pattern[] = [
  // ── 经典提示注入 ────────────────────────────────────────────────
  { id: 'prompt_injection', re: new RegExp(`ignore\\s+${FILLER}(previous|all|above|prior)\\s+${FILLER}instructions`, 'i') },
  { id: 'sys_prompt_override', re: /system\s+prompt\s+override/i },
  { id: 'disregard_rules', re: new RegExp(`disregard\\s+${FILLER}(your|all|any)\\s+${FILLER}(instructions|rules|guidelines)`, 'i') },
  { id: 'bypass_restrictions', re: new RegExp(`act\\s+as\\s+(if|though)\\s+${FILLER}you\\s+${FILLER}(have\\s+no|don't\\s+have)\\s+${FILLER}(restrictions|limits|rules)`, 'i') },
  { id: 'html_comment_injection', re: /<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->/i },
  { id: 'hidden_div', re: /<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none/i },
  { id: 'deception_hide', re: new RegExp(`do\\s+not\\s+${FILLER}tell\\s+${FILLER}the\\s+user`, 'i') },

  // ── 角色扮演 / 身份劫持 ─────────────────────────────────────────
  { id: 'role_hijack', re: new RegExp(`you\\s+are\\s+${FILLER}now\\s+(?:a|an|the)\\s+`, 'i') },
  { id: 'role_pretend', re: new RegExp(`pretend\\s+${FILLER}(you\\s+are|to\\s+be)\\s+`, 'i') },
  { id: 'leak_system_prompt', re: new RegExp(`output\\s+${FILLER}(system|initial)\\s+prompt`, 'i') },
  { id: 'remove_filters', re: new RegExp(`(respond|answer|reply)\\s+without\\s+${FILLER}(restrictions|limitations|filters|safety)`, 'i') },
  { id: 'fake_update', re: new RegExp(`you\\s+have\\s+been\\s+${FILLER}(updated|upgraded|patched)\\s+to`, 'i') },
  { id: 'identity_override', re: /\bname\s+yourself\s+\w+/i },

  // ── 中文注入（用户内容以中文为主，保守补充三条经典模式） ──────────
  { id: 'zh_ignore_instructions', re: /忽略(之前|以上|所有)?(的)?(指令|指示|规则)/ },
  { id: 'zh_disregard_instructions', re: /无视(以上|之前|所有)?(的)?(指令|指示|规则)/ },
  { id: 'zh_forbid_rules', re: /(不要|禁止)(遵守|执行)(之前|以上)?(的)?(指令|规则)/ },

  // ── 回连 / 外传 ────────────────────────────────────────────────
  { id: 'exfil_curl', re: /curl\s+[^\n]{0,2048}\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i },
  { id: 'exfil_wget', re: /wget\s+[^\n]{0,2048}\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i },
  { id: 'read_secrets', re: /cat\s+[^\n]{0,2048}(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i },
  { id: 'send_to_url', re: /(send|post|upload|transmit)\s+[^\n]{0,2048}\s+(to|at)\s+https?:\/\//i },
  { id: 'context_exfil', re: new RegExp(`(include|output|print|share)\\s+${FILLER}(conversation|chat\\s+history|previous\\s+messages|full\\s+context|entire\\s+context)`, 'i') },

  // ── 后门 / 持久化 ──────────────────────────────────────────────
  { id: 'ssh_backdoor', re: /authorized_keys/i },
  { id: 'ssh_access', re: /\$HOME\/\.ssh|~\/\.ssh/ },
  { id: 'agent_config_mod', re: new RegExp(`(update|modify|edit|write|change|append|add\\s+to)\\s+[^\\n]{0,2048}(?:AGENTS\\.md|CLAUDE\\.md|\\.cursorrules|\\.clinerules)`, 'i') },
  { id: 'agent_config_mod_zh', re: /(修改|编辑|写入|追加|添加)(以上|之前)?(的)?(指令|规则|配置)/ },

  // ── 硬编码密钥 ─────────────────────────────────────────────────
  { id: 'hardcoded_secret', re: /(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}/i },
]

/** 不可见 / 双向 Unicode 字符（定向隔离符 U+2066–U+2069 等是真实的注入工具）。 */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069]/

/**
 * 扫描一段记忆内容，返回命中模式 ID 列表；未命中返回空数组。
 * 输入被截断到 MAX_SCAN_CHARS，保证最坏情况耗时可控。
 */
export function scanThreats(content: string): string[] {
  const text = content.slice(0, MAX_SCAN_CHARS)
  const hits: string[] = []
  for (const pattern of PATTERNS) {
    if (pattern.re.test(text)) hits.push(pattern.id)
  }
  if (INVISIBLE_CHARS.test(text)) hits.push('invisible_unicode')
  return hits
}

/** 首个命中模式的错误文案；未命中返回 null。 */
export function firstThreatMessage(content: string): string | null {
  const hits = scanThreats(content)
  if (hits.length === 0) return null
  return (
    `内容包含威胁模式（${hits.join(', ')}），已拒绝写入。` +
    '记忆会进入 system prompt，必须干净；如确有需要，请改写措辞后重试。'
  )
}
