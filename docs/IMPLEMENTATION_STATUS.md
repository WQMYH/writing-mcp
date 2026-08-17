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
| M3 | 进行中 | search/entity/neighborhood/document/stats、中文问句分析、别名/歧义/未解析输出、稳定排序、输入上限（query 2048 字符）、explore 执行时间上限（30s）、源指纹复用 store（未变化不重载）、0～3 跳 BFS 与逐边证据、BFS 逐层批量边查询与 locator 批量加载（AUD-020 主体）、timeline 独立确定性投影（AUD-015 主体）、图/能力词汇表冻结（AUD-022 主体）、timeline 章节时态过滤与 context reserved 参数标注、search source-trust 排序因子（AUD-012 M3 范围）、**百万字语料 P95 门禁**（491 万字实测：索引 25.7s、Explore P95 673ms、Context P95 382.5ms、Token 降幅 99.92%） | 完整重排（待 M4 + 语料）；阈值待正式写入门禁脚本 |
| M4 | 进行中（已有纵向切片） | ContextPacket、预算上限、抽取式选择、requiredRefs 脱离 top-50 直接解析（AUD-005） | 按 REVIEW_2026-08-17 审议顺序：① AUD-013 L0～L3 来源语义化 + evidenceHash 去重（核心：来源提供器注册表）；② AUD-012 残留接线（excludeRefs 先行 → targetChapter 锚定 → entityRefs/documentRefs 直解 → taskType 来源组合）；③ AUD-014 packet 计费边界 + tokenizer profile；模块化：context 拆 registry/sources/dedup/budget/layer 纯模块（详见 M0_CONTRACT Open TODO） |
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

