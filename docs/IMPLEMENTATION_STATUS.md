# Writing MCP MVP 实施状态

> **本文档是 Writing MCP 实施状态的唯一事实源。** v2 计划、README、REVIEW 文档均只引用本文件，不维护状态副本；任何"当前做到哪、多少测试、哪些 AUD 已关闭"的判断以本文为准。发现其他文件记载状态时，以本文为准并修正该文件。
>
> 检查点时间：2026-08-16（审计修订）
> 当前状态：M0 主体完成；索引事实性 Step 1 与图身份/证据 Step 2 已闭环，M0.1、M1 其余补强及 M3 继续进行；整体仍是可演示 MVP，尚未达到 `Writing_MCP_Server_v2.md` 的 v1 完整验收标准。

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

最近验证：2026-08-16（审计修订），构建与 65 项测试通过；30/30 公共基准、10/10 固定事实召回和 100% locator 字段存在率通过；fixture excerpt 估算 Token 降幅 61.24%。本地转换型 EPUB 以 schema v4 重建为 57 documents、56 Chapter entities、55 `precedes` edges，首次索引约 0.31 秒；自然语言查询对不存在的“语笙”返回 `NO_RESULTS`，对真实存在的“秦晴”“岳枫”前 5 条均含目标姓名。本地私有标注指标仍仅作历史参考。

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
| M3 | 进行中 | search/entity/neighborhood/document/stats、中文问句分析、别名/歧义/未解析输出、稳定排序、输入上限（query 2048 字符）、explore 执行时间上限（30s）、源指纹复用 store（未变化不重载）、0～3 跳 BFS 与逐边证据、BFS 逐层批量边查询与 locator 批量加载（AUD-020 主体）、timeline 独立确定性投影（AUD-015 主体）、图/能力词汇表冻结（AUD-022 主体）、timeline 章节时态过滤与 context reserved 参数标注、search source-trust 排序因子（AUD-012 M3 范围） | 真实语料百万字/高 fan-out P95 门禁（待代表性语料）、完整重排 |
| M4 | 进行中（已有纵向切片） | ContextPacket、预算上限、抽取式选择、requiredRefs 脱离 top-50 直接解析（AUD-005） | L0～L3 正式策略、tokenizer profile；AUD-012 残留 TODO（M4 必须适配）：taskType 确定性来源策略、targetChapter 章节锚定装配、entityRefs/documentRefs 直解入 blocks、excludeRefs 排除候选（详见 M0_CONTRACT Open TODO）；AUD-013～014 |
| M5 | 待开始（已有纵向切片） | stdio、五工具注册、structuredContent、outputSchema、统一结果/错误/诊断信封、协议测试、单个真实转换型 EPUB 回归 | 真实 InkOS、更多 EPUB 2/3 变体、客户端安装与故障文档 |

Step 1 已关闭 AUD-003、006、011、031；Step 2 已关闭 AUD-001、002、007～010 的当前门禁；Step 3 已完成中文问句、别名/歧义、稳定排序、输入上限、FTS 降级与检索诊断（提交 `4030085`），并完成 AUD-018 时间上限（提交 `c376df7`）；AUD-021 源指纹复用修复（`service.index()` 增加指纹记录，修复 `ensureFresh` 在 `previous === undefined` 时跳过增量更新的逻辑缺陷，55/55 测试全部通过）。AUD-005（REVIEW_2026-08-16 P0，提前于 Step 3 剩余项处理）：`requiredRefs` 脱离 search top-50 候选池按 entity/span/document 三级直接解析，池外必选 ref 进 blocks 并计入预算最小值，不存在 ref 以 `not_found` 进 omitted，预算不足触发 `budget_unsatisfiable`；`ContextPacket` 形状与状态词汇未变（M0_CONTRACT 新增 M4 requiredRefs amendment）。M0.1、M1 其余问题和 M3～M5 尚未完成，现有成果不能据此宣称 Writing MCP v1 已完成。

## 当前测试覆盖

> 详细清单（测试文件 → 主题映射、按能力域的覆盖条目）见 [`tests/README.md`](../tests/README.md)。本段只保留概述，细节以测试清单为准。

