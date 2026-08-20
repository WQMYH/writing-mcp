# Writing MCP MVP 实施状态

> **本文档是 Writing MCP 实施状态的唯一事实源。** v2 计划、README、REVIEW 文档均只引用本文件，不维护状态副本；任何"当前做到哪、多少测试、哪些 AUD 已关闭"的判断以本文为准。发现其他文件记载状态时，以本文为准并修正该文件。
>
> 检查点时间：2026-08-21（Task 3 图与上下文契约硬化）
> 当前状态：A1=SourceSnapshot/fingerprint 一致性与恢复；A2=评测实验隔离与只读门禁；Task 3=`mentions` 冻结词汇与 `ContextPacket.accountingScope` 已完成。当前验证为 146 项测试、lint 0 警告、公共基准 30/30、coverage lines 93.01%；私有 top-20 历史基线为 40/42、required 15/16，gold @50 候选门禁与 PRF 验收严格区分。response-size、EPUB UTF-8 byte accounting、lifecycle 与 PRF 仍已重开，M4 不得宣称完成。

## 恢复入口

```powershell
cd E:\Programming\AI\Agents\Writing\writing-mcp
pnpm install
pnpm build
pnpm lint
pnpm benchmark
pnpm test
```

五个 MCP 工具由 stdio server 暴露：

```powershell
pnpm start
```

实现中断后，依次运行 `pnpm build`、`pnpm lint`、`pnpm benchmark` 和 `pnpm test`。四者都通过后，才可继续增加功能；`pnpm coverage` 提供覆盖率棘轮门禁（阈值见 `vitest.config.ts`）。

历史验证（2026-08-16）：65 项测试的计数已过期，仅保留其早期 fixture 结果作追溯；当前测试计数见文首与「当前测试覆盖」。

最近验证（2026-08-17，AUD-012 接线后）：tsc 0 错、lint 0 警告、benchmark 30/30（recall 1.0 / evidence 1.0 / Token 降幅 61.24%）、store 级接线脚本 16/16（exclude/pin/锚定/未知 taskType 非驱动/db 句柄存活回归/确定性）；vitest 全量须在用户环境运行（会话沙箱 spawn EPERM 既定边界，`pnpm test`）。

历史记录（2026-08-19）：此前重排验证已作废并回退至 6 因子基线；其中的测试数量和“门禁未落地”描述仅供追溯，不能作为当前状态。

最近验证（2026-08-20，评测仪表重写 + P1 卷感知切分修复后，`214bb8f`/`ab4af79`）：口径用户拍板 gold-span hit（逐字包含 + ref 匹配），唯一宿主 `scripts/gold-hit.mjs`；仪表自检全过（单调性、阴性对照 hit=false、冒烟）。P1 修复：holdout 切分按卷取前3+后2，territories 从语料章题现算（卷1:1-30 head 1-3 tail 29-30；卷2:1-25 head 1-3 tail 24-25），切分恢复计划 §250 的 18/24。**6 因子真基线**：train（18 条）recall@5=77.8% / @10=83.3% / @50=100%，MRR=0.580，required@50=1.0；holdout（24 条）@5=83.3% / @10=91.7% / @50=100%，MRR=0.690，required@50=1.0。**miss 归因**（attribute-misses.mjs）：train 4 条 + character-001 全部 L2 候选可达、非 tie-break——纯排序因子问题，核心是 coverage 缺口（查询词 vs 证据 span 措辞不重叠，如 event-004 查询"受伤/住院"而引文是"病床/点滴瓶"）。待办：逐因子 ablation 落盘（预期：删因子不会动黄金门禁，价值在证明不可删）、门禁脚本 + baseline.json 快照、契约重新 ratify。

历史记录（2026-08-20）：`WRITING_MCP_ABLATE` 运行时开关与会写基线的 legacy gate 已被 A2 替换为 `evaluateSearch` 显式注入与只读门禁；本段旧测试计数不代表当前状态。

## 已实现闭环