- 批次 C（AUD-026～032 + AUD-035 第一/二阶段）已全部完成并审阅归档。
- AUD-035 第三阶段（Biome 格式化）已由用户决策延后：store.ts 即将被 M3/M4 修改，现在做巨型函数展开与全量格式化必然返工；正确时机是 M3/M4 语义冻结后的重构窗口，届时再评估格式化是否必要。
- **M3 语料基准已完成**（2026-08-17）：491 万字《语料B》语料测试，索引 25.7 秒（~19 万字/秒）、Explore P95 673ms、Context P95 382.5ms、Token 降幅 99.92%、内存 54.3MB。建议阈值已获用户接受（索引≤60s/百万字、Explore P95≤1000ms、Context P95≤500ms、Token 降幅≥95%），待正式写入门禁。
- M3/M4 语义冻结后的重构窗口 TODO：（1）store.ts 图构建/检索 SQL 抽离；（2）移除 oxlintrc.json 对 store.ts 的 ignorePatterns 忽略项；（3）评估 Biome 格式化（若执行：quoteStyle single / semicolons asNeeded / lineWidth 120）。
- M4 剩余：taskType/目标与排除引用（AUD-012）、L0～L3 语义分层与去重（AUD-013）、tokenizer profile（AUD-014）。status 的 mtime/size 快速路径（不牺牲语义 snapshot）仍待实现。
- M4 审议：`docs/REVIEW_2026-08-17.md` 已审阅 M4 功能与边界——requiredRefs 直解真实生效、L0-L3 语义化未开始（缺口=来源提供器注册表）、reserved 参数边界诚实。方向：AUD-013（来源语义化+去重）→ AUD-012 残留（excludeRefs 先行）→ AUD-014（tokenizer）→ 完整重排（M4 后，语料可复用 L93《语料B》基准）。模块化：context 拆 registry/sources/dedup/budget/layer 纯模块。
继续 v2 Step 3 剩余子门禁：中文完整问句、别名/歧义/未解析引用、稳定排序、输入边界、FTS 降级语义已落地（`4030085`）；AUD-021 源指纹复用 store 与 AUD-018 执行时间上限已落地（`c376df7`）。REVIEW_2026-08-16 的唯一 P0 AUD-005（requiredRefs 直接解析）已落地并新增 5 项回归测试；P1 首项 AUD-020 主体已落地：BFS 逐层批量边查询（CTE frontier + ROW_NUMBER 每节点 fan-out 封顶）与 locator/span 批量加载，语义（fan-out 64、全局 512、逐边证据、确定性排序）不变，新增 2 项宽图护栏测试；真实语料百万字 P95 门禁待代表性语料可得后补。AUD-015 主体已落地：timeline 为携带时态属性实体与 precedes 边的确定性投影（章节位置排序，新增 TIMELINE_PROJECTION 诊断），章节时态过滤待目标章节输入。AUD-022 主体已落地：确定性可抽取词汇表冻结为 ENTITY_KINDS/EDGE_KINDS/WORK_CAPABILITIES（EntityKind 补入 OutlineNode，新增 EdgeKind/WorkCapability 类型，capabilities 类型收窄），未实现关系不作为已有能力（M0_CONTRACT 新增 M3 graph vocabulary freeze amendment）。AUD-012 M3 范围已落地（按用户里程碑优先路线，M4 深水区延后）：writing_explore 新增可选 targetChapter，timeline 投影按 from ≤ 锚点 ≤ to 做章节时态过滤（无界 from/to 视为书首/书尾）；writing_context 新增 reserved 输入 targetChapter/entityRefs/documentRefs/excludeRefs 且描述显式标注 taskType 等参数 reserved（接收验证、不改变装配，M0_CONTRACT 新增对应 amendment）。AUD-012 残留的 source_kind 排序因子已落地（按用户决策，M3 期内唯一排序变更）：search 中命中查询词的 deterministic 行获固定 +0.25 信任加分，不被原始分更高的 alias-only heuristic 行压过（M0_CONTRACT 新增 source-trust amendment，新增 1 项翻转回归测试）。AUD-023 主体已落地：开发捕获事件新增有界 outputHits（命中 ref/kind/sourceKind/score + locator 哈希、omitted 原因、候选 workRef，各列上限 100），正文/标题/路径不入捕获；通用 JSONL 与逐调用报告保持只存数量（M0_CONTRACT 新增 capture bounded-refs amendment，新增 1 项回归测试）。AUD-024 主体已落地：general diagnostics.jsonl 的轮转检查与追加入同一按目录串行队列，并发记录不再交错轮转重写与追加；容量上限（1000 事件/5 MiB）生产不变、测试可注入，写失败降级为 persistence=failed（M0_CONTRACT 新增 general JSONL serialization amendment，新增 3 项回归测试）。AUD-025 主体已落地：批次 B 关闭——五个工具的输出 data schema 导出为单一真相源（注册信封与 wrapper 自校验共用）；wrapper 记录成功前自校验，失配抛出新错误码 `OUTPUT_SCHEMA_MISMATCH`（记 failure + isError 一致信封 + 专用 recovery）；`createServer` 支持注入 `onerror`（接在底层 Server 上），stdio 入口把协议层错误写入 stderr（`[writing-mcp][protocol]` 前缀）；SDK 输入拒绝属协议层、在 mcp_calls_only 观察边界外（裸 isError 文本、无诊断记录）；M0_CONTRACT 新增 protocol error boundary amendment，新增 `tests/protocol-boundary.test.ts` 5 项回归。AUD-026 主体已落地：generic 作品边界确定化——目录内每个 EPUB 独立成候选（与直接解析该文件同 workRef/rootPath），其余文本合成一个目录作品，多书目录返回 ambiguous 而非静默合并；capabilities 由实际输入决定（纯文本作品不再声明 epub），无 epub 能力的目录作品不加载 EPUB 文件（M0_CONTRACT 新增 generic work boundary amendment，新增 4 项回归并更新 epub 多书测试）。AUD-027 主体已落地：章节编号语法明确化——阿拉伯数字/中文数字（一至九百九十九，含百位合成，修复罗马数字被 Number("iv") 丢弃、百以上中文数字不支持）、规范罗马数字（i…mmmcmxcix）三种章号确定性支持；非法编号确定性跳过并入上一章，卷重置推断对三种编号一致生效，Markdown 中文数字章名识别为 chapter（M0_CONTRACT 新增 chapter-number syntax amendment，新增 5 项回归）。AUD-028 主体已落地：EPUB 资源上限——entry 数/单文档（含 OPF）/总解码量三级确定性上限（默认 4096 entries / 16 MiB / 64 MiB），越限抛稳定错误码 `EPUB_TOO_MANY_ENTRIES`/`EPUB_DOCUMENT_TOO_LARGE`/`EPUB_TOTAL_TOO_LARGE` 而非挂起或无限膨胀；上限可经 `new GenericAdapter({ epub })` 注入，`DEFAULT_EPUB_LIMITS` 导出（M0_CONTRACT 新增 EPUB resource limits amendment，新增 4 项回归含 EPUB 2.0 默认上限加载）。AUD-029 主体已落地：snapshot 一致性——每次适配器读取前后校验源指纹，不一致有界重试一次后仍不一致拒绝 `SOURCE_CHANGED_DURING_READ`，snapshot 不再可能混合不同时刻的源状态；文本链路新增单文件/作品总量确定性上限 `SOURCE_FILE_TOO_LARGE`/`SOURCE_TOTAL_TOO_LARGE`（默认 16 MiB / 64 MiB，可经 `new GenericAdapter({ text })` 注入，`DEFAULT_TEXT_LIMITS` 导出）（M0_CONTRACT 新增 snapshot consistency amendment，新增 5 项回归）。AUD-030 主体已落地：span 硬上限与边界规则——超长单行硬切为共享同一源行的有界 chunk（span 内容永不超 `maxChars`），locator 精确排除被裁空行，相邻 span 连续平铺无重叠无遗漏；重叠方案已评估并拒绝（重复行使确定性 mention/边证据重复计数，实测 graph 测试翻转佐证）（M0_CONTRACT 新增 span hard cap amendment，新增 5 项回归）。AUD-032 主体已落地：进程生命周期与优雅关闭——新增 `createStdioRuntime`（`{ server, shutdown }`，shutdown 先关 MCP server 再关 service、幂等、只写 stderr），SIGINT/SIGTERM/stdin EOF 统一走同一关闭链并确定性 exit 0，5 秒 grace guard 兜底强制终止（同步 SQLite 长操作不可取消但进程必然退出），stdout 专属 JSON-RPC（M0_CONTRACT 新增 process lifecycle amendment，新增 5 项回归）。AUD-035 第一阶段已落地（用户确认顺序：门禁 → 抽离 → 格式化）：oxlint lint 门禁修到 0 警告 + @vitest/coverage-v8 棘轮门禁（行覆盖 92.78%，阈值 90；vitest 别名改指 src 修复此前经 dist 的覆盖率失真）；`store.ts` 暂被 oxlint minified-file 启发式忽略，拆分后移除。AUD-035 第二阶段已落地：generic 适配器 21.8 KB 单文件拆为 errors/numbering/txt/epub 四个策略模块 + 发现/装载编排（逻辑逐字搬迁，覆盖率逐位不变证明纯结构重构）；store.ts 图构建抽离按用户决策延后。AUD-035 第三阶段（Biome 格式化）经用户评估后决策延后至 M3/M4 语义冻结后的重构窗口再评估（store.ts 即将被 M3/M4 修改，现在展开必然返工）；批次 C 至此全部完成。完整重排按用户决策搁置到 M4 + 代表性语料之后，候选统计校准待语料。M4 剩余：taskType/目标与排除引用（AUD-012）、L0～L3 语义分层与去重（AUD-013）、tokenizer profile（AUD-014）。status 的 mtime/size 快速路径（不牺牲语义 snapshot）仍待实现。

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