- 25 个测试文件，覆盖：通用链路、MCP 协议与诊断（含 AUD-025 协议错误边界）、检索正确性（含 AUD-021 源复用）、上下文装配（AUD-005 requiredRefs 直接解析）、BFS 批量化护栏（AUD-020）、timeline 独立投影（AUD-015）、图/能力词汇表冻结（AUD-022）、章节时态过滤与 reserved 参数（AUD-012）、基准与基线、私有语料（不入库）、TXT/EPUB/InkOS 适配器（含 AUD-026 作品边界）、路径安全、作品识别、索引生命周期与事实性（schema v4）、边界与原则。
- 关键门禁：30/30 公共基准；无分词中文问句命中；重复 Chapter 身份独立；源变化 status 转 stale；未变化源零重载；删除索引可完整重建。

## 已知限制

- `timeline` 已实现为携带时态属性实体与 precedes 时序边的确定性投影，支持 targetChapter 章节时态过滤（AUD-012 M3 范围）；taskType 与 context 的 targetChapter/entityRefs/documentRefs/excludeRefs 仍为 reserved 输入，装配策略待 M4。
- `taskType` 尚未改变上下文来源策略（已在工具描述中显式标注 reserved）。
- 角色实体提取只覆盖角色类文档 heading；查询期仅提供透明的中文称呼形态扩展，尚无持久化别名解析。
- EPUB 仍采用确定性轻量解析，尚未覆盖 DRM/加密、复杂命名空间、导航目录语义、脚注回链、图片内容和全部 EPUB 2/3 变体；内部章节切分目前依赖独占行的中英文编号标题。
- `workRef` 只在当前 server 进程中注册；重启后客户端需重新调用 `writing_resolve`。
- schema v4 writer lock 是 Writing MCP 进程间的合作式协议，不能强制无关程序释放 SQLite 句柄；此类占用稳定返回 `INDEX_BUSY`。
- status 当前为保证正确性会重新读取适配器全部来源；mtime/size 快速路径仍待在不牺牲语义 snapshot 的前提下实现。
- 私有长篇仍有 1 条 optional 事实未进入前 20，900 字抽取摘要的逐字证据暴露率为 88.10%；这些指标与 span 召回、来源覆盖分别报告。
- 中文问句分析当前是有界规则与 n-gram，不是通用分词器；问题短语表会继续通过真实调用链回归校准。

## 下一步