- TypeScript monorepo：`core`、`adapter-inkos`、`adapter-generic`、`mcp-server`。
- Node.js 24 内置 `node:sqlite`，SQLite 3.53 和 FTS5 trigram。
- `writing_resolve`、`writing_index`、`writing_explore`、`writing_context`、`writing_diagnose`。
- InkOS 书籍识别，新旧大纲路径、角色目录、状态、伏笔和章节读取。
- Markdown、UTF-8/GB18030 TXT 和 EPUB OPF/spine 解析；单文件 TXT 支持章节切分、卷内编号重置与原始行号保留，转换型 EPUB 支持作品元数据、封面过滤、正文清洗和跨 spine 内部章节切分。
- 项目内 `.writing-index/<workId>/index.sqlite`。
- schema v4 派生索引：保留 schema v3 语义快照/恢复语义，并增加作品内顺序、卷/局部章节号、work/document 作用域实体身份、定义集合、关系多证据和分段 source locator。
- `writing_index(status)` 重新加载当前来源，源有待处理变化时返回 `stale` 和 `INDEX_SOURCE_CHANGED`。
- 同作品操作进程内串行；写操作使用可回收 PID lock，外部占用返回 `INDEX_BUSY`；中断替换可从 `.previous` 恢复并清理 schema-owned 临时文件。
- `.writing-index/.gitignore` 仅在缺失时创建，不覆盖用户已有内容。
- Span 全文检索、角色实体、全部 mention、`contains`/`appears_in`/`mentions`/`precedes` 关系；实体/边 identity hash 与 evidence hash 分离，公共证据返回可验证 excerpt hash 和 revision。
- 基础 entity/neighborhood/document/stats/search 查询。
- 确定性中文问句分析、查询/引用/预算上限、稳定 LIMIT 前排序，以及空分析/真无结果/FTS 降级诊断。
- entity 查询读取持久化 aliases，并通过 `ambiguous` 返回重复实体、替代定义和未解析引用；存在歧义时不自动扩展 neighborhood。
- 抽取式上下文选择、Token 估算和预算上限。
- MCP stdio 客户端端到端测试。
- 五工具均发布对象型 `outputSchema`，成功和失败统一采用可验证的结构化信封。
- 所有公共工具通过同一个 server-side post-call diagnostic wrapper；成功和失败均返回 `traceId`、`executionSummary`、持久化状态和报告引用，不依赖 prompt 提醒。
- 每次调用静默写入脱敏 JSON 报告和有界 JSONL 事件；显式 `start_capture → diagnosticRunRef → finish_capture` 可生成小规模真实使用链的规范 JSON 和可选 Markdown。
- 诊断产物只保存 MCP 可观察的参数/结果摘要、错误、耗时、revision、证据引用、截断和 Token 指标；默认不保存查询文本，也不保存正文、绝对路径、堆栈、SQL 或凭据。
- `benchmarks/m0.json` 已建立 30 个机器可读任务，并由 `tests/benchmark.test.ts` 执行确定性门禁。
- `docs/M0_CONTRACT.md` 已冻结引用格式、SQLite v1、查询限制、初始排序、Token 估算与 MCP 结果规则。
- `docs/REFERENCE.md` 已归纳成熟知识维护、精准检索、属性图和小说领域模型经验，并明确其为设计输入而非 v1 承诺。
- 风险审阅已落实进 v2：技术选型对齐，M3/M4 公共参数与性能成为显式门禁，M5 增加真实语料验收集前置条件。

## 里程碑完成度

| 里程碑 | 状态 | 已完成 | 未完成门禁 |
|---|---|---|---|
| M0 | 主体完成 | 版本化协议/存储合同、五工具 schema、统一信封、最小 fixture、30 个任务、Token/事实基线 | 指标含义和实现契约继续校准 |
| M0.1 | ✅ 完成 | 全工具诊断 wrapper、显式 capture、脱敏与报告哈希、开发捕获有界命中 ref（AUD-023 主体）、general JSONL 串行轮转与并发/写失败护栏（AUD-024 主体）、协议层错误边界（AUD-025 主体） | — |
| M1 | 补强中 | 授权 roots、realpath/链接防护、InkOS、Markdown/TXT/EPUB、跨 spine 分段 locator、通用作品边界与 capabilities 实际化（AUD-026 主体）、章节编号语法明确化（AUD-027 主体）、EPUB 资源上限（AUD-028 主体）、snapshot 一致性与文本内存上限（AUD-029 主体）、span 硬上限与 locator 精确规则（AUD-030 主体）、进程生命周期与优雅关闭（AUD-032 主体）、工程硬化门禁与适配器模块抽离（AUD-035 第一/二阶段主体） | AUD-035 格式化阶段（用户决策延后至 M3/M4 语义冻结后的重构窗口再评估） |
| M2 | ✅ 基础门禁完成 | SQLite/FTS5、schema v4、语义 snapshot、truthful status、revision/事务、原子替换、作品级串行/写锁、恢复、work/document 作用域身份、规范定义晋升、多 mention/关系证据、源顺序图 | 后续只随 M3/M4 查询语义做受控增强 |
| M3 | 进行中 | search/entity/neighborhood/document/stats、中文问句分析、别名/歧义/未解析输出、稳定排序、输入上限、0～3 跳 BFS、timeline、词汇表、source-trust 与 A1 freshness；corpus 阈值门禁代码已落地 | 完整重排与真实长语料重测；本轮无新的长语料性能主张 |
| M4 | 进行中（已有纵向切片） | ContextPacket、预算上限、抽取式选择、AUD-005/AUD-012/AUD-013 的约束与来源装配；`accountingScope: evidence_excerpts_only` 已在 core/MCP schema/工具描述冻结；A1 已完成：adapter-owned `SourceSnapshot` 以精确枚举及前后快照保证一致读取，active state 分离 `loadedFingerprint` 与 `indexedFingerprint`，source 变化时 explore/context 重建有效索引；stats/diagnose 提供 contextSources | response-size、EPUB UTF-8 byte accounting、lifecycle 与 PRF 均重开；完整重排与真实语料重测待后续 |
| M5 | 待开始（已有纵向切片） | stdio、五工具注册、structuredContent、outputSchema、统一结果/错误/诊断信封、协议测试、单个真实转换型 EPUB 回归 | 真实 InkOS、更多 EPUB 2/3 变体、客户端安装与故障文档 |