**审阅附注（2026-08-16）**：三条均在已提交的 HEAD 上通过 `tsc -b` 与 30/30 基准验证。

> 2026-08-16 审阅时发现的工作区待办（AUD-028 半成品与 L102 语法错误）已在 AUD-028 提交中修复并全量验证。

**审阅附注（2026-08-17）**：批次 C 六条（AUD-028～032 + AUD-035-1/2）审阅通过，全部归档。

## 待审阅修复方案（Pending Review）

> 按用户授权（2026-08-16）自主执行的修复，逐条记录方案内容并标注待审阅；审阅通过后归档入上节。

**2026-08-17 批次 C 全部归档**：AUD-028～032 + AUD-035-1/2 共六条已审阅通过，归档入上节。AUD-035-3（Biome 格式化）经用户决策延后至 M3/M4 语义冻结后的重构窗口再评估（记录于「下一步」与「已审阅」章节）。

### AUD-035 工程硬化第三阶段：Biome 格式化（用户决策延后，2026-08-17）

- **原计划**：门禁 → 抽离 → 格式化三步中的最后一步，Biome 全量格式化（quoteStyle single / semicolons asNeeded / lineWidth 120）。
- **决策**：用户评估后决定延后，不执行。理由：门禁与适配器抽离已是 AUD-035 的实际价值；store.ts 巨型函数展开是纯手工、高风险、零功能收益的工作，且 store.ts 马上要被 M3/M4 修改，现在展开必然返工。正确时机是 M3/M4 语义冻结后的重构窗口，届时再判断格式化是否必要。
- **执行记录**：@biomejs/biome 2.5.8 曾安装用于评估，随后已卸载回退（package.json 与 pnpm-lock.yaml 无残留差异）；未产生任何格式化改动。
- **评估数据（供重构窗口参考）**：src/tests 共 333 行超 160 字符，其中约 200 行集中在 tests/（机械折行即可）；src 巨型函数集中在 store.ts（validateBuiltIndex 1418 字符、rowsForDocuments 876 字符等，多为长 SQL 字符串）、epub.ts 两处遍历循环、server.ts 工具注册块。

## 可追溯提交清单

> 本清单是计划 §13.3 检查点的唯一宿主（原计划内副本已移除）。按时间倒序（各阶段提交哈希在下一阶段入清单）：

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
