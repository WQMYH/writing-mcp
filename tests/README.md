# Writing MCP 测试覆盖清单

> 文档定位：这是 `docs/IMPLEMENTATION_STATUS.md`「当前测试覆盖」一节的**详细清单宿主**。状态文档只保留概述与指向本文件的抽取路径；本文件随测试文件一起维护。
>
> 运行：`pnpm build && pnpm test`（vitest）。基准门禁：`pnpm benchmark`。私有语料验收：`pnpm benchmark:private`（需 `WRITING_MCP_PRIVATE_ACCEPTANCE`）。

## 测试文件 → 主题映射

| 文件 | 主题 |
|---|---|
| `baseline.test.ts` | M0 基线：整书 166 Token、10/10 事实召回、证据覆盖 100%、61.24% 降幅 |
| `benchmark.test.ts` | 30 个机器可读基准任务的确定性门禁 |
| `diagnostics.test.ts` | 诊断链：脱敏、显式 query 策略、捕获序号、JSON/Markdown 产物、SHA-256、幂等 finish、关闭运行引用、不可持久化降级 |
| `epub.test.ts` | EPUB：正常双章节 spine、OPF 属性顺序变化、元数据标题、封面过滤、跨 spine 续章、单作品多 EPUB 引用隔离、损坏 ZIP/缺 container/缺 OPF/无可读 spine 四类失败 |
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
| `bfs-batching.test.ts` | AUD-020 批量化护栏：宽图每节点 fan-out 确定性截断与重复运行一致、宽图 BFS 在确定性耗时预算内完成 |

## 覆盖清单（按能力域）

### 通用文本链路

- resolve → rebuild index → 中文搜索 → context → 无变化索引 → entity/neighborhood → 单章增量更新。
- 适配器优先级：InkOS 根目录不会同时被 generic fallback 报为第二个作品。

### MCP 协议与诊断

- MCP stdio：枚举五工具，顺序调用 resolve/index/explore/context/diagnose，确认所有成功/失败响应均经过诊断 hook 并验证结构化错误信封。
- 诊断链：默认元数据脱敏、显式 query 策略、捕获序号、JSON/Markdown 产物、SHA-256、幂等 finish、关闭运行引用、不可持久化降级。

### 检索正确性（M3）

- 无分词中文问句命中；空分析、真无结果、别名、重复 Chapter、替代定义、未解析引用、重复运行排序和输入上限均有回归。
- AUD-020 批量化护栏：宽图（hub 90+ 关联）每节点 fan-out 截断与重复运行确定性；201 文档宽图 BFS 在确定性耗时预算内完成。
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
- EPUB：正常双章节 spine、OPF 属性顺序变化、元数据标题、封面过滤、跨 spine 章节续文、单作品多 EPUB 引用隔离，以及损坏 ZIP、缺 container、缺 OPF、无可读 spine 四类失败。
- InkOS：静态最小 fixture 的稳定作品引用、原生文档类型和章节编号。

### 安全与作品识别

- 路径安全：MCP 缺少授权 roots 时拒绝访问，入口越界及作品目录内 symlink/junction 越界均被阻止。
- 作品识别：覆盖单书、多书歧义、空目录、不支持扩展名、同目录直接文件隔离和 InkOS 新旧结构。
- 稳定诊断：`AUTHORIZED_ROOTS_REQUIRED`、`PATH_NOT_ALLOWED` 以及四类 EPUB 确定性错误码。

### 索引生命周期与事实性

- 索引生命周期：不兼容 schema 只读报告/显式重建、失败事务保留上一 revision、未解析方括号引用入库。
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