- 批次 C（AUD-026～032 + AUD-035 第一/二阶段）已全部完成，待审阅条目共六条（见上方「待审阅修复方案」章节）。
- AUD-035 第三阶段（Biome 格式化）已由用户决策延后：store.ts 即将被 M3/M4 修改，现在做巨型函数展开与全量格式化必然返工；正确时机是 M3/M4 语义冻结后的重构窗口，届时再评估格式化是否必要。
- M3/M4 语义冻结后的重构窗口 TODO：（1）store.ts 图构建/检索 SQL 抽离；（2）移除 oxlintrc.json 对 store.ts 的 ignorePatterns 忽略项；（3）评估 Biome 格式化（若执行：quoteStyle single / semicolons asNeeded / lineWidth 120）。
继续 v2 Step 3 剩余子门禁：中文完整问句、别名/歧义/未解析引用、稳定排序、输入边界、FTS 降级语义已落地（`4030085`）；AUD-021 源指纹复用 store 与 AUD-018 执行时间上限已落地（`c376df7`）。REVIEW_2026-08-16 的唯一 P0 AUD-005（requiredRefs 直接解析）已落地并新增 5 项回归测试；P1 首项 AUD-020 主体已落地：BFS 逐层批量边查询（CTE frontier + ROW_NUMBER 每节点 fan-out 封顶）与 locator/span 批量加载，语义（fan-out 64、全局 512、逐边证据、确定性排序）不变，新增 2 项宽图护栏测试；真实语料百万字 P95 门禁待代表性语料可得后补。AUD-015 主体已落地：timeline 为携带时态属性实体与 precedes 边的确定性投影（章节位置排序，新增 TIMELINE_PROJECTION 诊断），章节时态过滤待目标章节输入。AUD-022 主体已落地：确定性可抽取词汇表冻结为 ENTITY_KINDS/EDGE_KINDS/WORK_CAPABILITIES（EntityKind 补入 OutlineNode，新增 EdgeKind/WorkCapability 类型，capabilities 类型收窄），未实现关系不作为已有能力（M0_CONTRACT 新增 M3 graph vocabulary freeze amendment）。AUD-012 M3 范围已落地（按用户里程碑优先路线，M4 深水区延后）：writing_explore 新增可选 targetChapter，timeline 投影按 from ≤ 锚点 ≤ to 做章节时态过滤（无界 from/to 视为书首/书尾）；writing_context 新增 reserved 输入 targetChapter/entityRefs/documentRefs/excludeRefs 且描述显式标注 taskType 等参数 reserved（接收验证、不改变装配，M0_CONTRACT 新增对应 amendment）。AUD-012 残留的 source_kind 排序因子已落地（按用户决策，M3 期内唯一排序变更）：search 中命中查询词的 deterministic 行获固定 +0.25 信任加分，不被原始分更高的 alias-only heuristic 行压过（M0_CONTRACT 新增 source-trust amendment，新增 1 项翻转回归测试）。AUD-023 主体已落地：开发捕获事件新增有界 outputHits（命中 ref/kind/sourceKind/score + locator 哈希、omitted 原因、候选 workRef，各列上限 100），正文/标题/路径不入捕获；通用 JSONL 与逐调用报告保持只存数量（M0_CONTRACT 新增 capture bounded-refs amendment，新增 1 项回归测试）。AUD-024 主体已落地：general diagnostics.jsonl 的轮转检查与追加入同一按目录串行队列，并发记录不再交错轮转重写与追加；容量上限（1000 事件/5 MiB）生产不变、测试可注入，写失败降级为 persistence=failed（M0_CONTRACT 新增 general JSONL serialization amendment，新增 3 项回归测试）。AUD-025 主体已落地：批次 B 关闭——五个工具的输出 data schema 导出为单一真相源（注册信封与 wrapper 自校验共用）；wrapper 记录成功前自校验，失配抛出新错误码 `OUTPUT_SCHEMA_MISMATCH`（记 failure + isError 一致信封 + 专用 recovery）；`createServer` 支持注入 `onerror`（接在底层 Server 上），stdio 入口把协议层错误写入 stderr（`[writing-mcp][protocol]` 前缀）；SDK 输入拒绝属协议层、在 mcp_calls_only 观察边界外（裸 isError 文本、无诊断记录）；M0_CONTRACT 新增 protocol error boundary amendment，新增 `tests/protocol-boundary.test.ts` 5 项回归。AUD-026 主体已落地：generic 作品边界确定化——目录内每个 EPUB 独立成候选（与直接解析该文件同 workRef/rootPath），其余文本合成一个目录作品，多书目录返回 ambiguous 而非静默合并；capabilities 由实际输入决定（纯文本作品不再声明 epub），无 epub 能力的目录作品不加载 EPUB 文件（M0_CONTRACT 新增 generic work boundary amendment，新增 4 项回归并更新 epub 多书测试）。AUD-027 主体已落地：章节编号语法明确化——阿拉伯数字/中文数字（一至九百九十九，含百位合成，修复罗马数字被 Number("iv") 丢弃、百以上中文数字不支持）、规范罗马数字（i…mmmcmxcix）三种章号确定性支持；非法编号确定性跳过并入上一章，卷重置推断对三种编号一致生效，Markdown 中文数字章名识别为 chapter（M0_CONTRACT 新增 chapter-number syntax amendment，新增 5 项回归）。AUD-028 主体已落地：EPUB 资源上限——entry 数/单文档（含 OPF）/总解码量三级确定性上限（默认 4096 entries / 16 MiB / 64 MiB），越限抛稳定错误码 `EPUB_TOO_MANY_ENTRIES`/`EPUB_DOCUMENT_TOO_LARGE`/`EPUB_TOTAL_TOO_LARGE` 而非挂起或无限膨胀；上限可经 `new GenericAdapter({ epub })` 注入，`DEFAULT_EPUB_LIMITS` 导出（M0_CONTRACT 新增 EPUB resource limits amendment，新增 4 项回归含 EPUB 2.0 默认上限加载）。AUD-029 主体已落地：snapshot 一致性——每次适配器读取前后校验源指纹，不一致有界重试一次后仍不一致拒绝 `SOURCE_CHANGED_DURING_READ`，snapshot 不再可能混合不同时刻的源状态；文本链路新增单文件/作品总量确定性上限 `SOURCE_FILE_TOO_LARGE`/`SOURCE_TOTAL_TOO_LARGE`（默认 16 MiB / 64 MiB，可经 `new GenericAdapter({ text })` 注入，`DEFAULT_TEXT_LIMITS` 导出）（M0_CONTRACT 新增 snapshot consistency amendment，新增 5 项回归）。AUD-030 主体已落地：span 硬上限与边界规则——超长单行硬切为共享同一源行的有界 chunk（span 内容永不超 `maxChars`），locator 精确排除被裁空行，相邻 span 连续平铺无重叠无遗漏；重叠方案已评估并拒绝（重复行使确定性 mention/边证据重复计数，实测 graph 测试翻转佐证）（M0_CONTRACT 新增 span hard cap amendment，新增 5 项回归）。AUD-032 主体已落地：进程生命周期与优雅关闭——新增 `createStdioRuntime`（`{ server, shutdown }`，shutdown 先关 MCP server 再关 service、幂等、只写 stderr），SIGINT/SIGTERM/stdin EOF 统一走同一关闭链并确定性 exit 0，5 秒 grace guard 兜底强制终止（同步 SQLite 长操作不可取消但进程必然退出），stdout 专属 JSON-RPC（M0_CONTRACT 新增 process lifecycle amendment，新增 5 项回归）。AUD-035 第一阶段已落地（用户确认顺序：门禁 → 抽离 → 格式化）：oxlint lint 门禁修到 0 警告 + @vitest/coverage-v8 棘轮门禁（行覆盖 92.78%，阈值 90；vitest 别名改指 src 修复此前经 dist 的覆盖率失真）；`store.ts` 暂被 oxlint minified-file 启发式忽略，拆分后移除。AUD-035 第二阶段已落地：generic 适配器 21.8 KB 单文件拆为 errors/numbering/txt/epub 四个策略模块 + 发现/装载编排（逻辑逐字搬迁，覆盖率逐位不变证明纯结构重构）；store.ts 图构建抽离按用户决策延后。AUD-035 第三阶段（Biome 格式化）经用户评估后决策延后至 M3/M4 语义冻结后的重构窗口再评估（store.ts 即将被 M3/M4 修改，现在展开必然返工）；批次 C 至此全部完成。完整重排按用户决策搁置到 M4 + 代表性语料之后，候选统计校准待语料。M4 剩余：taskType/目标与排除引用（AUD-012）、L0～L3 语义分层与去重（AUD-013）、tokenizer profile（AUD-014）。status 的 mtime/size 快速路径（不牺牲语义 snapshot）仍待实现。

