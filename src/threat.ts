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
  // 修复 2：原为裸词 /authorized_keys/i，任何提及该文件名的正常运维笔记
  // （如「authorized_keys 权限保持 600」）都误报。改为锚定「写入动作 + 目标」，
  // 只降误报、不降漏报。动词覆盖中英与 shell 重定向；中文条目必须保留命中
  // （如「把公钥写入 authorized_keys」里的「写入」是真正的写动作）。
  // 与 MCP 侧（hermes-memory-mcp/src/threat.ts）的模式逐字一致。
  { id: 'ssh_backdoor', re: /(write|wrote|append|appending|add|insert|inject|echo|cat|tee|写入|追加|添加|添加公钥|公钥写入|cat\s*>|>>)\s*[^\n]{0,2048}authorized_keys|authorized_keys[^\n]{0,64}(写入|追加|添加|添加公钥|append|add|write)/i },
  // 修复 2 的同类收紧（用户许可的范围外扩展）：原为 /\$HOME\/\.ssh|~\/\.ssh/，
  // 即「只要提到 ~/.ssh 就命中」。实测三条正常运维表述全部误报
  // （「~/.ssh 的权限应为 700」「ssh-keygen 会生成到 ~/.ssh/」
  // 「检查了一下 ~/.ssh/authorized_keys 没有异常条目」），且判据本身
  // 不区分私钥与公钥/目录，真实风险反而可能漏检。
  //
  // 改为锚定「读写/外传动作 + 私钥文件名」（id_rsa/id_dsa/id_ecdsa/
  // id_ed25519/identity，且用 (?![\\w.]) 排除 .pub 公钥）。反向模式
  // （文件名在前、动作在后）覆盖中文「内容/发给我/回显」等无前置动词的写法。
  // 与 MCP 侧（hermes-memory-mcp/src/threat.ts 的 ssh_access，其注释标为
  // 「修复 13」，注意与 store.ts 的修复 13 不是同一项）逐字一致。
  {
    id: 'ssh_access',
    re: new RegExp(
      '(?:cat|less|more|head|tail|strings|xxd|od|dd|read|reads|reading|print|prints|output|outputs|show|shows|display|dump|dumps|copy|copies|cp|mv|rsync|tar|zip|base64|send|sends|sending|upload|uploads|steal|steals|stealing|grab|grabs|fetch|fetches|exfiltrate|echo|tee|scp|sftp|curl|wget|nc|读取|回显|输出|打印|发送|发给|上传|外发|泄露|贴出|导出|复制|备份)\\s*[^\\n]{0,2048}?\\.ssh/(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|identity)(?![\\w.])' +
        '|(?:\\.ssh/(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|identity)(?![\\w.])[^\\n]{0,64}?(?:内容|发给我|发过来|回显|贴出|输出|导出|上传|外发|泄露|send|upload|print|output|leak|dump|steal|copy))',
      'i',
    ),
  },
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

/**
 * 首个命中模式的错误文案；未命中返回 null。超长内容拒绝写入。
 *
 * 修复 3：scanThreats 只扫前 MAX_SCAN_CHARS 字符（有意的性能保护，不移除）。
 * 修复前这里直接用 scanThreats 的截断结果，导致「投毒词放在第 66000 字符」
 * 可绕过扫描写入。现在改为**拒绝超长写入**而非静默截断后放行——无法完成扫描
 * 就不放行。
 *
 * scanThreats 本身保持原样：它仍服务于快照渲染与召回过滤等**只读**路径，
 * 那里没有「写入规避」风险，截断只为耗时可控。
 */
export function firstThreatMessage(content: string): string | null {
  // 超长内容无法完成威胁扫描：拒绝而非静默截断，杜绝窗口外绕过
  if (content.length > MAX_SCAN_CHARS) {
    return (
      `内容长度 ${content.length} 字符，超过单条扫描上限 ${MAX_SCAN_CHARS} 字符，已拒绝写入。` +
      '超长内容无法完成威胁扫描；请拆分为多条后重试。'
    )
  }
  const hits = scanThreats(content)
  if (hits.length === 0) return null
  return (
    `内容包含威胁模式（${hits.join(', ')}），已拒绝写入。` +
    '记忆会进入 system prompt，必须干净；如确有需要，请改写措辞后重试。'
  )
}
