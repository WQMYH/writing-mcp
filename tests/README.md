# Writing MCP 测试覆盖清单

> 文档定位：这是 `docs/IMPLEMENTATION_STATUS.md`「当前测试覆盖」一节的**详细清单宿主**。状态文档只保留概述与指向本文件的抽取路径；本文件随测试文件一起维护。
>
> 运行：`pnpm build && pnpm test`（vitest）。基准门禁：`pnpm benchmark`。lint 门禁：`pnpm lint`（oxlint，0 警告；`store.ts` 暂因 minified-file 启发式被忽略，AUD-035 拆分后移除）。覆盖率棘轮门禁：`pnpm coverage`（阈值见 `vitest.config.ts`）。私有语料验收：`pnpm benchmark:private`（需 `WRITING_MCP_PRIVATE_ACCEPTANCE`）。

## 测试文件 → 主题映射

| 文件 | 主题 |
|---|---|
| `baseline.test.ts` | M0 基线：整书 166 Token、10/10 事实召回、证据覆盖 100%、61.24% 降幅 |
| `benchmark.test.ts` | 30 个机器可读基准任务的确定性门禁 |
| `diagnostics.test.ts` | 诊断链：脱敏、显式 query 策略、捕获序号、JSON/Markdown 产物、SHA-256、幂等 finish、关闭运行引用、不可持久化降级、AUD-023 开发捕获有界命中 ref/score/locator 哈希（不存正文）、AUD-024 general JSONL 串行轮转/并发不丢不乱/写失败降级 |
| `epub.test.ts` | EPUB：正常双章节 spine、OPF 属性顺序变化、元数据标题、封面过滤、跨 spine 续章、单作品多 EPUB 引用隔离、损坏 ZIP/缺 container/缺 OPF/无可读 spine 四类失败 |
| `epub-resource-limits.test.ts` | AUD-028 EPUB 资源上限：entry 数超限 `EPUB_TOO_MANY_ENTRIES`、单文档超限 `EPUB_DOCUMENT_TOO_LARGE`、总解码量超限 `EPUB_TOTAL_TOO_LARGE`（均可经构造器注入）、EPUB 2.0 包在默认上限下正常加载 |
| `explore-bfs.test.ts` | 0~3 跳 BFS、fan-out/全局上限、逐边 pathEvidence、截断 |
| `generic-txt.test.ts` | TXT：GBK/GB18030 解码、章节切分、章节编号重置推断新卷、原始文件行号偏移 |
| `graph-identity-evidence.test.ts` | schema v4 图：重复 Chapter 标题独立身份、按源 ordinal 排序、同名实体全部定义、规范来源晋升、多次 mention、多 span 关系证据 |
| `index-lifecycle.test.ts` | 索引生命周期：不兼容 schema 只读报告/显式重建、失败事务保留上一 revision、未解析引用入库、status stale 语义、源顺序 snapshot、中断恢复、writer lock、增量影响范围、实体变化刷新引用 |
| `inkos-fixture.test.ts` | InkOS：静态最小 fixture 的稳定作品引用、原生文档类型、章节编号 |
| `mcp-stdio.test.ts` | MCP stdio：枚举五工具、顺序调用 resolve/index/explore/context/diagnose、诊断 hook、结构化错误信封 |
| `mvp.test.ts` | 通用链路：resolve→rebuild→中文搜索→context→无变化索引→entity/neighborhood→单章增量；适配器优先级；并发串行 |
| `path-security.test.ts` | 授权 roots 缺失/越界、symlink/junction 越界、service 层强制 roots |
| `resolve-matrix.test.ts` | 作品识别矩阵：空目录、不支持扩展名、多书歧义、同目录直接文件隔离、InkOS 新旧结构 |
| `search-correctness.test.ts` | 检索正确性：无分词中文问句、空分析、真无结果、别名、重复 Chapter、替代定义、未解析引用、重复运行排序、输入上限、响应字节上限（RESPONSE_TRUNCATED） |
| `service-reuse.test.ts` | AUD-021 源复用：未变化源连续 explore/context 零重载（计数适配器）、源编辑可见、超大 query 拒绝 |
| `context-required-refs.test.ts` | AUD-005 requiredRefs 直接解析：池外 span/entity 强制命中、不存在 ref 进 omitted（not_found）、直解 ref 触发 budget_unsatisfiable、池内去重与优先 |
| `context-source-registry.test.ts` | AUD-013 来源提供器注册表：ENTITY_KINDS 全覆盖的语义分层映射、小写文档类型归一（character/state/foreshadow→L1，chapter/outline→L2，document/未知→L3）、required 晋升 L0、evidenceHash 折叠去重（required 前置保护、duplicate_evidence 进 omitted）、预算压力下自 L3 向低层裁剪、真实路径 L1 归属与不得整体落 L3 护栏 |
| `bfs-batching.test.ts` | AUD-020 批量化护栏：宽图每节点 fan-out 确定性截断与重复运行一致、宽图 BFS 在确定性耗时预算内完成 |
| `timeline.test.ts` | AUD-015 timeline 独立投影：章节+precedes 时序按章节位置排序、名称过滤、未知章节锚点稳定殿后、无时态数据 NO_RESULTS |
| `graph-vocabulary.test.ts` | AUD-022 词汇表冻结：索引实体 kind 含 OutlineNode 且不超出 ENTITY_KINDS、边 kind 不超出 EDGE_KINDS、InkOS/generic 能力声明不超出 WORK_CAPABILITIES |
| `timeline-tense-filter.test.ts` | AUD-012 章节时态过滤：targetChapter 锚点只保留当时态有效的实体/边（无界 from/to 视为书首/书尾）、锚点外章节排除、与名称过滤组合、重复运行确定性 |
| `context-reserved-params.test.ts` | AUD-012 约束接口 MCP 契约（stdio）：explore schema 暴露 targetChapter 且锚定 timeline 排除锚点外章节实体；context schema 暴露四约束参数、taskType 值域开放（无 enum）且保留非驱动；描述声明 requiredRefs 胜出 excludeRefs 的优先级；exclude/pin 经 MCP 生效；未知 taskType 被接受且输出不变 |
| `context-constraint-wiring.test.ts` | AUD-012 约束接口接线（store 级）：excludeRefs 过滤与 excluded 报告、requiredRefs 胜出 excludeRefs、entityRefs/documentRefs 直解入 blocks 及层归属、targetChapter 锚定层内排序（同章→前距→后距）且无锚点时不生效、taskType 值域开放且任意值输出恒等、共享数据库句柄不被 context 误关、四份 ref 列表均受 CONTEXT_REFS_TOO_LARGE 校验、budget_unsatisfiable 保留各类真实 omitted 原因（excluded/not_found 不冒充预算原因） |
| `search-source-trust.test.ts` | AUD-012 残留（M3 期）source-trust 排序因子：命中查询词的 deterministic 行获 +0.25 信任加分，反超原始分更高的 alias-only heuristic 行，重复运行确定性 |
| `protocol-boundary.test.ts` | AUD-025 协议错误边界：数据 schema 单一真相源、输出失配记 failure 并返回 OUTPUT_SCHEMA_MISMATCH 一致信封、正常路径无协议错误、SDK 输入拒绝裸文本且无诊断记录、协议层未知消息经 onerror 上报 |
| `generic-work-boundary.test.ts` | AUD-026 通用作品边界：双 EPUB 目录产生两个候选并返回 ambiguous、EPUB 候选与直接解析文件同 workRef/rootPath、capabilities 由实际输入决定（纯文本目录不含 epub）、纯文本目录仍为单一作品 |
| `txt-numbering.test.ts` | AUD-027 章节编号语法：罗马数字章节不再被 Number("iv") 丢弃、中文数字支持到九百九十九（百位合成）、罗马数字重置推断新卷、非法罗马数字确定性跳过并入上一章、Markdown 中文数字章名识别为 chapter |
| `snapshot-consistency.test.ts` | AUD-029 snapshot 一致性：读取期间源持续变化拒绝 `SOURCE_CHANGED_DURING_READ`（有界重试后仍不一致）、一次性写入稳定后有界重试成功、单文件超限 `SOURCE_FILE_TOO_LARGE`、作品总量超限 `SOURCE_TOTAL_TOO_LARGE`、默认上限正常加载 |
| `span-hard-split.test.ts` | AUD-030 span 硬上限与边界规则：超长单行硬切为共享同一源行的有界 chunk、locator 不含被裁空行、相邻 span 连续平铺无重叠无遗漏且内容可重组、硬切后后续 span 行号连续、heading 边界 locator 精确 |
| `lifecycle.test.ts` | AUD-032 进程生命周期：SIGTERM/SIGINT 在时限内终止进程（POSIX 优雅 exit 0 / Windows 信号终止）、stdin EOF 优雅退出 exit 0、完整会话 stdout 只输出 JSON-RPC 且干净退出、进程内 shutdown 链先关 server 再关 service 幂等且零 stdout 写入 |