## 已审阅修复记录（原 Pending Review 节归档）

> 本节原为「待审阅修复方案」，逐条记录已执行修复的方案内容。**2026-08-16 审阅通过后归档**：方案细节见对应提交的 commit message 与 `tests/README.md`，此处只保留审阅结论，不再复制完整方案。

| AUD | 审阅结论 | 提交 | 测试 | 接口影响 |
|---|---|---|---|---|
| **AUD-025** 协议层错误边界 | ✅ 合格：输出 data schema 单一真相源、wrapper 记录前自校验（`OUTPUT_SCHEMA_MISMATCH`）、`createServer` 可注入 `onerror`→stderr、SDK 输入拒绝属协议层观察边界外 | `35fcd3f` | `protocol-boundary.test.ts` 5 项 | 加法式（新错误码 + 可选构造参数） |
| **AUD-026** 通用作品边界与 capabilities 实际化 | ✅ 合格：逐 EPUB 独立候选、多书目录 ambiguous、capabilities 由实际输入决定 | `4675458` | `generic-work-boundary.test.ts` | 仅 generic 发现语义变更（行为变更已记录） |
| **AUD-027** 章节编号语法明确化 | ✅ 合格：阿拉伯/中文（至九百九十九）/规范罗马三语法冻结、非法编号确定性跳过、卷重置一致生效 | `9ca427b` | `txt-numbering.test.ts` 5 项 | 仅解析覆盖面扩大 |