Step 1 已关闭 AUD-003、006、011、031；Step 2 已关闭 AUD-001、002、007～010 的当前门禁；Step 3 已完成中文问句、别名/歧义、稳定排序、输入上限、FTS 降级与检索诊断（提交 `4030085`），并完成 AUD-018 时间上限（提交 `c376df7`）；AUD-021 源指纹复用修复（`service.index()` 增加指纹记录，修复 `ensureFresh` 在 `previous === undefined` 时跳过增量更新的逻辑缺陷，55/55 测试全部通过）。AUD-005（REVIEW_2026-08-16 P0，提前于 Step 3 剩余项处理）：`requiredRefs` 脱离 search top-50 候选池按 entity/span/document 三级直接解析，池外必选 ref 进 blocks 并计入预算最小值，不存在 ref 以 `not_found` 进 omitted，预算不足触发 `budget_unsatisfiable`；`ContextPacket` 形状与状态词汇未变（M0_CONTRACT 新增 M4 requiredRefs amendment）。M0.1、M1 其余问题和 M3～M5 尚未完成，现有成果不能据此宣称 Writing MCP v1 已完成。

## 当前测试覆盖

> 详细清单（测试文件 → 主题映射、按能力域的覆盖条目）见 [`tests/README.md`](../tests/README.md)。本段只保留概述，细节以测试清单为准。

- 38 个测试文件 / 144 项测试，覆盖：通用链路、MCP 协议与诊断、检索正确性、A1 SourceSnapshot/fingerprint、A2 evaluator/gold/private/corpus 只读门禁、上下文装配、BFS、timeline、图词汇、基准、TXT/EPUB/InkOS、路径安全和索引生命周期。
- 关键门禁：30/30 公共基准；无分词中文问句命中；重复 Chapter 身份独立；源变化 status 转 stale；未变化源零重载；删除索引可完整重建。

## 已知限制

- `timeline` 已实现为携带时态属性实体与 precedes 时序边的确定性投影，支持 targetChapter 章节时态过滤（AUD-012 M3 范围）。
- context 的 `targetChapter`/`entityRefs`/`documentRefs`/`excludeRefs` 已接线（AUD-012，`526ee36`）：targetChapter 锚定层内排序、entityRefs/documentRefs 直解入 blocks、excludeRefs 过滤；`taskType` 仍为保留 hint——值域开放（未知值接受并记录）、**永不影响装配**（2026-08-17 方向：无 taskType 策略引擎）。
- 角色实体提取只覆盖角色类文档 heading；查询期仅提供透明的中文称呼形态扩展，尚无持久化别名解析。
- EPUB 仍采用确定性轻量解析，尚未覆盖 DRM/加密、复杂命名空间、导航目录语义、脚注回链、图片内容和全部 EPUB 2/3 变体；内部章节切分目前依赖独占行的中英文编号标题。
- `workRef` 只在当前 server 进程中注册；重启后客户端需重新调用 `writing_resolve`。
- schema v4 writer lock 是 Writing MCP 进程间的合作式协议，不能强制无关程序释放 SQLite 句柄；此类占用稳定返回 `INDEX_BUSY`。
- A1 SourceSnapshot/fingerprint 已完成并回归覆盖：未变化时复用 store，来源变化即通过 adapter snapshot 触发一致性重读/索引；保留同 mtime/size 原地替换的明确边界，不再标记为待审阅或待落地。
- 私有 top-20 当前为 40/42，required 15/16；该 PRF 前基线与 gold @50 门禁分开报告，不能弱化为 optional-only miss。
- 中文问句分析当前是有界规则与 n-gram，不是通用分词器；问题短语表会继续通过真实调用链回归校准。
- `stats` 的 content 受 900 字符 excerpt 截断（既有模式，`item()` 切片）；`contextSources` 增大了 stats JSON，现实 kind 数下安全，但 stats 内容截断属潜在坑。
- `entityRefs`/`documentRefs` 的 pinned 块不参与 evidenceHash 去重（显式请求豁免，与 requiredRefs 一致）；已是搜索命中的 pinned ref 保持搜索命中排名，不再获得 pinned 提升。

## 下一步

- 批次 C（AUD-026～032 + AUD-035 第一/二阶段）已全部完成并审阅归档。
- AUD-035 第三阶段（Biome 格式化）已由用户决策延后：store.ts 即将被 M3/M4 修改，现在做巨型函数展开与全量格式化必然返工；正确时机是完整重排落地后（检索侧冻结）的重构窗口，届时再评估格式化是否必要。
- Corpus 阈值门禁代码已落地（索引≤60s/百万正文字符、Explore P95≤1000ms、Context P95≤500ms）；本轮只用受控 fixture 验证脚本行为，未重新运行真实长语料，历史长语料数字不得作为当前验收。
- **重构窗口按触碰面分流（2026-08-18）**：装配侧窗口已开（M4 冻结后）——context 拆 registry/sources/dedup/budget/layer 纯模块（registry+dedup 已落地，sources/budget/layer 可与完整重排并行）；检索侧窗口待**完整重排落地后**——（1）store.ts 图构建/检索 SQL 抽离；（2）移除 oxlintrc.json 对 store.ts 的 ignorePatterns 忽略项；（3）评估 Biome 格式化（若执行：quoteStyle single / semicolons asNeeded / lineWidth 120）。
- M4 剩余：response-size 上限、EPUB UTF-8 byte accounting、生命周期与 PRF 都是重开工作；`accountingScope: evidence_excerpts_only` 已冻结，但 tokenizer profile 仍延后且不构成 M4 完成。排序改动仍须以 gold 门禁与私有 PRF 验收重新裁决。
- M4 审议：已完成的来源/约束装配与 excerpt-only accountingScope 保留；A1 使用 adapter-owned `SourceSnapshot`、一致读取重试、及 `loadedFingerprint`/`indexedFingerprint` 双指纹状态语义。M4 当前剩余为 response-size、EPUB UTF-8 byte accounting、lifecycle 与 PRF；真实长语料仅待重测，不把历史数字当作本轮验收。