## 覆盖清单（按能力域）

### 通用文本链路

- resolve → rebuild index → 中文搜索 → context → 无变化索引 → entity/neighborhood → 单章增量更新。
- 适配器优先级：InkOS 根目录不会同时被 generic fallback 报为第二个作品。

### MCP 协议与诊断

- MCP stdio：枚举五工具，顺序调用 resolve/index/explore/context/diagnose，确认所有成功/失败响应均经过诊断 hook 并验证结构化错误信封。
- 诊断链：默认元数据脱敏、显式 query 策略、捕获序号、JSON/Markdown 产物、SHA-256、幂等 finish、关闭运行引用、不可持久化降级。
- AUD-023：开发捕获事件保存有界 `outputHits`（命中 ref/kind/sourceKind/score + locator 哈希、omitted 原因、候选 workRef，各列上限 100），正文/标题/路径不入捕获；通用 JSONL 与逐调用报告仍只保存数量。
- AUD-024：general JSONL 的轮转检查与追加在同一按目录串行队列内执行，注入小容量上限验证轮转保留最新半数、并发 20 条记录不丢不乱且保持提交顺序、写失败降级为 persistence=failed 不替换业务结果。
- AUD-025：输出 data schema 是注册信封与 wrapper 自校验的单一真相源；wrapper 记录前自校验失配抛出 `OUTPUT_SCHEMA_MISMATCH`（记 failure + isError 一致信封 + 专用 recovery）；正常 in-process 调用无协议错误；SDK 输入拒绝返回裸 isError 文本、不产生诊断记录且不写 stderr；协议层未知消息类型经注入的 onerror 上报。
- AUD-032：SIGINT/SIGTERM/stdin EOF 统一走同一优雅关闭链（先关 MCP server 再关 service）并确定性退出（exit 0，5 秒 grace guard 兜底强制终止，同步 SQLite 长操作不可取消也不能挂住进程）；stdout 专属 JSON-RPC——会话全程与关闭过程每一行 stdout 均可解析为 JSON-RPC 消息，生命周期诊断只走 stderr；`createStdioRuntime` 暴露的 shutdown 幂等且在进程内测试中零 stdout 写入。