**审阅附注（2026-08-16）**：三条均在已提交的 HEAD 上通过 `tsc -b` 与 30/30 基准验证。

> 2026-08-16 审阅时发现的工作区待办（AUD-028 半成品与 L102 语法错误）已在 AUD-028 提交中修复并全量验证。

## 待审阅修复方案（Pending Review）

> 按用户授权（2026-08-16）自主执行的修复，逐条记录方案内容并标注待审阅；审阅通过后归档入上节。

### AUD-028 EPUB 资源上限（待审阅，2026-08-17）

- **依据**：REVIEW_2026-08-15_CONSOLIDATED AUD-028——EPUB 链路未限制 ZIP 展开大小、entry 数与单文档大小，存在 ZIP bomb 与无限膨胀风险。
- **方案**：在 `adapter-generic` 新增可注入 `EpubLimits`（`maxEntries`/`maxDocumentBytes`/`maxTotalBytes`，默认 4096 / 16 MiB / 64 MiB，`DEFAULT_EPUB_LIMITS` 导出）；`epubDocuments` 在 ZIP 加载后立即检查 entry 数，逐 spine 文档解码后检查单文档大小与累计总量，`epubPackage` 对 OPF 本体同样受 per-document 上限保护；越限一律抛稳定错误码 `EPUB_TOO_MANY_ENTRIES`/`EPUB_DOCUMENT_TOO_LARGE`/`EPUB_TOTAL_TOO_LARGE`，不挂起、不静默截断。构造器 `new GenericAdapter({ epub?: Partial<EpubLimits> })` 供测试注入；同时修复上一轮半成品引入的 `.replace(/^\/+/ ")` 语法错误（改为 `.replace(/^\/+/g,"")`，行为不变）。
- **验证**：新增 `tests/epub-resource-limits.test.ts` 4 项（三个错误码 + EPUB 2.0 默认上限加载）；三闸门通过：`pnpm check` EXIT=0、vitest 93/93（26 文件）、基准 30/30。
- **接口影响**：加法式——三个新错误码、新导出 `EpubLimits`/`DEFAULT_EPUB_LIMITS`、可选构造参数；默认行为对合规 EPUB 不变。

### AUD-029 snapshot 一致性（待审阅，2026-08-17）

- **依据**：REVIEW_2026-08-15_CONSOLIDATED AUD-029——读取多文件期间源可能变化，snapshot 可混合不同时间状态；全文和 EPUB 整体驻留内存。完成条件：读取前后快照校验或重试；文件/作品内存上限和源变化错误。
- **方案**：`WritingService` 新增 `loadConsistent`：每次适配器 `load` 前后各算一次源指纹（复用 AUD-021 的 names+mtime+size 指纹），不一致则重试一次，仍不一致抛稳定错误码 `SOURCE_CHANGED_DURING_READ`；`indexUnlocked` 与 `store()` 统一改走该入口，snapshot 永不混合不同时刻状态。文本内存上限：`TextLimits`（单文件/作品累计，默认 16 MiB / 64 MiB，`DEFAULT_TEXT_LIMITS` 导出），越限抛 `SOURCE_FILE_TOO_LARGE`/`SOURCE_TOTAL_TOO_LARGE`；构造器扩展为 `new GenericAdapter({ epub?, text? })`。EPUB 体积仍由 AUD-028 上限管辖，不重复计入。
- **验证**：新增 `tests/snapshot-consistency.test.ts` 5 项（持续变化拒绝、一次性写入后有界重试成功、单文件超限、总量超限、默认上限正常加载）；三闸门通过：`pnpm check` EXIT=0、vitest 98/98（27 文件）、基准 30/30。
- **接口影响**：加法式——三个新错误码、新导出 `TextLimits`/`DEFAULT_TEXT_LIMITS`、构造参数扩展（与 AUD-028 同入口合并）；读取期源变化从静默混合状态变为显式错误（行为变更：客户端需重试）。

### AUD-030 splitDocument 硬切与边界规则（待审阅，2026-08-17）