> 更早阶段（Step 3 / AUD-005～035）的逐条落地叙事已于 2026-08-17 移除：事实由「可追溯提交清单」与 commit message 承载，审阅结论由下节表格承载，不在此重复。

## 已审阅修复记录（原 Pending Review 节归档）

> 本节原为「待审阅修复方案」，逐条记录已执行修复的方案内容。**2026-08-16 审阅通过后归档**：方案细节见对应提交的 commit message 与 `tests/README.md`，此处只保留审阅结论，不再复制完整方案。

| AUD | 审阅结论 | 提交 | 测试 | 接口影响 |
|---|---|---|---|---|
| **AUD-025** 协议层错误边界 | ✅ 合格：输出 data schema 单一真相源、wrapper 记录前自校验（`OUTPUT_SCHEMA_MISMATCH`）、`createServer` 可注入 `onerror`→stderr、SDK 输入拒绝属协议层观察边界外 | `35fcd3f` | `protocol-boundary.test.ts` 5 项 | 加法式（新错误码 + 可选构造参数） |
| **AUD-026** 通用作品边界与 capabilities 实际化 | ✅ 合格：逐 EPUB 独立候选、多书目录 ambiguous、capabilities 由实际输入决定 | `4675458` | `generic-work-boundary.test.ts` | 仅 generic 发现语义变更（行为变更已记录） |
| **AUD-027** 章节编号语法明确化 | ✅ 合格：阿拉伯/中文（至九百九十九）/规范罗马三语法冻结、非法编号确定性跳过、卷重置一致生效 | `9ca427b` | `txt-numbering.test.ts` 5 项 | 仅解析覆盖面扩大 |
| **AUD-028** EPUB 资源上限 | ✅ 合格：三级确定性上限（4096 entries / 16 MiB / 64 MiB）、稳定错误码、可注入上限 | `0b83baf` | `epub-resource-limits.test.ts` 4 项 | 加法式（新错误码 + 新导出 + 可选构造参数） |
| **AUD-029** snapshot 一致性 | ✅ 合格：读取前后指纹校验、有界重试、文本内存上限、源变化显式错误 | `b4b2cb9` | `snapshot-consistency.test.ts` 5 项 | 加法式（新错误码 + 新导出 + 构造参数扩展） |
| **AUD-030** splitDocument 硬切与边界规则 | ✅ 合格：超长行硬切、locator 精确排除空行、连续平铺无重叠无遗漏、重叠方案拒绝 | `2f4916d` | `span-hard-split.test.ts` 5 项 | 无接口变更（仅切分行为变化） |
| **AUD-032** 进程生命周期与优雅关闭 | ✅ 合格：`createStdioRuntime` 统一关闭链、信号/stdin EOF 确定性退出、stdout 纯 JSON-RPC | `3a53209` | `lifecycle.test.ts` 5 项 | 加法式（新导出 + 行为变更：挂起→确定性退出） |
| **AUD-035-1** lint/coverage 门禁 | ✅ 合格：oxlint 0 警告、coverage 阈值棘轮、vitest 别名修复覆盖率失真 | `3041650` | 108/108 回归 | 无产品接口变更（工程基建） |
| **AUD-035-2** generic 适配器模块抽离 | ✅ 合格：21.8KB 单文件拆为 errors/numbering/txt/epub 四策略模块、公共 API 兼容、覆盖率逐位不变 | `8764652` | 108/108 回归 | 无（纯结构重构） |
| **AUD-013** 来源提供器注册表与 evidenceHash 去重 | ✅ 合格（含缺陷修复）：语义分层、required 晋升 L0、duplicate_evidence 折叠；审阅发现 kind 输入接错——searchRows 返回小写文档类型（d.kind）而注册表键为大写实体类型，全落 L3 → `d47b2da` 以 DOCUMENT_KIND_ALIASES 归一修复并补真实路径 L1/L2 断言（教训：原单元测试喂大写键绕过真实输入路径而漏检） | `2ddb40c` + `d47b2da` | `context-source-registry.test.ts` 7 项 | 无接口变更（内部装配语义） |

**审阅附注**：2026-08-16 首批三条与 2026-08-17 批次 C 六条均在已提交 HEAD 上通过 `tsc -b`、全量测试与 30/30 基准验证；2026-08-16 发现的工作区待办（AUD-028 半成品与 L102 语法错误）已在 AUD-028 提交中修复。

## 待审阅修复方案（Pending Review）

> 按用户授权（2026-08-16）自主执行的修复，逐条记录方案内容并标注待审阅；审阅通过后归档入上节。AUD-035-3（Biome 格式化）经用户决策延后至 M3/M4 语义冻结后的重构窗口再评估，评估数据保留于末条供重构窗口参考。

### AUD-012 接线审阅三缺陷修复（待审阅，2026-08-17）

