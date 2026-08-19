# dsh-tool-memory —— DeepSeek Harness 跨会话持久记忆插件

> 把 [Hermes Agent 的 memory 工具](https://github.com/NousResearch/hermes-agent/blob/main/tools/memory_tool.py)
> 的机制移植到 DeepSeek Harness：**有界、纯文本、跨会话**的记忆。
> `MEMORY.md` 与 `USER.md` 是唯一的持久化真源；可在设置页选择传统**冻结快照**
> 或低噪声的**智能动态召回**。默认保持冻结快照，现有工作流不变。

## 记忆机制（与 Hermes 对齐）

| 机制 | Hermes | 本插件（DSH） |
| --- | --- | --- |
| 存储 | `~/.hermes/memories/MEMORY.md` + `USER.md` | `<root>/MEMORY.md` + `USER.md`（默认 `$DSH_HOME/memories`） |
| 条目格式 | `§` 分隔的纯文本列表，可多行 | 同左（分隔符 `\n§\n`，与 Hermes 逐字符一致） |
| 两个存储 | MEMORY=代理笔记；USER=用户画像 | 同左 |
| 字符预算 | 2200 / 1375 字符（按字符数，模型无关） | 同左（可用配置覆盖） |
| 注入策略 | 会话开始时注入完整记忆 | 默认 `snapshot`：插件加载 + `session/created` 时重建完整快照；可选 `recall`：每轮仅注入相关条目与 USER 长期核心 |
| 工具面 | 单工具 `memory` + `action` 参数 | DSH 惯例拆分：`memory_add/replace/remove/batch/show/refresh` |
| 定位 | replace/remove 用短唯一子串匹配，非 ID | 同左；歧义报错引导更具体 |
| 预算超限 | 返回合并引导错误（列出当前条目），本轮内合并后重试 | 同左（错误信息含条目清单与占用） |
| 批量 | `apply_batch` 原子、对最终预算校验 | 同左（all-or-nothing） |
| 写安全 | 锁文件 + 原子写 + 漂移保护（外部内容不 round-trip → 拒写 + `.bak` 快照） | 进程内互斥 + 原子 rename + 同款漂移保护 |
| 威胁扫描 | 写前扫描（strict 作用域）+ 快照构建时屏蔽毒条目 | 同左（英文模式移植 + 3 条保守中文模式 + 不可见 Unicode） |
| 成功响应 | 终态：报占用、不回显条目（防重复调用） | 同左（`note: 写入已完成，不要重复执行`） |

## 安装

```bash
# 在 deepseek-harness 环境内
dsh plugin add dsh-tool-memory
```

插件注册 3 个 system-prompt section（笔记快照 / 画像快照 / 首次使用引导）与 6 个工具，用自然语言直接指挥即可：

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `memory_add` | `content`（必填）, `target?` | 追加一条记忆（默认 memory=我的笔记；user=用户画像） |
| `memory_replace` | `old_text`, `new_content`, `target?` | 替换「包含 old_text 子串」的条目 |
| `memory_remove` | `old_text`, `target?` | 删除「包含 old_text 子串」的条目 |
| `memory_batch` | `operations`（必填）, `target?` | 原子批量（删旧加新一次完成） |
| `memory_show` | `target?` | 查看活状态条目与占用 |
| `memory_refresh` | — | 手动重读磁盘并重建快照（通常无需调用） |

## 初始化模式（首次使用）

用户画像（USER.md）为空时，system prompt 会自动注入一段**首次使用引导**，
由模型主动向用户提问（怎么称呼、做什么工作/项目、沟通偏好等）：

- 用户回答后，模型把信息整理成条目写入 USER.md；
- 画像一旦有内容，引导 section 返回空——**引导自动消失，无需删除任何文件**
  （判据就是「USER.md 是否为空」，清空画像即重新初始化）；
- 不想介绍可直接回复「跳过」，引导会在下次会话再次出现。

示例对话：

> - “记住：这个项目的文档任务用反向工作流”
> - “把『codex CLI』那条更新为 v0.148”
> - “删掉『临时备注』那条”
> - “我改过 MEMORY.md 了，刷新一下记忆”
> - “你记得我有什么工作习惯吗？”（模型从 system prompt 快照回答）

## 后台记忆自动沉淀（后台记忆评审）

> 机制对齐 [Hermes 的后台自改进循环](https://github.com/NousResearch/hermes-agent/blob/main/agent/background_review.py)：
> 对话中自然暴露的用户偏好、纠正、环境事实（“别这么啰嗦”“记住这个项目用反向工作流”）
> 不再需要模型主动 `memory_add`——插件每 N 条用户消息自动跑一次**隔离子代理评审**，
> 把值得长期记住的信息沉淀进 MEMORY.md / USER.md。

**机制：**

1. 插件监听 `session/event` 事件流，**只对用户消息**（`user/message`）计数；
   纯工具回合是执行细节，不计入（评审信息来源是用户消息，避免高频空转）。
   会话恢复/续接时从历史事件流对齐取模，续上原来的 N 节奏。
2. 每 N 条（默认 10）触发一次评审：把**最近 24 条**对话 verbatim 转写
   （`USER:` / `ASSISTANT:`，工具调用只列名字、正文截 200 字符）打包，
   用 `ctx.subagents` 程序化拉起一个**隔离子代理**执行：
   - 评审代理**只拥有 memory_\* 工具**（`toolFilter` 白名单），
     无法执行 shell、读写文件或调用其他工具，不污染主会话；
   - 提示词要求评审代理**先 `memory_show` 读活状态**再决定增删改
     （system prompt 里的 MEMORY/USER 块是会话开始时冻结的，可能已过时）；
   - 容量超限时用 `memory_replace`/`memory_remove` 合并腾出空间，
     或一次 `memory_batch` 完成“删旧 + 加新”；
   - 评审与主会话共用同一个 MemoryStore 实例，写路径的进程内互斥 +
     锁内重读天然串行化并发写。
3. 评审结束后按 `reviewNotify` 三档发通知（投递走 agent 的 inbox：
   空闲时唤醒、忙碌时排队到下一步；`form: 'notice'`，GUI 折叠展示）：
   - `off`：不发通知；
   - `on`（默认）：`💾 Memory updated（+n 条）` 或 `Nothing to save`；
   - `verbose`：追加具体增删改条目摘要。
4. 同一会话**并发防抖**：一个评审未结束时不会启动第二个（计数继续，
   到下一个 N 的倍数再触发）。
5. 评审子代理的传输默认用标准进程内 `spawn` provider（未注册或不支持工具过滤时
   回退到第一个支持 `toolFilter` 的 provider）；`reviewProvider`/`reviewModel`
   只控制评审子代理的**模型路由**（留空=跟随主 agent 的 provider/model，
   可配便宜模型省成本）。

**降级说明**（配置保留、功能跳过、不崩溃）：运行时未注册 subagent provider、
没有支持 `toolFilter` 能力的 provider、或会话没有关联的活 agent 时，
评审自动跳过并 `console.log` 说明原因，三档通知配置仍保留；
没有任何活 agent 可投递时通知降级为 `console.log`。

```yaml
- id: memory
  name: dsh-tool-memory
  config:
    nudgeInterval: 10      # 每 N 条用户消息触发一次后台评审；0=关闭自动评审
    reviewProvider: ''     # 评审子代理的 LLM provider（路由）；留空=主 agent 的
    reviewModel: ''        # 评审子代理的 LLM model；留空=主 agent 的
    reviewNotify: 'on'     # 评审完成通知：off / on / verbose
```

## 插件配置

在 profile / 组合包层的 `cordis.patch.yml` 中按需覆盖，也可在 DSH 的“设置 → 记忆”页面用两张模式卡片保存：

```yaml
- id: memory
  name: dsh-tool-memory
  config:
    root: '/abs/path/to/memories'   # 默认：$DSH_HOME/memories（DSH_HOME 或 ~/.dsh）
    memoryCharLimit: 2200           # MEMORY.md 字符预算
    userCharLimit: 1375             # USER.md 字符预算
    nudgeInterval: 10               # 每 N 条用户消息触发一次后台评审；0=关闭
    reviewProvider: ''              # 评审子代理的 LLM provider（路由）；留空=主 agent 的
    reviewModel: ''                 # 评审子代理的 LLM model；留空=主 agent 的
    reviewNotify: 'on'              # 评审完成通知：off / on / verbose
    injectionMode: 'snapshot'       # snapshot=传统冻结快照（默认）；recall=智能动态召回
    recallTopK: 3                   # recall 最多注入的动态记忆条数（1–6）
    recallMaxChars: 1200            # recall 动态记忆总字符预算（200–4000）
    recallPerItemChars: 420         # recall 单条动态记忆预算（80–1200）
    recallEmbeddingEnabled: false   # 可选语义增强；默认关闭，不主动发起网络请求
    recallEmbeddingBaseUrl: 'https://api-inference.modelscope.cn/v1' # OpenAI 兼容 embedding API 根地址
    recallEmbeddingApiKey: ''       # 本机 profile 保存的 API Key；不要提交或共享此配置文件
    recallEmbeddingModel: 'Qwen/Qwen3-Embedding-8B' # 请求中的 embedding 模型标识
```

### 智能动态召回

选择 `injectionMode: 'recall'` 后，插件会在每个真实用户请求的首次模型 step 中重新读取两份共享文件：

- `USER.md` 中同时标记为 `always / permanent / active / global` 的合法核心条目会常驻；
- 其余有效条目经词法、内存 BM25、短语/标签和 RRF 选择，未通过强证据门控时不注入任何动态记忆；
- `never`、`superseded`、`archived` 或已过 `valid_until` 的条目不会参与；
- 结果受条数和字符预算限制，历史威胁条目会显示屏蔽占位符；
- 可选 embedding 语义增强默认关闭。设置页可填写 OpenAI 兼容的 Base URL、API Key 与模型名；API Key 只保存在本机 profile 配置中，状态 API、运行状态和日志均不返回该值。缺少密钥、超时或服务失败均会自动回退到本地检索；不创建向量数据库或其他持久化索引。

动态上下文以 `memory-recall` 插件来源标记，后台记忆评审会自动排除它，不会把注入文本再次沉淀为记忆。

## 记忆文件格式

`MEMORY.md` 就是纯文本条目列表，可随时用编辑器查看/修改：

```
codex CLI 已装 ~/.local/bin/codex(v0.147.0)，登录态有效
§
流水线工具 wf 在 ~/work/bao/baoagent/workflow/wf，命令: init/start/done
§
用户网络位置上海：依赖库/大文件下载优先国内镜像
```

- **手动编辑会被尊重**：写入前插件会重新读盘；无法 round-trip 的内容触发**漂移保护**
  ——拒绝写入并保存 `MEMORY.md.bak.<时间戳>` 快照，绝不静默丢弃你的手改。
- 编辑后想让新会话之外、当前会话也立即生效，调用一次 `memory_refresh`。

## 设计说明（与 Hermes 的有意差异）

1. **冻结快照的时机**：Hermes 在会话开始冻结；本插件在**插件加载**与
   `session/created` 时重建快照（DSH 的会话事件），语义等价；另提供
   `memory_refresh` 工具覆盖「手动编辑后立即生效」的场景（会打破 prefix cache，属有意操作）。
2. **跨进程并发**：Hermes 用 fcntl 锁文件；Node 无标准等价物，本插件用
   **进程内 promise 互斥**（同一 DSH 进程内多 agent 并发写串行化）+
   **原子 rename**（读者永远看到完整文件）+ **漂移保护**（跨进程外部写入不被覆盖）。
   单进程 DSH 部署下三者已闭环。
3. **`{{变量}}` 转义**：DSH 的 system prompt 装配会对 section 做 `{{name}}`
   插值，未注册变量会直接抛错。记忆内容里的模板/代码片段（如 `{{user}}`）
   会被自动转义为 `{​{`（零宽空格分隔），保证装配永不被打断。
4. **威胁扫描**：移植 Hermes strict 作用域模式（注入/越狱/回连/外传/后门/硬编码密钥）
   并补了 3 条保守的中文模式；命中即拒写；历史毒条目在快照中替换为
   `[BLOCKED: …]` 占位符，原文保留在文件里供检查删除。
5. **每回合合并失败上限**（Hermes issue #42405 的循环保护）未移植——
   DSH 工具调用模型侧自带预算约束；成功响应保持终态防抖。

## 开发与测试

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest：MemoryStore 单元测试 + 插件装配/快照语义测试 + 后台评审测试
pnpm build       # tsdown → lib/
```

测试覆盖：§ 分隔持久化、预算与合并引导、批量原子性、漂移保护与 `.bak`、
威胁拦截与快照屏蔽、读失败保护、冻结快照语义（中途写入不改 prompt、
`session/created` 与 `memory_refresh` 重建快照）、`{{变量}}` 转义、
后台评审（计数触发、取模对齐、纯工具回合不计入、并发防抖、对话打包格式、
子代理 toolFilter 白名单与提示词、通知三档、provider/agent 缺失降级）。

## License

MIT