- **依据**：REVIEW_2026-08-15_CONSOLIDATED AUD-030——`splitDocument` 对超长单行不硬切分，trim 后 locator 含被裁空行，跨 span 无重叠。完成条件：最大 span 硬上限、locator 精确规则、边界证据回归。
- **方案**：（1）硬上限：单行长度超 `maxChars` 时硬切为多个 chunk span，全部共享同一源行（startLine=endLine，locator 同步），先 flush 已累积内容；span 内容从此永不超 `maxChars`。（2）locator 精确：flush 时逐行收缩首尾空行，startLine/endLine 与 locator 仅覆盖内容实际包含的行。（3）边界证据：明确冻结为「连续平铺、无重叠、无遗漏」（下一 span 起始行 = 上一 span 结束行 + 1，内容可重组）。重叠方案实现后实测导致确定性 mention 重复计数（graph-identity 测试 3→5 翻转），且与「每个源位置计一次」的图语义冲突，故拒绝并在 M0_CONTRACT 记录理由。
- **验证**：新增 `tests/span-hard-split.test.ts` 5 项（超长行硬切、locator 不含空行、连续平铺重组、硬切后行号连续、heading 边界 locator）；三闸门通过：`pnpm check` EXIT=0、vitest 103/103（28 文件）、基准 30/30。
- **接口影响**：无接口变更；span 切分行为变化仅影响存在超长单行或首尾空行的文档（既有 fixture 与基准不受影响，全量回归通过）。

### AUD-032 进程生命周期与优雅关闭（待审阅，2026-08-17）

- **依据**：REVIEW_2026-08-15_CONSOLIDATED AUD-032——SIGINT/SIGTERM handler 只关闭 service，不关闭 MCP server/不显式退出；同步 SQLite 长操作不可取消。完成条件：进程生命周期、取消、优雅关闭和无 stdout 污染测试。
- **方案**：`server.ts` 新增导出 `createStdioRuntime(service, options?)` 返回 `{ server, shutdown }`：shutdown 先关 MCP server（transport）再关 service，幂等，关闭失败只写 stderr（`[writing-mcp][lifecycle]` 前缀），永不触碰 stdout。`runStdio` 将 SIGINT/SIGTERM 与 stdin EOF（transport 关闭触发 `onclose`）接到同一 terminate 链：`shutdown().finally(() => process.exit(0))`，另设 5 秒 grace guard 强制 exit 1——同步 SQLite 操作无法中途取消，但进程退出确定性有界；`process.once("exit")` 保留同步 best-effort 关闭。取消语义：MCP 层取消不变（由 SDK 管辖），生命周期层保证是确定性终止而非挂起。
- **验证**：新增 `tests/lifecycle.test.ts` 5 项（SIGTERM/SIGINT 时限内终止、stdin EOF exit 0、完整会话 stdout 纯 JSON-RPC 且干净退出、进程内 shutdown 链幂等且零 stdout 写入）；三闸门通过：`pnpm check` EXIT=0、vitest 108/108（29 文件）、基准 30/30。
- **接口影响**：加法式——新导出 `createStdioRuntime`/`StdioRuntime`；行为变更：信号/stdin EOF 从可能挂起变为确定性退出（POSIX exit 0；Windows 上信号由操作系统直接终止进程，测试对两种语义分别断言）。

### AUD-035 工程硬化第一阶段：lint/coverage 门禁（待审阅，2026-08-17）

- **依据**：REVIEW_2026-08-15_CONSOLIDATED AUD-035——无 lint/format/coverage 门禁，修改和审查容易漏差异。路线：先修正确性（已由 AUD-026～032 完成），再在行为测试保护下硬化工程。本阶段只做门禁，不动源码逻辑与格式（用户确认顺序：门禁 → 抽离 → 格式化）。
- **方案**：（1）`pnpm lint`：oxlint（-c oxlintrc.json --deny-warnings），修复全部 7 处代码警告（未用导入/变量、单元素 Promise.all、冗余 spread、字符类内多余转义）至 0 警告；`store.ts` 暂时列入 ignorePatterns——oxlint 内置 minified-file 启发式警告无法按规则关闭，模块拆分（下一阶段）后同步移除，TODO 见下。（2）`pnpm coverage`：@vitest/coverage-v8，vitest.config.ts 新增 workspace 别名指向 src（修复覆盖率失真：此前测试经包别名走 dist，行覆盖仅显 29.85%；指向 src 后真实行覆盖 92.78%）并设棘轮阈值 lines 90 / statements 87 / functions 85 / branches 73。（3）正则修复验证：`store.ts` 未解析引用正则改为 `[^\[\]\n]` 后以临时脚本确认匹配语义不变，108 项行为测试回归通过。
- **验证**：`pnpm lint` EXIT=0（0 警告）；`pnpm coverage` 阈值内通过（108/108，行 92.78%）；三闸门：`pnpm check` EXIT=0、vitest 108/108、基准 30/30。
- **TODO（不得遗忘）**：AUD-035-2 模块拆分后从 oxlintrc.json 移除 `packages/core/src/store.ts` 忽略项，使其回到 lint 覆盖。
- **接口影响**：无产品接口变更（无 M0_CONTRACT amendment；门禁为工程基建，记录于 tests/README 与本文档）；新增 devDependencies oxlint、@vitest/coverage-v8。