### 检索正确性（M3）

- 无分词中文问句命中；空分析、真无结果、别名、重复 Chapter、替代定义、未解析引用、重复运行排序和输入上限均有回归。
- AUD-020 批量化护栏：宽图（hub 90+ 关联）每节点 fan-out 截断与重复运行确定性；201 文档宽图 BFS 在确定性耗时预算内完成。
- AUD-015 timeline：不再等同全文 search，而是携带时态属性实体与 precedes 时序边的确定性投影（章节位置排序）；名称过滤、未知章节锚点殿后、无时态数据 NO_RESULTS 均有回归。
- AUD-022 词汇表冻结：索引产生的实体/边 kind 与适配器能力声明均限定在冻结词汇表内（ENTITY_KINDS/EDGE_KINDS/WORK_CAPABILITIES），OutlineNode 补入 EntityKind；扩展词汇需先修订 M0 契约。
- AUD-012 章节时态过滤：writing_explore 新增可选 targetChapter（仅对 timeline 生效），投影只保留 from ≤ 锚点 ≤ to 的时态项；stdio 层验证 schema 暴露与锚定行为，context 的 targetChapter/entityRefs/documentRefs/excludeRefs 为 reserved 输入（接收验证、不改变装配，描述显式标注）。
- AUD-012 残留排序因子：search 中命中查询词的 deterministic 行获固定 +0.25 信任加分（落实 Source trust order 条款），保证不被原始分更高的 alias-only heuristic 行压过；完整重排搁置到 M4 + 代表性语料之后（M0_CONTRACT Open TODO 与 source-trust amendment）。
- 源复用：计数适配器证明未变化源连续 explore/context 零重载；源编辑后下次调用可见；超大 query 拒绝；既有 resolve/index/explore/context/status-stale/incremental 链路完整。

### 上下文装配（M4，部分）

- AUD-005：`requiredRefs` 脱离 search top-50 候选池按 entity/span/document 三级直接解析；池外必选 ref 进 blocks 且计入预算最小值，不存在 ref 以 `not_found` 进 omitted，预算不足时直解 ref 也触发 `budget_unsatisfiable`，池内重复 ref 去重。

### 基准与基线

- M0 基准：固定 fixture 上 30 个检索、实体、邻域、文档、统计和上下文任务全部命中且具有证据。
- M0 基线：整书估算 166 Token，10/10 预期事实召回，证据覆盖 100%，三项上下文任务平均 64.33 Token，降幅 61.24%。

### 私有语料（不入库）