- **背景**：AUD-012 接线（`526ee36`）归档审阅发现三个缺陷，已按冻结执行顺序 ① 修复，锚点见计划 Step 6「M4 审阅锚点」。
- **修复**：（1）`writing_context` 工具描述与契约/代码矛盾——描述误称 excludeRefs 胜出 requiredRefs，已修正为契约真实优先级（requiredRefs 胜出 excludeRefs，excludeRefs 胜出 entityRefs/documentRefs pin）；（2）`budget_unsatisfiable` 分支曾把 excluded/duplicates/pinned/unresolved 一律标成 `required_minimum_exceeds_budget`，已恢复各自真实原因（excluded/duplicate_evidence/budget_limit/not_found），仅 required 类承担该原因；（3）tests/README 映射漂移——补登记 `context-constraint-wiring.test.ts`、更新 `context-reserved-params.test.ts` 条目为约束接口措辞。另修复接线测试偶发：ch3 夹具标题补查询词使确定性 heading 加分打破三方同分，无锚点断言改为确定性首块断言。
- **验证**：tsc 0 错、122/122 测试、30/30 基准、lint 0 警告、coverage lines 92.91%≥90。
- **契约**：M4 constraint-interface wiring amendment 补两条（omitted 真实原因语义 + 描述优先级声明义务）。

### AUD-012 残留「来源目录」可观测能力（待审阅，2026-08-18）

- **背景**：AUD-012 审议顺序 ② 残留项——stats/diagnose 暴露作品可用上下文来源清单，已入计划 §8 Step 6 与契约 Open TODO。
- **实现**：`writing_explore` 的 `stats` 操作新增 `contextSources` 字段，包含 `byLayer`（L1/L2/L3 文档计数）和 `byKind`（按文档种类计数）。复用 AUD-013 的 `CONTEXT_SOURCE_REGISTRY` 与 `DOCUMENT_KIND_ALIASES` 归一逻辑，确保分层与上下文装配一致。纯模块 `contextSourceCounts` 方法在 `store.ts`，无新写入路径、无新错误码、无 `ContextPacket` 形状变化。
- **验证**：tsc 0 错、123/123 测试（新增 `source-directory-observable.test.ts`）、30/30 基准。闸门待跑。
- **契约**：M0_CONTRACT 新增 M4 source directory observable amendment。

### AUD-012 审阅修复二（2026-08-18 审计 C4/C5/C6，待审阅）

- **背景**：AUD-012 实现审阅（含 `526ee36` 接线与 `b83ee6b` 来源目录）发现 7 项问题，用户决策全部处理；其中 C1-C3 为仓库卫生与文档陈旧，C4-C6 为代码/语义，C7 记录进已知限制。
- **修复**：
  - C1：`b83ee6b` 误提交 `.commit-msg-tmp.txt`（17 行临时提交信息文件）→ 删除。
  - C4：`contextSourceCounts` 的 `GROUP BY kind` 补 `ORDER BY kind`——byKind JSON 键序显式确定（原依赖 SQLite 分组输出序，实践确定但未形式化）。
  - C5：byFill 调整——pinned 提升从 anchorKey 之后移到之前（**显式指定 > 锚定近距**）：`layerRank → pinned → anchorKey → score → priority → ref`；工具描述、契约 wiring amendment 同步（review clarification 2026-08-18）。
  - C6：pinned 边界文档化（不进 evidenceHash 去重 / 池内 pinned ref 保持搜索命中排名）——store.ts 注释 + 工具描述 + 契约 + 已知限制。
  - C2/C3：契约 Open TODO 更新（来源目录 stats 已实现、diagnose 摘要可选未实现）；计划 §8 Step 6 措辞 stats/diagnose → stats（diagnose 可选）。
- **验证**：tsc 0 错、lint 0 警告；node 验证脚本 6/6（C5 pinned 优先锚定生效、无 pin 锚定顺序不变、C4 byKind 有序、stats 确定、db 句柄存活）；新增 C5 回归测试（`context-constraint-wiring.test.ts`，vitest 待用户环境）；benchmark 未重跑（行为仅排序键序变化，30/30 风险极低，建议用户环境一并跑）。

### A1 SourceSnapshot/fingerprint 一致性（已完成，历史归档）

- **背景**：M4 最后两个待办——status 的 mtime/size 快速路径（不牺牲语义 snapshot）与来源目录的 diagnose 摘要（AUD-012 残留可选部分）。
- **实现**：
  - 快速路径落在 **service 层**（`service.ts#indexUnlocked`）：status 且 store 已存在且源指纹（AUD-021 同一 name+mtime+size 指纹）未变 → 复用既有 store，不重读来源；`index()` 在 status 后也回写指纹（连续 status 才能命中）。指纹即适配器解析输入，未变则 ParsedWork 必然相同，语义判定不变。
  - **失败尝试记录**：初版把快速路径放在 store 层（mtime/size 与 documents 表比对即返回 fresh），破坏既有契约——index-lifecycle 两条测试证明语义字段（title/kind/排序）变化而 mtime/size 不变时 status 必须报 stale；且 service 层首版指纹复用也触发同样失败。最终形态：store 层语义快照比对永远是 stale/fresh 唯一权威，快速路径只免除重读文件。
  - diagnose 摘要：`writing_index(status)` 新增可选 `contextSources`（byLayer/byKind，复用 `contextSourceCounts`）；`writing_diagnose(inspect)` 的 `index` 摘要携带同形状字段；`IndexResult` 类型与两个 zod data schema 同步扩展。