### AUD-035 工程硬化第二阶段：generic 适配器策略模块抽离（待审阅，2026-08-17）

- **依据**：REVIEW_2026-08-15_CONSOLIDATED AUD-035——适配器职责集中；路线第二步：在行为测试保护下抽离已批准策略模块。用户确认范围：只抽纯函数（EPUB 解析），图构建明确延后。
- **方案**：`packages/adapter-generic/src/index.ts`（21.8 KB 单文件）拆为五个职责模块：`errors.ts`（codedError 稳定错误辅助）、`numbering.ts`（AUD-027 章号解析：中文/罗马/阿拉伯三语法）、`txt.ts`（TXT 解码与章节切分 + TextLimits）、`epub.ts`（OPF/spine 解析、HTML 提文、封面过滤、跨 spine 章节切分 + EpubLimits）、`index.ts` 只留发现（AUD-026 作品边界）与装载编排；公共 API 不变（`GenericAdapter`/`EpubLimits`/`DEFAULT_EPUB_LIMITS`/`TextLimits`/`DEFAULT_TEXT_LIMITS` 经再导出兼容）。逻辑逐字搬迁，无任何行为修改。
- **验证**：覆盖率与抽离前逐位一致（行 92.78% / 语句 89.12% / 函数 87.5% / 分支 75.9%，证明纯结构重构）；四闸门：`pnpm check` EXIT=0、vitest 108/108、基准 30/30、`pnpm lint` 0 警告。
- **TODO（不得遗忘）**：`store.ts` 图构建/检索 SQL 抽离明确延后（与 SQLite 句柄缠绕，风险高）；oxlint 对 store.ts 的 ignorePatterns 忽略项保持，待 store.ts 拆分后移除（第一阶段 TODO 合并于此）。
- **接口影响**：无；新增模块内部导出（epubPackage/htmlText/splitEpubChunks/epubDocuments/bestEffortEpubTitle/decodeText/txtDocuments/chapterNumber 等）供后续细粒度测试使用。

### AUD-035 工程硬化第三阶段：Biome 格式化（用户决策延后，2026-08-17）

- **原计划**：门禁 → 抽离 → 格式化三步中的最后一步，Biome 全量格式化（quoteStyle single / semicolons asNeeded / lineWidth 120）。
- **决策**：用户评估后决定延后，不执行。理由：门禁与适配器抽离已是 AUD-035 的实际价值；store.ts 巨型函数展开是纯手工、高风险、零功能收益的工作，且 store.ts 马上要被 M3/M4 修改，现在展开必然返工。正确时机是 M3/M4 语义冻结后的重构窗口，届时再判断格式化是否必要。
- **执行记录**：@biomejs/biome 2.5.8 曾安装用于评估，随后已卸载回退（package.json 与 pnpm-lock.yaml 无残留差异）；未产生任何格式化改动。
- **评估数据（供重构窗口参考）**：src/tests 共 333 行超 160 字符，其中约 200 行集中在 tests/（机械折行即可）；src 巨型函数集中在 store.ts（validateBuiltIndex 1418 字符、rowsForDocuments 876 字符等，多为长 SQL 字符串）、epub.ts 两处遍历循环、server.ts 工具注册块。

## 可追溯提交清单

> 本清单是计划 §13.3 检查点的唯一宿主（原计划内副本已移除）。按时间倒序（各阶段提交哈希在下一阶段入清单）：

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