- 私有长篇：外部 schema v2 标注包含 42 条事实、101 条逐字证据和七类知识；数据不入库、不进入 Git，运行器只输出汇总及失败 ID。
- 私有转换型 EPUB：《语料A》从 5 个 spine 文档重建为 1 前置 + 55 编号章节 + 1 尾部段落；schema v4 索引为 57 documents、121 spans、56 Chapter entities、55 `precedes` edges，3 个 span 保留跨 entry 分段 locator；原文及索引不入 Git。

### 适配器（TXT / EPUB / InkOS）

- TXT：GBK/GB18030 解码、章节切分、章节编号重置推断新卷、原始文件行号偏移。
- AUD-027 编号语法：阿拉伯数字/中文数字（一至九百九十九，含百位合成）/规范罗马数字（i…mmmcmxcix）三种章号确定性支持；命中章题形状但编号非法（如 chapter im）时确定性跳过并入上一章；卷重置推断对三种编号一致生效；Markdown 中文数字章名识别为 chapter 并解析章号。
- EPUB：正常双章节 spine、OPF 属性顺序变化、元数据标题、封面过滤、跨 spine 章节续文；单作品多 EPUB 引用隔离已升级为 AUD-026 边界语义（每个 EPUB 独立成作品，各自 documentRef 唯一），以及损坏 ZIP、缺 container、缺 OPF、无可读 spine 四类失败。
- AUD-026 作品边界：目录内每个 EPUB 独立成候选（与直接解析该文件同 workRef/rootPath），其余文本合成一个目录作品；多书目录返回 ambiguous；capabilities 由实际输入决定（纯文本作品不声明 epub），无 epub 能力的目录作品不加载 EPUB 文件。
- AUD-028 资源上限：entry 数/单文档（含 OPF）/总解码量三级确定性上限，越限返回稳定错误码而非挂起或无限膨胀；上限可经 `new GenericAdapter({ epub })` 注入（默认 4096 entries / 16 MiB / 64 MiB）；EPUB 2.0 包默认上限下正常加载。
- AUD-029 snapshot 一致性：每次适配器读取前后校验源指纹（文件名+mtime+size），不一致有界重试一次后仍不一致拒绝 `SOURCE_CHANGED_DURING_READ`；文本链路单文件/作品总量确定性上限（`SOURCE_FILE_TOO_LARGE`/`SOURCE_TOTAL_TOO_LARGE`，默认 16 MiB / 64 MiB，可经 `new GenericAdapter({ text })` 注入）。
- InkOS：静态最小 fixture 的稳定作品引用、原生文档类型和章节编号。

### 安全与作品识别

- 路径安全：MCP 缺少授权 roots 时拒绝访问，入口越界及作品目录内 symlink/junction 越界均被阻止。
- 作品识别：覆盖单书、多书歧义、空目录、不支持扩展名、同目录直接文件隔离和 InkOS 新旧结构。
- 稳定诊断：`AUTHORIZED_ROOTS_REQUIRED`、`PATH_NOT_ALLOWED`、四类 EPUB 确定性错误码、AUD-028 三个资源上限错误码与 AUD-029 源变化/文本上限错误码。

### 索引生命周期与事实性

- 索引生命周期：不兼容 schema 只读报告/显式重建、失败事务保留上一 revision、未解析方括号引用入库。
- AUD-030 span 硬上限：超长单行硬切为共享同一源行的有界 chunk（span 内容永不超 `maxChars`）；locator 精确排除被裁空行；相邻 span 连续平铺无重叠无遗漏（重叠方案已评估并拒绝：重复行会使确定性 mention/边证据重复计数）。
- 索引事实性：源正文/标题/kind/章节号/源顺序/起始行变化使 status 变 stale；同作品并发串行、live/stale writer lock、`.previous/tmp` 恢复和用户 `.gitignore` 保持。
- 增量影响范围：无关文档的派生记录不改写 revision；新增实体会重新解析其他文档中匹配的未解析引用。
- 属性图：重复 Chapter 标题保持独立身份并按源 ordinal 排序；同名实体保存全部定义且规范来源可稳定晋升；多次 mention 和多 span 关系证据不再静默丢失。
- 可重建性：删除整个 `.writing-index` 后可从原始文本恢复等价稳定引用和检索结果。

### 边界与原则

- Reference 边界：保持确定性知识访问、无 LLM、无自动写回；第五工具只增加可观测性和派生诊断文件，Scene 仅按明确分隔条件生成，World/Lore/独立 Timeline 不作为 v1 必需存储节点。

## 维护规则

- 新增测试文件时：更新「测试文件 → 主题映射」表；如覆盖了新的能力域，追加到对应分组。
- 删除/重命名测试时：同步删除对应行，避免本文件成为第二真相。
- 本文件的「覆盖清单」与 im 状态文档的概述必须语义一致；概述指向本文件，细节以本文件为准。