- **验证**：tsc 0 错、127/127 测试（新增 `status-fast-path.test.ts` 3 条：零重载+语义一致、编辑击穿报 stale、status 携 contextSources；`mcp-stdio.test.ts` 补 inspect 摘要断言）、30/30 基准、lint 0 警告。
- **契约**：新增 M4 status fast path and diagnose summary amendment；wiring amendment 的 Open TODO 收尾（来源目录 stats+diagnose 均完成）。tests/README 补录 `source-directory-observable.test.ts`（上次遗漏）与 `status-fast-path.test.ts`。

### AUD-035 工程硬化第三阶段：Biome 格式化（用户决策延后，2026-08-17）

- **原计划**：门禁 → 抽离 → 格式化三步中的最后一步，Biome 全量格式化（quoteStyle single / semicolons asNeeded / lineWidth 120）。
- **决策**：用户评估后决定延后，不执行。理由：门禁与适配器抽离已是 AUD-035 的实际价值；store.ts 巨型函数展开是纯手工、高风险、零功能收益的工作，且 store.ts 马上要被 M3/M4 修改，现在展开必然返工。正确时机是 M3/M4 语义冻结后的重构窗口，届时再判断格式化是否必要。
- **执行记录**：@biomejs/biome 2.5.8 曾安装用于评估，随后已卸载回退（package.json 与 pnpm-lock.yaml 无残留差异）；未产生任何格式化改动。
- **评估数据（供重构窗口参考）**：src/tests 共 333 行超 160 字符，其中约 200 行集中在 tests/（机械折行即可）；src 巨型函数集中在 store.ts（validateBuiltIndex 1418 字符、rowsForDocuments 876 字符等，多为长 SQL 字符串）、epub.ts 两处遍历循环、server.ts 工具注册块。

## 可追溯提交清单

> 本清单是计划 §13.3 检查点的唯一宿主（原计划内副本已移除）。按时间倒序（各阶段提交哈希在下一阶段入清单）：

- `0b2d5bd` — feat(context): Task 3 将必填 `accountingScope: evidence_excerpts_only` 写入所有 ContextPacket 路径（含 budget_unsatisfiable）、core/MCP output schema 与 writing_context 描述；明确 usedTokens 仅计 returned evidence excerpts 的 mixed-cjk-v1 估算、供外部 tokenizer 复核而非精确 token 声称；146/146 + 30/30 + lint 0 + coverage lines 93.01%。
- `661dd28` — feat(graph): Task 3 将 schema-v4 已有 `mentions` 纳入冻结 EdgeKind/EDGE_KINDS；`[[alias]]` 经持久化别名解析为 Document→Entity，双端 BFS 返回相同边的 incoming/outgoing 证据；稳定 documentRef/entityRef 可作为 neighborhood 种子；146/146 门禁验证见后续上下文契约提交。
- `42849f4` — feat(eval): §266 形式达标——`WRITING_MCP_ABLATE` 运行时开关（store.ts，默认行为不变）+ ablation-test.mjs 重写（gold-span 口径，bm25 项/FTS 合并分离）+ gate-gold-evidence.mjs 门禁 4/4 PASS + `reports/gold-evidence-baseline.json` 快照提交（.gitignore 白名单）。ablation 实证：coverage/alias KEEP，proximity/heading/trust REMOVABLE，bm25 项与 FTS 合并为负因子（删后 MRR↑）——公式层非杠杆，与归因结论互证；127/127 + 30/30 绿。
- `ab4af79` — fix(eval): P1 卷感知 holdout 切分（chaptersOf 带 volume、territories 从语料章题现算、容忍卷内章序异常与双 span heading）+ P3 miss 探针 rankAt100 + attribute-misses.mjs 三层归因工具（L1 词条可达/L2 候选可达/L3 因子分解）；切分恢复 18/24，归因结论：miss 全部纯排序因子问题（coverage 缺口）。
- `214bb8f` — refactor(eval): 评测仪表按用户拍板的 gold-span 口径重写（scripts/gold-hit.mjs 命中口径唯一宿主 + evaluate-reranking.mjs 真截断 recall@k/自检/异常分桶 + run-private-acceptance.mjs 改用共享模块行为等价；train recall@50=100% 够用门禁过、holdout @50=100%、acceptance 结果与历史金标准一致；127/127 + 30/30 绿）。
- `69a2b52` — revert(m4): 完整重排验证作废——回退 6 因子排序基线（用户审查 R1-R5 证实 f3ddd1f 验证无效：评测仪表缺陷 recall@k 忽略 k/词共现弱代理/章节 TODO、holdout 未验证、黄金证据门禁与 baseline.json 未落地；store.ts 公式恢复 6 因子、两个排序测试还原、状态与契约降级为作废；127/127 测试 + 30/30 基准全绿；评测脚本保留待重写）。
- `301dc44` — fix(f1+f2+f3): 消除指纹双算竞态、降级契约断言、补全文档摘要（待审阅；F1 指纹计算移入 indexUnlocked 消除双算竞态窗口，F2 M0_CONTRACT 措辞降级为 best-effort 并补充已知边缘案例，F3 M4 行摘要补录 status 快速路径 + diagnose 摘要；回归测试更新反映 M4 完整重排行为变化：trustBonus/headingMatches 已移除；127/127 测试通过，30/30 基准通过）。
- `f3ddd1f` — feat(m4): 完整重排落地——因子 ablation 优化排序公式（**【验证作废·已回退，见 2026-08-19 回退提交】** 评测集《语料A》42 facts，基线 Recall@5=83.33%/MRR=0.4247；ablation 测试 6 因子，决策保留 3 因子 coverage×4/aliasBoost/proximity，移除 3 因子 headingMatches/bm25/trustBonus；优化后 MRR=0.4493（+5.79%），Recall 不变；30/30 基准无冲突；新增 evaluate-reranking.mjs + ablation-test.mjs；契约补 M4 complete re-ranking amendment；.gitignore 保护私有数据。作废原因：评测仪表缺陷 + holdout 未验证 + 门禁未落地）。
- `c81be41` — docs: AUD-014 tokenizer 决策延后（保持 mixed-cjk-v1 启发式，理由见 IDEAS 文件 AUD-014 Tokenizer 决策记录）。
- `c559f07` — docs: AUD-012 审阅修复二归档（契约 review clarification + Open TODO 更新 + 已知限制补充 + 提交清单补 1b4cd78/ca8d29a）。
- `ca8d29a` — fix(m4): AUD-012 审阅修复二（C4 contextSourceCounts ORDER BY kind 显式确定 / C5 byFill pinned 提升优先于锚定近距 / C6 pinned 边界文档化；新增 C5 回归测试；tsc 0 + lint 0 + node 验证脚本 6/6；vitest 与 benchmark 待用户环境）。
- `1b4cd78` — chore: 删除 b83ee6b 误提交的 `.commit-msg-tmp.txt` 临时文件。
- `b83ee6b` — feat(m4): AUD-012 残留「来源目录」可观测能力完成（writing_explore stats 操作新增 contextSources 字段：byLayer L1/L2/L3 + byKind 按文档种类计数；复用 AUD-013 注册表与归一逻辑；新增 source-directory-observable.test.ts；123/123 + 30/30 + lint 0；契约补 M4 source directory observable amendment）。
- `798592e` — fix(m4): AUD-012 接线审阅三缺陷修复（待审阅；描述优先级矛盾/budget_unsatisfiable 真实 omitted 原因/tests-README 漂移；另修接线测试偶发——ch3 夹具标题补查询词打破同分；契约补两条；122/122 + 30/30 + lint 0 + coverage 92.91%）。
- `e506a08` — docs(status): AUD-012 接线完成归档 + AUD-013 审阅通过 + 验证记录。
- `526ee36` — feat(m4): AUD-012 约束接口接线完成（excludeRefs/entityRefs/documentRefs/targetChapter 接线、taskType 值域开放且非驱动；移除被否决的 taskType 策略引擎；修复 WIP 的 db.close 共享句柄 bug 与 excluded 伪造 block hack；新增 context-constraint-wiring.test.ts 6 项 + 更新 context-reserved-params.test.ts；tsc 0 错 / lint 0 警告 / benchmark 30/30 / store 级接线脚本 16/16；契约新增 M4 constraint-interface wiring amendment）。
- `eb28def` — docs(contract): AUD-012 方向修订——taskType 不再驱动确定性来源策略，MCP 完善 Agent 自主上下文组装的约束接口（对齐 Reference §5.5 否决的智能路由）。
- `d47b2da` — fix(m4): AUD-013 文档类型大小写归一（DOCUMENT_KIND_ALIASES：character→Character 等；修复 searchRows 小写 d.kind 全落 L3 缺陷，补真实路径 L1/L2 断言）。
- `2ddb40c` — feat(m4): AUD-013 来源提供器注册表 + evidenceHash 去重（待审阅；分层改来源类型映射、required 晋升 L0、duplicate_evidence 折叠、预算填充 L0→L3；新增 context-assembly.ts 纯模块与 6 项回归；114/114 + 30/30 + lint 0 + coverage 92.88%；同提交含状态文档已审阅叙事精简）。
- `f9fa97d` — docs(m4): 采纳 REVIEW_2026-08-17 方向（M4 行按审议顺序重排：AUD-013 来源语义化+去重 → AUD-012 残留接线 → AUD-014 tokenizer；含 M4 审议下一步记录）。
- `04152cd` — chore: 移除已迁至工作区级 .agents/ 的两个 SKILL.md（仓库内不再保留技能副本）。
- `4b3d647` — docs(review): M4 能力与边界第四次审阅（REVIEW_2026-08-17，本地化文档）。
- `075c414` — feat(scripts): 语料加载与性能基准测试脚本（load-corpus.mjs + run-corpus-benchmark.mjs；491 万字语料首测：索引 25.7s、Explore P95 673ms、Context P95 382.5ms、Token 降幅 99.92%）。
- `c176e9e` — docs: 批次 C 审阅归档（AUD-028～032 + AUD-035-1/2 共六条已审阅通过）。
- `031005d` — chore: 收窄 .gitignore（reports/ 全忽略、docs/REVIEW*.md 与 docs/PRIVATE*.md 本地化；三个原跟踪文档移出索引）。
- `4f1e038` — docs(m1): AUD-035 第三阶段 Biome 格式化延后至 M3/M4 重构窗口。
- `8764652` — refactor(m1): AUD-035 第二阶段 generic 适配器策略模块抽离（index.ts 拆为 errors/numbering/txt/epub 四模块 + 编排入口，公共 API 经再导出兼容；覆盖率逐位不变证明纯结构重构；108/108 + 30/30 + lint 0 警告）。
- `3041650` — chore(m1): AUD-035 第一阶段 lint/coverage 门禁（oxlint 修到 0 警告 + @vitest/coverage-v8 棘轮阈值，vitest 别名改指 src 修复覆盖率失真；108/108 + 30/30）。
- `3a53209` — feat(m1): AUD-032 进程生命周期与优雅关闭（`createStdioRuntime` + 统一 terminate 链 + 5 秒 grace guard，SIGINT/SIGTERM/stdin EOF 确定性退出，stdout 纯 JSON-RPC；5 项回归；108/108 + 30/30）。
- `2f4916d` — feat(m1): AUD-030 span 硬上限、locator 精确与连续平铺边界规则（超长单行硬切为共享同一源行的有界 chunk、locator 排除被裁空行、无重叠无遗漏；重叠方案实测拒绝；5 项回归；103/103 + 30/30）。
- `b4b2cb9` — feat(m1): AUD-029 snapshot 一致性与文本内存上限（loadConsistent 读前后指纹校验 + 有界重试，`SOURCE_CHANGED_DURING_READ`；文本单文件/总量上限；5 项回归；98/98 + 30/30）。
- `0b83baf` — feat(m1): AUD-028 EPUB 资源上限（entry 数/单文档/总解码量三级确定性上限，防 ZIP bomb；含上轮半成品 L102 语法错误修复；4 项回归；93/93 + 30/30）。
- `9ca427b` — feat(m1): AUD-027 章节编号语法明确化（阿拉伯/中文至九百九十九/规范罗马三语法冻结、非法编号确定性跳过、卷重置一致；5 项回归；89/89 + 30/30）。
- `4675458` — feat(m1): AUD-026 通用作品边界与 capabilities 实际化（逐 EPUB 独立候选、多书目录 ambiguous、无 epub 能力不加载 EPUB；4 项回归；84/84 + 30/30）。
- `81d49f8` — docs(status): 补齐 AUD-005～025 检查点的可追溯提交清单。
- `35fcd3f` — feat(m0.1): AUD-025 协议层错误边界（输出 data schema 单一真相源 + wrapper 自校验 `OUTPUT_SCHEMA_MISMATCH` + 可注入 onerror→stderr；M0_CONTRACT protocol error boundary amendment；5 项回归；80/80 + 30/30）。
- `1b493ad` — feat(m0.1): AUD-024 general JSONL 串行轮转与追加（并发不丢不乱、写失败降级；3 项回归；75/75 + 30/30）。
- `d505e08` — feat(m0.1): AUD-023 开发捕获有界 outputHits（ref/score/locator 哈希，各列上限 100；1 项回归；72/72 + 30/30）。
- `5dbc5f8` — feat(m3): AUD-012 残留 search source-trust 排序因子（deterministic 命中 +0.25；1 项翻转回归；71/71 + 30/30）。
- `a935c70` — docs(contract): 将 AUD-012 残留（taskType/目标/排除引用）钉为 M4 显式 Open TODO。
- `aee9724` — feat(m3): AUD-012 M3 范围（timeline 章节时态过滤 + context reserved 输入）。
- `b8a1bf7` — feat(m3): AUD-022 确定性图/能力词汇表冻结（ENTITY_KINDS/EDGE_KINDS/WORK_CAPABILITIES）。
- `3bbc847` — feat(m3): AUD-015 timeline 独立确定性投影（时态实体 + precedes 边）。
- `05d771a` — perf(m3): AUD-020 BFS 逐层批量边查询与 locator 批量加载。
- `aacb611` — fix(m4): AUD-005 requiredRefs 脱离 search 候选池直接解析。
- `2e07df2` — fix(m3): AUD-021 源指纹修复（`service.index()` 记录指纹；修复 `ensureFresh` 在 `previous === undefined` 时跳过增量更新的缺陷；55/55 测试通过）。
- `3aee442` — fix(m3): AUD-018 响应字节上限（200KB 确定性截断 + `RESPONSE_TRUNCATED`）。
- `c376df7` — fix(m3): AUD-021 源指纹复用 + AUD-018 时间上限（初版，含 `tests/service-reuse.test.ts`）。
- `4030085` — fix(m3): 检索正确性（中文问句分析、歧义/未解析输出、稳定排序、输入边界、FTS 降级诊断）。
- `6058075` — fix(m2): schema v4（图身份/顺序、规范定义晋升、多 mention/关系证据、跨 spine locator）。
- `ccc36bc` — fix(m2): schema v3（语义快照、真实 freshness、作品级串行、跨进程锁、崩溃恢复、`.gitignore` 保留）。
- `2719dff` — fix(inkos): 角色别名去重与绑定书籍解析。
- `5b93711` — fix(m1): EPUB 章节切分修复与验证。
- `696de42` — docs(review): AUD-001~036 证据分级、门禁校准与修复顺序。

后续每次达到提交点（bug 修复 / 子门禁完成 / 计划调整）时，在本清单顶部追加一条，保持单一宿主。
