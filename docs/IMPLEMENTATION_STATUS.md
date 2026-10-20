# Writing MCP MVP 实施状态

> **本文档是 Writing MCP 实施状态的唯一事实源。** v2 计划、README、REVIEW 文档均只引用本文件，不维护状态副本；任何"当前做到哪、多少测试、哪些 AUD 已关闭"的判断以本文为准。发现其他文件记载状态时，以本文为准并修正该文件。
>
> 检查点时间：2026-10-20（EXT-OBS-001 本地兼容修复候选）
> 当前状态：以 main `d82ffdf` 为基线，在隔离分支 `fix/ext-obs-001-excerpt-segments` 提交代码候选 `5da4160`，实现可选 `excerptSegments`；保留旧摘录、顺序、哈希计算及 span locator，复用 sourceSegments 提供逐窗口定位。新增 9 项先红后绿；本次相关 6 文件/121 项、单选既有哈希回归 1 项、增强后的摘录/EPUB 2 文件/62 项以及 check、lint 通过（测试集合有重叠，不相加）。当前只完成本地定向验证，待独立复核；未合并、push、安装或替换现用服务，未重跑完整 411 项/私有材料/模型/外部 tokenizer。M0 契约和测试映射已同步；历史云端 19+6、window-aware 7/7 不是本候选验收，旧连续子串断言错误不计作产品缺陷。
> 上次集成验收（2026-10-17，历史记录）：[PR #1](https://github.com/WQMYH/writing-mcp/pull/1) 已由 merge commit `e0d8ee1` 保留完整阶段历史合入 main 并推送；GitHub 已读回 `MERGED`。MR1～MR6 的 25 类修复、W017 再开后的 `9d3ada3`、契约、回归、经批准的黄金基线校准及验收映射均已核对进入 main。合并前本机 58 文件/411 项通过；合并后完整 `pnpm verify`，隐私/check/lint、58 文件/411 项、公开 30/30、coverage lines 91.32%/branches 80.16% 全部通过，无阈值放宽。PR 最终头 `4356552` 的 Windows/Linux CI `38942991163` 均已成功。当时三个完全合并且无未提交内容的 worktree 已清除，依赖 junction 只解绑、不遍历目标。私有/语料/tokenizer 既有证据仍绑定原被测提交；私有材料、本地报告和分支引用保留，不宣称发布或真实宿主 UI 验收。
> HB-M4 复审修正：`eca7b3e` 只建立了纵向切片，完成声明由后续 Storyforge `0aa1ca4` 才真正闭合。该修复确保当前快照先激活再查询、MCP 工具信封 typed 解包、真实 `evidence.excerpt`/locator/path 注入、只替换快照覆盖的长期来源并保留用户消息/连续性/当前事实/未知来源、`budget_unsatisfiable` 阻断 provider，以及生产或未显式启用环境不初始化 localhost client。新鲜门禁：6 个 Bridge 测试文件/30 项、eslint、tsc、生产 build 全绿；Writing MCP `pnpm verify` 52 文件/271 项、公共基准 30/30、coverage lines 91.39%。

## 恢复入口

```powershell
git clone https://github.com/WQMYH/writing-mcp.git
cd writing-mcp
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

最近验证（2026-08-20，评测仪表重写 + P1 卷感知切分修复后，`30f1e40`/`c1de724`）：口径用户拍板 gold-span hit（逐字包含 + ref 匹配），唯一宿主 `scripts/gold-hit.mjs`；仪表自检全过（单调性、阴性对照 hit=false、冒烟）。P1 修复：holdout 切分按卷取前3+后2，territories 从语料章题现算（卷1:1-30 head 1-3 tail 29-30；卷2:1-25 head 1-3 tail 24-25），切分恢复计划 §250 的 18/24。**6 因子真基线**：train（18 条）recall@5=77.8% / @10=83.3% / @50=100%，MRR=0.580，required@50=1.0；holdout（24 条）@5=83.3% / @10=91.7% / @50=100%，MRR=0.690，required@50=1.0。**miss 归因**（attribute-misses.mjs）：train 4 条 + character-001 全部 L2 候选可达、非 tie-break——纯排序因子问题，核心是 coverage 缺口（查询词 vs 证据 span 措辞不重叠，如 event-004 查询"受伤/住院"而引文是"病床/点滴瓶"）。待办：逐因子 ablation 落盘（预期：删因子不会动黄金门禁，价值在证明不可删）、门禁脚本 + baseline.json 快照、契约重新 ratify。

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
- server 边界按 compact JSON 的 UTF-8 字节执行响应门禁：`structuredContent.result` ≤200,000 bytes、返回诊断 ≤8,192 bytes、Markdown fallback ≤16,384 bytes；按工具确定性裁剪后才写入 recorder，无法保真裁剪时返回 `RESPONSE_TOO_LARGE`。
- 所有公共工具通过同一个 server-side post-call diagnostic wrapper；成功和失败均返回 `traceId`、`executionSummary`、持久化状态和报告引用，不依赖 prompt 提醒。
- 每次调用静默写入脱敏 JSON 报告和有界 JSONL 事件；显式 `start_capture → diagnosticRunRef → finish_capture` 可生成小规模真实使用链的规范 JSON 和可选 Markdown。
- 诊断产物只保存 MCP 可观察的参数/结果摘要、错误、耗时、revision、证据引用、截断和 Token 指标；默认不保存查询文本，也不保存正文、绝对路径、堆栈、SQL 或凭据。
- 诊断目录按首用/64 次写入/新增 1 MiB/估算越界做摊销扫描，使用合作式清理锁并按稳定顺序先清 per-call reports、再清 closed captures；active capture 与当前返回 artifact 受保护。100 MiB 是多进程下的最终收敛目标，不是瞬时硬上限。
- EPUB OPF、单个 spine 文档与累计 spine 上限均按解码后的 UTF-8 bytes 计算；SIGINT、SIGTERM 和 stdin EOF 共用一个幂等 termination promise，正常关闭不主动 `process.exit(0)`，5 秒仅作悬挂兜底。
- `benchmarks/m0.json` 已建立 30 个机器可读任务，并由 `tests/benchmark.test.ts` 执行确定性门禁。
- `docs/M0_CONTRACT.md` 已冻结引用格式、SQLite v1、查询限制、初始排序、Token 估算与 MCP 结果规则。
- `docs/REFERENCE.md` 已归纳成熟知识维护、精准检索、属性图和小说领域模型经验，并明确其为设计输入而非 v1 承诺。
- 风险审阅已落实进 v2：技术选型对齐，M3/M4 公共参数与性能成为显式门禁，M5 增加真实语料验收集前置条件。

## 里程碑完成度

2026-10-16 的 25 类复审已重新打开下列对应门禁；历史 AUD 关闭记录只证明当时限定范围，不替代 W-MCP-001～025 的处置。用户已授权按既有修复计划持续执行，未授权合并 main；有新实质性选择或越界操作才停下询问。

| 里程碑 | 状态 | 已完成 | 未完成门禁 |
|---|---|---|---|
| M0 | 主体完成 | 版本化协议/存储合同、五工具 schema、统一信封、最小 fixture、30 个任务、Token/事实基线 | 指标含义和实现契约继续校准 |
| M0.1 | W017 再开修复与双平台门禁通过 | 统一诊断 wrapper 保留；逐项目持久化捕获检查 + 封 admission/drain 后最终检查；W019 首调用恢复保持 | 不新增超时 RPC 取消/跨进程事务保证；真实 UI/PNA 不以合成测试替代 |
| M1 | 本轮 MR2/MR6 相关门禁通过 | 六项文本修复、W014 必需 spine 完整性与真实 SDK 当前来源证据链，完整/私有/双平台验收通过 | 不声称覆盖全部 EPUB 变体 |
| M2 | 本轮 MR1/MR6 相关门禁通过 | W012 顺序边/证据保留；W007 受管理连接替换、热服务/磁盘一致、失败恢复及 SDK 改稿/重启/删索引重建 | 不是跨进程读协调或旧版 Linux WAL 低层逐调用取证；PR 未合并 |
| M3 | 本轮 MR3/MR4/MR6 相关门禁通过 | 身份/歧义/增量/评分/窗口/章节位置，完整/private/gold/双平台及超大语料性能门禁通过 | 有限代表性任务不承诺任意查询延迟 |
| M4 | 本轮 MR4/MR6 相关门禁通过 | 四项修复与 excerpt-only accounting 保留；独立 tiktoken 两种编码对本地冻结完整 packet 的降幅材料门禁通过 | MCP 的估算字段不变；不是模型账单/credits 承诺；36/42 quote exposure 独立保留 |
| M5 | 进行中（Storyforge 首宿主链已闭环） | stdio、五工具注册、structuredContent、outputSchema、统一结果/错误/诊断信封、协议测试、单个真实转换型 EPUB 回归；`CLIENT_SETUP.md` 覆盖 Node 24、pnpm/build、Qoder/Codex stdio 配置、首次调用路由、七类故障、诊断隐私与 v1 边界；Storyforge Host Bridge HB-M0～HB-M6 已完成（最终配对提交：Writing MCP `80ac885` + Storyforge `655ae8e`），真实浏览器链验证证据注入、失败关闭、显式单次绕过与零自动写回 | 真实 InkOS、更多 EPUB 2/3 变体、独立 MCP 客户端安装/连通性验收；外部 tokenizer 结论仍属 M4 独立门禁 |

历史 AUD 路线：Step 1 关闭 AUD-003、006、011、031，Step 2 关闭 AUD-001、002、007～010 的限定门禁；Step 3 完成中文问句、别名/歧义、稳定排序、输入上限、FTS 降级与检索诊断（`aa84645`）。AUD-018 的事后计时/错标测试已由 `e57264c` 的 delayed-source 回归替换，覆盖 explore/context/evaluator、队列占用与 close 等待；SourceSnapshot 双指纹、requiredRefs 池外直解继续保留。本轮 MR1～MR6 关闭的是 25 类独立审查缺陷及约定工程门禁，不据此宣称 M5 所有格式/部署/用户验收或整个 v1 发布完成。

## 当前测试覆盖

MR1 从修改前 287 项增加至 316 项：图回归 6 项、EPUB 21 项、service/snapshot 2 项，并补强失败保存/恢复断言；既有 pre-read 断言只做 realpath 校正，无测试跳过或阈值下调。

MR2 新增 W001 七项、W002 十项、W010 十二项、W011/016/020 二十四项，分别针对性 39/55/35/73 项通过；完整 verify 与双平台 CI 已通过。

MR3 新增 W013 一项、W005 三项、W008/021/015/024 十项、W009 四项，共 18 项；完整 verify 与双平台 CI 通过。

MR4 新增 W003/W004 三项、W006 三项、W018 三项，共九项；完整 verify、私有/gold 与双平台 CI 通过。

MR5 增至 58 文件/408 项，包含真实默认入口/严格状态、Unicode 输入边界、持久化捕获拒删与首调用恢复；MR6 再增一项 SDK 恢复链至 409 项，并补同一 W019 测试的跨项目阴性断言。106 个原名历史缺口和 2 个替代组的逐项本机回执独立登记。

> 详细清单（测试文件 → 主题映射、按能力域的覆盖条目）见 [`tests/README.md`](../tests/README.md)。本段只保留概述，细节以测试清单为准。

- 58 个测试文件 / 411 项测试，W017 再开后的完整本机链和 `9d3ada3` Windows/Linux CI 均通过，新增两项真实交错回归；V8 父进程 coverage 不包含真实 CLI 子进程，未降低既有阈值。
- 关键门禁：30/30 公共基准；无分词中文问句命中；重复 Chapter 身份独立；源变化 status 转 stale；未变化源零重载；删除索引可完整重建。

## 已知限制

- EXT-OBS-001 已补逐窗口 `excerptSegments`，但仍为行级、非列/字节级来源定位；旧 `locators` 保留 span 包络，synthetic stats/既有 pathEvidence 可无新字段。元数据占响应字节预算，不占 excerpt-only Token 估算；预算不够只做整项裁剪或 required 稳定错误。
- `timeline` 已实现为携带时态属性实体与 precedes 时序边的确定性投影，支持 targetChapter 章节时态过滤（AUD-012 M3 范围）。
- context 的 `targetChapter`/`entityRefs`/`documentRefs`/`excludeRefs` 已接线（AUD-012，`732df85`）：targetChapter 锚定层内排序、entityRefs/documentRefs 直解入 blocks、excludeRefs 过滤；`taskType` 仍为保留 hint——值域开放（未知值接受并记录）、**永不影响装配**（2026-08-17 方向：无 taskType 策略引擎）。
- 角色实体提取只覆盖角色类文档 heading；原生 `[[alias]]` 会查询持久化 aliases，唯一 owner 才形成 `mentions`，多 owner 保持 `AMBIGUOUS_ALIAS` 未解析；查询期另提供透明的中文称呼形态扩展。
- EPUB 仍采用确定性轻量解析，尚未覆盖 DRM/加密、复杂命名空间、导航目录语义、脚注回链、图片内容和全部 EPUB 2/3 变体；内部章节切分目前依赖独占行的中英文编号标题。
- `workRef` 只在当前 server 进程中注册；重启后客户端需重新调用 `writing_resolve`。
- schema v4 writer lock 是 Writing MCP 进程间的合作式协议，不能强制无关程序释放 SQLite 句柄；此类占用稳定返回 `INDEX_BUSY`。
- A1 SourceSnapshot/fingerprint 已完成并回归覆盖：未变化时复用 store，来源变化即通过 adapter snapshot 触发一致性重读/索引；保留同 mtime/size 原地替换的明确边界，不再标记为待审阅或待落地。
- MR4 私有 top-20 42/42、required 16/16、证据覆盖率 100%；完整引文露出仍 36/42，另六项属于独立摘录质量诊断。W006 已修复单专名大小写窗口，不借此承诺任意多词或整条标注引文必露出。gold @50 与产品 top-20 分开报告；MR2 正确分片的 holdout @5/MRR 重校准经单变量对照与用户接受，未改标签、排序或 @50/required 硬阈值。
- 中文问句分析当前是有界规则与 n-gram，不是通用分词器；问题短语表会继续通过真实调用链回归校准。
- `stats` 的 content 受 900 字符 excerpt 截断（既有模式，`item()` 切片）；`contextSources` 增大了 stats JSON，现实 kind 数下安全，但 stats 内容截断属潜在坑。
- `entityRefs`/`documentRefs` 的 pinned 块不参与 evidenceHash 去重（显式请求豁免，与 requiredRefs 一致）；已是搜索命中的 pinned ref 保持搜索命中排名，不再获得 pinned 提升。

## 下一步

- EXT-OBS-001 候选待独立复核，重点核 UTF-16 半开区间、跨 XHTML/sourceStartLine、预算整项处理及旧字段兼容；本次未安排新 Work/子智能体，后续由现有调用方安排复核。原始定向命令：`pnpm exec vitest run tests/excerpt-segments.test.ts tests/search-correctness.test.ts tests/span-hard-split.test.ts tests/epub.test.ts tests/context-required-refs.test.ts tests/response-limits.test.ts`（121/121，exit 0）；`pnpm exec vitest run tests/graph-identity-evidence.test.ts -t 'separates stable identity hashes from verifiable evidence hashes'`（1 通过、17 未选，exit 0）；`pnpm check`、`pnpm lint` 均 exit 0。旧版本 `pnpm exec vitest run tests/excerpt-segments.test.ts` 为 9/9 缺少元数据失败；中间修正两处测试前提（MCP 必填 operation、required true/false 序列化长度差）及按错误 code 而非 message 断言，未将其登记为产品缺陷。
- MR1～MR6、W017 再开修复及 main 集成已收口；[验收映射](REPAIR_ACCEPTANCE_2026-10-17.md) 保留初次验收、反例及修复补遗。此前 Draft/不合 main 的限制已由本次用户明确合并授权取代；发布、下一轮功能和真实 UI 测试未在本次集成中执行。

- Host Bridge：Storyforge 首宿主 HB-M0～HB-M6 已关闭；维持静态单宿主、loopback、显式配对、失败关闭和零自动写回边界，不在本轮扩成动态插件市场。下一步先把真实使用反馈转成协议兼容性回归，再决定第二宿主或可配置端口等扩展。
- M5 收尾：补真实 InkOS、更多 EPUB 2/3 变体及独立 MCP 客户端安装/连通性验收；`.github/workflows/verify.yml` 已存在并只跑公共 `pnpm verify`，私有验收链永不进 CI。
- 历史可靠性分支已集成到原基线 `af78942`；本轮 MR1～MR6 经 `e0d8ee1` 集成，不再等待旧集成决策。`d87f8b4` 的独立 coverage 构建及 `5f5cd58` 的 worker 上限保持；不得用脱离被测版本的历史结果替代验收。
- 批次 C（AUD-026～032 + AUD-035 第一/二阶段）已全部完成并审阅归档。
- AUD-035 第三阶段（Biome 格式化）已由用户决策延后：store.ts 即将被 M3/M4 修改，现在做巨型函数展开与全量格式化必然返工；正确时机是完整重排落地后（检索侧冻结）的重构窗口，届时再评估格式化是否必要。
- 语料和外部 tokenizer 的 MR6 被测版本、有限任务集合、结果及序列化边界见[验收映射](REPAIR_ACCEPTANCE_2026-10-17.md)；原始报告与 Token 材料仅留本机。本次纯集成未重复测量，不把历史性能或 Token 数值改记到 merge commit。
- **重构窗口按触碰面分流（2026-09-02 校正）**：装配侧 context 的 registry+dedup 已落地，sources/budget/layer 仍只在有功能需求时拆分；`store.ts` 的 oxlint 豁免已由 `5e6f6c1` 移除并以 0 警告进入门禁，不再等待格式化。检索 SQL 抽离与 Biome 全量格式化仍延后，禁止仅为覆盖率或风格指标重写生产结构。
- 本轮 M4 的 W003/004/006/018 回归及三项非空上下文的外部 tokenizer 复核已收口，见验收映射；不再保留为待修项。`mixed-cjk-v1` 仍为 excerpt-only 启发式估算，外部材料比较不代表完整 Agent 账单或 credits。
- M4 来源/约束装配、accountingScope、response-size、Task 5 硬化及 A1 双指纹实现保留；私有/gold 门禁与 MR6 语料/tokenizer 原始回执均只在本机，按验收映射绑定各自被测提交。

> 更早阶段（Step 3 / AUD-005～035）的逐条落地叙事已于 2026-08-17 移除：事实由「可追溯提交清单」与 commit message 承载，审阅结论由下节表格承载，不在此重复。

## 已审阅修复记录（原 Pending Review 节归档）

> 本节原为「待审阅修复方案」，逐条记录已执行修复的方案内容。**2026-08-16 审阅通过后归档**：方案细节见对应提交的 commit message 与 `tests/README.md`，此处只保留审阅结论，不再复制完整方案。

| AUD | 审阅结论 | 提交 | 测试 | 接口影响 |
|---|---|---|---|---|
| **AUD-025** 协议层错误边界 | ✅ 合格：输出 data schema 单一真相源、wrapper 记录前自校验（`OUTPUT_SCHEMA_MISMATCH`）、`createServer` 可注入 `onerror`→stderr、SDK 输入拒绝属协议层观察边界外 | `9cd19d4` | `protocol-boundary.test.ts` 5 项 | 加法式（新错误码 + 可选构造参数） |
| **AUD-026** 通用作品边界与 capabilities 实际化 | ✅ 合格：逐 EPUB 独立候选、多书目录 ambiguous、capabilities 由实际输入决定 | `2a02a89` | `generic-work-boundary.test.ts` | 仅 generic 发现语义变更（行为变更已记录） |
| **AUD-027** 章节编号语法明确化 | ✅ 合格：阿拉伯/中文（至九百九十九）/规范罗马三语法冻结、非法编号确定性跳过、卷重置一致生效 | `55b5543` | `txt-numbering.test.ts` 5 项 | 仅解析覆盖面扩大 |
| **AUD-028** EPUB 资源上限 | ✅ 合格：三级确定性上限（4096 entries / 16 MiB / 64 MiB）、稳定错误码、可注入上限 | `e150b88` | `epub-resource-limits.test.ts` 4 项 | 加法式（新错误码 + 新导出 + 可选构造参数） |
| **AUD-029** snapshot 一致性 | ✅ 合格：读取前后指纹校验、有界重试、文本内存上限、源变化显式错误 | `b1da1f0` | `snapshot-consistency.test.ts` 5 项 | 加法式（新错误码 + 新导出 + 构造参数扩展） |
| **AUD-030** splitDocument 硬切与边界规则 | ✅ 合格：超长行硬切、locator 精确排除空行、连续平铺无重叠无遗漏、重叠方案拒绝 | `2c89a2e` | `span-hard-split.test.ts` 5 项 | 无接口变更（仅切分行为变化） |
| **AUD-032** 进程生命周期与优雅关闭 | ✅ 合格并硬化：`createStdioRuntime` 与 process termination 均返回同一 memoized promise；信号/stdin EOF 共链，先关 server 再关 service，失败后置汇总，正常退出不主动调用 `process.exit(0)`，5 秒仅作悬挂兜底，stdout 纯 JSON-RPC | `a3877c3` + `61bc056` | `lifecycle.test.ts` 11 项 | 加法式内部测试 seam + 行为收敛（正常自然退出/失败非零） |
| **AUD-035-1** lint/coverage 门禁 | ✅ 复审收口：初版门禁仍豁免 `store.ts` 且全局 branch 仅 73%；`5e6f6c1` 移除豁免、修净两条真实 warning、将全局 branch 棘轮升至 75%，并冻结 MCP server branch 60% 文件级底线（实测 60.75%） | `c2093cd` + `5e6f6c1` | 57 文件/287 项 + coverage 门禁 | 无产品接口变更（工程基建） |
| **AUD-035-2** generic 适配器模块抽离 | ✅ 合格：21.8KB 单文件拆为 errors/numbering/txt/epub 四策略模块、公共 API 兼容、覆盖率逐位不变 | `e3088af` | 108/108 回归 | 无（纯结构重构） |
| **AUD-013** 来源提供器注册表与 evidenceHash 去重 | ✅ 合格（含缺陷修复）：语义分层、required 晋升 L0、duplicate_evidence 折叠；审阅发现 kind 输入接错——searchRows 返回小写文档类型（d.kind）而注册表键为大写实体类型，全落 L3 → `5aacdb0` 以 DOCUMENT_KIND_ALIASES 归一修复并补真实路径 L1/L2 断言（教训：原单元测试喂大写键绕过真实输入路径而漏检） | `d7f8c24` + `5aacdb0` | `context-source-registry.test.ts` 7 项 | 无接口变更（内部装配语义） |

**审阅附注**：2026-08-16 首批三条与 2026-08-17 批次 C 六条均在已提交 HEAD 上通过 `tsc -b`、全量测试与 30/30 基准验证；2026-08-16 发现的工作区待办（AUD-028 半成品与 L102 语法错误）已在 AUD-028 提交中修复。

## 历史实施记录（非当前待审）

> 以下内容保留 2026-08-16～18 当时的实施/验证措辞，仅供历史追溯，不表示当前仍在 Pending Review。当前状态只读文首、里程碑表和“下一步”；AUD-035-3（Biome 格式化）仍按用户决策延后。

### AUD-012 接线审阅三缺陷修复（待审阅，2026-08-17）

- **背景**：AUD-012 接线（`732df85`）归档审阅发现三个缺陷，已按冻结执行顺序 ① 修复，锚点见计划 Step 6「M4 审阅锚点」。
- **修复**：（1）`writing_context` 工具描述与契约/代码矛盾——描述误称 excludeRefs 胜出 requiredRefs，已修正为契约真实优先级（requiredRefs 胜出 excludeRefs，excludeRefs 胜出 entityRefs/documentRefs pin）；（2）`budget_unsatisfiable` 分支曾把 excluded/duplicates/pinned/unresolved 一律标成 `required_minimum_exceeds_budget`，已恢复各自真实原因（excluded/duplicate_evidence/budget_limit/not_found），仅 required 类承担该原因；（3）tests/README 映射漂移——补登记 `context-constraint-wiring.test.ts`、更新 `context-reserved-params.test.ts` 条目为约束接口措辞。另修复接线测试偶发：ch3 夹具标题补查询词使确定性 heading 加分打破三方同分，无锚点断言改为确定性首块断言。
- **验证**：tsc 0 错、122/122 测试、30/30 基准、lint 0 警告、coverage lines 92.91%≥90。
- **契约**：M4 constraint-interface wiring amendment 补两条（omitted 真实原因语义 + 描述优先级声明义务）。

### AUD-012 残留「来源目录」可观测能力（待审阅，2026-08-18）

- **背景**：AUD-012 审议顺序 ② 残留项——stats/diagnose 暴露作品可用上下文来源清单，已入计划 §8 Step 6 与契约 Open TODO。
- **实现**：`writing_explore` 的 `stats` 操作新增 `contextSources` 字段，包含 `byLayer`（L1/L2/L3 文档计数）和 `byKind`（按文档种类计数）。复用 AUD-013 的 `CONTEXT_SOURCE_REGISTRY` 与 `DOCUMENT_KIND_ALIASES` 归一逻辑，确保分层与上下文装配一致。纯模块 `contextSourceCounts` 方法在 `store.ts`，无新写入路径、无新错误码、无 `ContextPacket` 形状变化。
- **验证**：tsc 0 错、123/123 测试（新增 `source-directory-observable.test.ts`）、30/30 基准。闸门待跑。
- **契约**：M0_CONTRACT 新增 M4 source directory observable amendment。

### AUD-012 审阅修复二（2026-08-18 审计 C4/C5/C6，待审阅）

- **背景**：AUD-012 实现审阅（含 `732df85` 接线与 `67ae077` 来源目录）发现 7 项问题，用户决策全部处理；其中 C1-C3 为仓库卫生与文档陈旧，C4-C6 为代码/语义，C7 记录进已知限制。
- **修复**：
  - C1：`67ae077` 误提交 `.commit-msg-tmp.txt`（17 行临时提交信息文件）→ 删除。
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

- `5da4160` — EXT-OBS-001 本地候选：保留窗口偏移，新增返回摘录 UTF-16 半开区间及 source-map 行定位；旧 excerpt/顺序/evidenceHash/span 包络不改，索引无迁移。新增 9 项先红后绿；6 文件/121 项、单选哈希回归 1 项通过，补强 `sourceStartLine + XHTML` 和真实合成 EPUB 导入元数据后执行 `pnpm exec vitest run tests/excerpt-segments.test.ts tests/epub.test.ts`，2 文件/62 项、exit 0；check/lint/diff-check 通过。仅本地待独审，不部署、不 push。
- `e0d8ee1` — merge(PR #1)：保留 MR1～MR6、W017 再开修复及验收记录的全部提交历史；合并树与 PR 最终头内容一致，合并后完整 verify 58/411、公开 30/30、coverage 91.32%/80.16% 通过，已推送并读回 GitHub MERGED；main 的 [CI 38992198751](https://github.com/WQMYH/writing-mcp/actions/runs/38992198751) Windows/Linux 均 completed/success。确认祖先关系、干净状态及无独有本地材料后，清除 `wm-publish-verify`、`writing-mcp-canary-m5`、`writing-mcp-mr1` 三个 worktree；main 依赖、分支引用及工作区私有证据保留。
- `9d3ada3` — fix(bridge)：重新打开 W017 后，通过真实 inspect/barrier 复现 capture 成功落盘后仍被删除；封 admission/drain 后独占活 child 复查，拒删保留 project/index/meta/child，反向请求 503，其他项目 capture 保留；24 项针对性与完整 58/411、30/30、coverage 91.32%/80.16%，双平台 CI `38942293970` 通过，PR 正文已修正，已推送。
- `d457e07` — docs(mr6)：初次固定验收归档；后来 W017 同 Bridge 反例推翻了当时的全面关闭声明，原证据保留并由本轮补遗更正。

- `02eb2b8` — test(bridge)：W019 有效 capture 跨项目使用返回 NOT_FOUND、原 child PID 不变；两条重启用例仍保持首个相关调用未经预热。6 项真实 CLI/JSON 回执、check/lint 通过，最终 Windows/Linux 完整 CI `38935521968` 通过，已推送。
- `0759c76` — test(mr6)：真实 SDK 五工具/编辑/stale/增量/重建/重启/删索引重建；原文证据、revision/ref 与诊断回归。完整本机等价 verify 58/409、公开 30/30、coverage 91.21%/79.91%，双平台 CI `38934729394` 通过，已推送。
- `10d5d67` — docs(mr5)：归档五类修复及完整本机/私有/gold/Windows/Linux 门禁，继续 MR6，已推送。

- `6421740` — fix(bridge)，W019：相关请求先恢复 bridge-owned 作品注册，再校验捕获；full-CLI/child 双重启及首个 finish_capture、真实 missing/closed 错误与 PID/锁回归。MR5 完整/私有/gold/双平台门禁通过，已推送。

- `1006fdd` — fix(bridge)，W017：生产 CLI 持久化捕获守卫、异步逐项目检查/失败关闭；真实拒删/其他项目可删/重启后关闭/实际 PID 退出，5 文件/32 项及 check/lint 通过，已推送。

- `648895e` — fix(protocol)，W025：Unicode 码点上限贯通 JSON Schema/Zod/SDK/core 与标签持久化；新 4 项真实边界回归及相关 22 项、check/lint 通过，已推送。

> 本清单是计划 §13.3 检查点的唯一宿主（原计划内副本已移除）。按时间倒序（各阶段提交哈希在下一阶段入清单）：
> 推送状态校正（2026-09-01）：下方 HB-M0～HB-M3 条目末尾的“本地提交，未推送”保留为当时的历史状态；对应 Writing MCP 提交现已随 `e340961` 进入 `origin/main`。Storyforge 配对提交仍只在本地。

- `8af5dfb` — fix(bridge)，W022/W023：默认入口少一级目录及 status 泄漏 indexRevision 两处最小修复；真实 CLI 默认/显式 × 两种 cwd、EOF/退出/锁释放与 strict HTTP status，三个失败→通过；相关 38 项、check/lint 通过，已推送。
- `d55fb55` — docs(mr4)：收口四项功能与完整/私有/gold/双平台门禁，保留完整引文露出与外部 tokenizer 的独立口径，继续 MR5，已推送。
- `ef21164` — fix(context)，W018：context/timeline 共用 1-based source-order 章节位置，工具描述/契约对齐；3 项先失败后通过，相关 32 项、stdio/协议 7 项及 check/lint 通过。MR4 完整 verify 57/396、30/30、lines 93.02%、branches 80.02%，双平台 CI `38929508530`、私有 top-20 42/42 required 16/16、gold:gate/check 通过，已推送。
- `bd592b6` — fix(search)，W006：评分大小写一致，窗口直接取原文 Unicode 不区分大小写匹配位置，避免 lowercased 偏移变长；3 项先失败后通过，相关 39 项及 check/lint 通过，已推送。
- `f70f29d` — fix(context)，W003/W004：预算不可满足时保留各类遗漏原因，显式 required/pin 恢复后不再同时报告 duplicate；三项有效失败→通过回归、相关 24 项、check/lint 通过，已推送。首轮测试并发直调造成的临时句柄干扰不计入产品失败证据，已改顺序调用后确认真实断言失败。
- `9e1742c` — docs(mr3)：收口七项功能与本机/双平台完整 verify、私有/gold 门禁，继续 MR4，保留九类未完成及 Draft 不合并边界，已推送。
- `5a117d5` — fix(graph)，W009：按所有旧 alias/定义收集 owner 依赖，统一规范化回扫已解析/未解析引用；新增四项先失败后通过，相关 61 项及 check/lint 通过。MR3 完整 verify 57/387、30/30、lines 93.02%、branches 80.00%，双平台 CI `38927243154` 完整通过，私有 top-20 42/42、required 16/16、gold:gate/check 通过，已推送。
- `7682cc7` — fix(search)，W008/021/015/024：实体级聚合后计算 LIMIT 前 owner 数，修复假歧义/漏歧义、命名/稳定 seed 评分和 LIKE 字面反斜杠；新增 10 项（5 失败+5 控制），相关 39 项及 check/lint 通过，已推送。
- `043172e` — fix(graph)，W005：实体/原生及未解析引用共用 NFC+trim+lowercase，保留兼容字符独立身份和原文证据；3 项先失败后通过，相关 29 项、check/lint 通过，已推送。
- `8330a78` — fix(graph)，W013：冻结当前 Chapter 标题派生别名政策，保留非 Chapter 持久化别名；改名/缩短/恢复、身份、原生引用、noop/重开/冷建回归先失败后通过，相关 35 项及 check/lint 通过，已推送。
- `95ad62c` — docs(mr2)：记录六项修复的阶段验收及用户接受的正确分片重校准；保留初始 gold:check 差异、单变量对照和旧快照追溯，进入 MR3，已推送。
- `8595bee` — fix(epub)，W011/016/020：单层正文实体、属性 br 换行及引号内 > 保真，新增 24 项；本机完整 verify 57/369、30/30、lines 92.84%、branches 79.77%，双平台 CI `38924539472` 完整通过。私有 top-20 42/42、required 16/16；原 gold:check 差异由仅关闭 W001 的临时副本对照精确复现旧快照，用户接受按正确分片重校准。gold:update 绑定本提交，后续 gold:gate/check 与私有硬门禁通过，未修改标注/排序/硬阈值。
- `23be2c6` — fix(txt)，W010：前言去空白时同步原始行偏移，新增 12 项 LF/CRLF/BOM/嵌套路径回读回归；相关 35 项、check/lint 及双平台 CI `38923192385` 完整通过，已推送。
- `0f246b0` — fix(text)，W002：共享 UTF-16 边界切片贯通分片、SQLite、直接/搜索/BFS/context 证据与 EPUB 标题，派生版本更新；新增 10 项（9 项先失败、BMP 对照通过），相关 55 项及 check/lint、双平台 CI `38922858471` 完整通过，已推送。
- `38ab81d` — fix(text)，W001：多行追加前计入 LF，派生版本加入 semantic fingerprint；新增 7 项边界/旧指纹增量升级回归，相关 39 项及 check/lint 通过；已推送，双平台 CI `38921958856` 完整通过。
- `7ba7a79` — docs(status)：保存 MR1 本机结果及当时的推送/Windows CI 阻塞；随后补推成功，双平台 CI `38919516032` 均完整通过，57/316、30/30、lines 92.77%、branches 79.02%。旧阻塞已解除，原始失败回执不覆盖。
- `0ff98c7` — test(adapter)：修正 Windows CI 的 TEMP 8.3/realpath 误比较，保留单次读取/累计超限行为断言；完整本机 verify 57/316、30/30、lines 92.77%、branches 79.02%；已推送并通过双平台 CI。
- `806d942` — fix(core)，W-MCP-007：受管理旧连接在替换前释放，同一热服务及独立磁盘新旧正文一致，incremental/rebuild 失败保留旧 revision、stale 与恢复；已推送。Linux CI 完整通过；Windows MR1 回归通过，整套被上述既有路径断言阻断。
- `a13e659` — fix(epub)，W-MCP-014：匹配属性引号、单层 XML 实体→URL/安全路径，必需 spine 缺声明/资源明确拒绝；新增 21 项及 M0 amendment；已推送。
- `5890d83` — fix(graph)，W-MCP-012：引用刷新只清理 mentions/appears_in 及其证据，保留 precedes；新增五类资料修改/无引用、noop/重开/冷建/证据持久化回归；已推送。

- `5f5cd58` — fix(gates): Vitest worker 并发上限固定为 4；在常驻多组 IDE/MCP 服务、低剩余虚拟内存的 Windows 环境中，消除全量门禁的 `VirtualAlloc` worker 退出；生产逻辑与断言均未改变，57 文件/287 项复验通过。
- `d87f8b4` — fix(gates): `pnpm coverage` 先构建再运行覆盖率，消除 child-process 集成测试对残留 `dist` 的隐式依赖；独立 coverage 复验 57 文件/287 项、lines 92.68%、branches 78.35%、MCP server branches 60.75%。
- `5e6f6c1` — chore(gates): 移除 `store.ts` lint 豁免并修净两条 iterator warning；全局 branch 门槛 73→75，新增 MCP server branch ≥60% 文件门槛（实测 60.75%），未为覆盖率改写生产结构；57 文件/287 项、30/30、branches 78.35%。
- `c31df5d` — fix(core): document 查询将 `%`、`_`、`\\` 按字面子串处理并显式使用 SQL `ESCAPE`；新增路径/标题定向回归；57 文件/287 项、30/30、branches 78.35%。
- `72bc343` — fix(core): SQLite/FTS 冷启动增加 WAL 有界 busy 重试与 `BEGIN IMMEDIATE` 后 `user_version` 双检；12 独立进程屏障回归连续通过；56 文件/286 项、30/30、branches 78.35%。
- `c3d6e82` — fix(adapter): Generic TXT/Markdown 根据已验证 SourceSnapshot 在 `readFile` 前执行单文件与累计大小门禁，并保留读取后二次竞态防线；55 文件/285 项、30/30、branches 78.72%。
- `e57264c` — fix(core): 30 秒查询 deadline 移入逐作品队列并覆盖 explore/context/evaluator；超时不提前释放串行槽，service close 等待底层尾任务；54 文件/283 项、30/30、branches 78.75%。
- `655ae8e`（Storyforge，本地）+ `80ac885`（Writing MCP，已推送）— HB-M6 真实宿主验收收口：浏览器快照经 Bridge 激活并把 Writing MCP 证据注入 provider，Bridge 停止后失败关闭且只允许显式单次绕过，候选不自动写回；Bridge 在派生数据维护期间可恢复地重启 MCP 子进程，并递归脱敏本地路径。Writing MCP `pnpm verify` 54 文件/278 项、公共基准 30/30、coverage lines 92.92%；Storyforge `npm run ci` 266 文件/1002 项、生产依赖审计 0 漏洞，Playwright 35/35。
- `1c1f0c1`（Storyforge，本地）+ `e53d4d8`（Writing MCP，已推送）— HB-M5 联合启动收口：`npm run dev` 同启 Storyforge 与 Bridge，终端提供 pairing code；Bridge 接受严格 loopback Origin 参数并在冷启动静态注册 Storyforge 插件。
- `0aa1ca4` — fix(writing-bridge): HB-M4 复审收口——当前快照先激活再查询、MCP 工具信封 typed 解包、真实 excerpt/locator/path 注入、快照覆盖来源 replace 与用户消息保护、budget_unsatisfiable 阻断、生产/禁用态零 localhost client；Storyforge 6 文件/30 项 Bridge 测试、eslint、tsc、生产 build 全绿。Writing MCP 无代码变化。本地提交，未推送。
- `eca7b3e` — feat(writing-bridge): HB-M4 章节调用前注入 MCP 证据的首个纵向切片；复审发现其未激活快照、未解包工具信封且按错误字段读取 ContextBlock，故完成声明由后续 `0aa1ca4` 才闭合。本地提交，未推送。
- `27d29b3` — feat(bridge): HB-M3 五工具代理——Bearer 门禁的 resolve/index/explore/context/diagnose 路由（BRIDGE_TOOL_REQUEST_INVALID 第 14 个冻结错误码、bridge-owned workRef 与 WORK_REF_NOT_FOUND 单次重解析、15/120 秒冻结超时、diagnose 强制 metadata 并剥离绝对路径、真实 MCP stdio 五工具 fixture 链）；3 项先失败测试；pnpm verify 52 文件/271 测试。与 Storyforge `959872d` 配对（HB-M3）。本地提交，未推送。
- `229afea` — fix(bridge): HB-M3 前可靠性修复——MCP stderr 溢出后保留最新完整尾部；快照流程的 `writing_index` status/incremental/rebuild 全部显式使用冻结的 120 秒超时；2 项 red-first 回归；`pnpm verify` 51 文件/268 测试、30/30 基准、coverage lines 91.61%。本地提交，未推送。
- `1f70da6` — feat(bridge): HB-M2 快照事务——插件注册表（manifest 校验/状态持久化于全局 plugin-state.json）、每项目互斥的激活事务（重算哈希、16/64 MiB 与 4096 限额、两阶段替换 EBUSY 有界重试、resolve→index 分支、binding manifest 原子最后写、同快照 no-op、失败回滚、恢复失败 degraded、重启 stale 候选）、Bearer 门禁 status/snapshot/derived-data 路由（72 MiB 预拒+流式计数、DERIVED_DATA_BUSY）；18 项先失败测试；pnpm verify 51 文件/266 测试。与 Storyforge `330d980` 配对（HB-M2）。本地提交，未推送。
- `2148329` — feat(bridge): HB-M1 安全 loopback companion——`@writing-mcp/host-bridge`（pairing code 单次/轮换/TTL、tab-local Bearer 仅哈希存储、四态投影、死 pid+内容一致才清理的单实例锁、有界 stderr 的 MCP stdio JSON-RPC 客户端、loopback→Host→Origin→Bearer 顺序 + PNA 预检 + 413 限流的 HTTP 边界、stderr-only 配对码 CLI 与三信号幂等关机）；28 项先失败测试；`pnpm verify` 全链：48 文件/248 测试、coverage Stmts 89.09/Branch 79.76/Funcs 88.1/Lines 92.9 过阈值。业务工具代理路由留待 HB-M3。本地提交，未推送。
- `9048b21` — feat(bridge): HB-M0 协议冻结——`@writing-mcp/host-bridge-protocol`（strict Zod 协议 v1、四状态模型、13 冻结错误码、限额/超时/配对常量、鉴权矩阵数据、确定性 projectKey/snapshotHash/contentHash 纯函数）+ `@writing-mcp/host-plugin-storyforge`（七字段 manifest schema）+ 实现无关 fixture 生成器与 4 份规范 fixture；新增 17 项先失败测试（45 文件/220 项）；check 0 错 / lint 0 警告 / 基准 30/30 / coverage lines 90.69%；`docs/host-bridge/` 本地治理文档不入库（用户 2026-08-31 规则）。本地提交，未推送。
- `09442fa` — chore(privacy): 收尾——将 history 隐私门禁接入 `pnpm verify` 链首、登记 tests/README 回归映射，并把检查点从“本地完成”校正为“已强推 origin 并全新 clone 复验 PASS”。
- `cac1bc1` — fix(scripts): privacy-gate 仓库根解析——调用 cwd 优先，cwd 非 git 树时回退脚本自身位置，支持对任意 clone 直接执行（oxlint 0/0；5/5；全新 clone history PASS）。
- `60d1952` — chore(privacy): 历史重写后用 commit-map 重映射 98 处提交引用（状态文档 97 + 黄金基线 gitCommit 1，0 歧义）；privacy-gate history scope 收窄为本地 heads/tags，排除 refs/remotes 过期缓存；+1 回归测试。
- `5384ec0` — chore(repo): tracked 文档脱敏私有语料引用，新增公开前 privacy-gate 脚本与 4 项回归测试；配合仓库历史整体重写（全部提交 ID 变更）。
- `75a537b` — perf(search): 短原词使用 `64..256` 有界 LIKE 补池且不覆盖 FTS/BM25 行；新增按 revision/query/limit/PRF 配置隔离的 128 项生产暖缓存，evaluator-only 路径绕过，成功索引与 close 失效；196/196、私有 required 16/16、黄金无回退、4.79M 字符完整门禁通过。
- `905f05a` — feat(gates): corpus 报告公开匿名逐样本耗时，使 P95 计算可复核而不泄露查询文本。
- `1a994b6` — fix(gates): corpus P95 改为每任务预热一次、测量三次并对全部样本使用 nearest-rank 统计。
- `dd067cf` — fix(gates): corpus 门禁改为测量契约声明的暖查询路径，不再混入首次查询成本。
- `211875f` — docs(status): 修复 Task 6 后状态、契约与测试清单的最终漂移。
- `497f4ad` — docs(status): 归档 Task 6 PRF 生产配置、私有召回和长语料门禁结果。
- `2504762` — fix(gates): 外部受控黄金快照可在 dirty 开发树中测试，但默认仓库快照仍要求 clean HEAD；测量期间 HEAD/工作树必须保持完全不变，使提交前 `pnpm verify` 可执行。
- `686a0e5` — feat(search): Task 6 恢复双字 PRF，预 IDF 池 128、三字 FTS vocabulary 批量频率、其他长度保守频率；冻结 `12/8/0.35`，Context 内部池 12；私有 41/42、required 16/16，4.79M 字符性能门禁通过。
- `fa37135` — test(gates): corpus 默认报告路径测试不再继承私有报告目录环境变量，保证门禁隔离可复现。
- `0f7522c` — perf(search): 初始 PRF 大语料有界化（候选/缓存/Context 池）；其 32 候选与三字限定后被 `686a0e5` 的质量/性能闭环替代。
- `cf9a276` — feat(search): evaluator-only 两遍 PRF 初版与生产路径接线；后续由大语料门禁加固。
- `c5ea955` — docs(contract): 冻结确定性 PRF 的 Agent/MCP 边界、参数网格、数据泄漏边界和验收门禁。
- `61bc056` — fix(lifecycle): Task 5C 将 runtime shutdown 与 SIGINT/SIGTERM/stdin EOF 收敛到各自唯一的 memoized promise；关闭顺序固定 server→service，失败在两次尝试后汇总，正常关闭清除兜底并自然退出，5 秒悬挂才强退；184/184 + 30/30 + lint 0 + coverage lines 94.72%。
- `d670b2e` — feat(diagnostics): Task 5B 增加按目录串行的摊销扫描、稳定清理顺序、可恢复合作锁、active/当前 artifact 保护与完整写入计数；100 MiB 明确为最终收敛目标；179/179 + 30/30 + lint 0 + coverage lines 94.95%。
- `f15f6d2` — fix(epub): Task 5A 将 OPF、单个 spine 与累计 spine 限制统一为解码 UTF-8 bytes，并以中文多字节精确边界回归锁定。
- `4f2cef3` — feat(context): Task 3 将必填 `accountingScope: evidence_excerpts_only` 写入所有 ContextPacket 路径（含 budget_unsatisfiable）、core/MCP output schema 与 writing_context 描述；明确 usedTokens 仅计 returned evidence excerpts 的 mixed-cjk-v1 估算、供外部 tokenizer 复核而非精确 token 声称；146/146 + 30/30 + lint 0 + coverage lines 93.01%。
- `6c11c1e` — feat(graph): Task 3 将 schema-v4 已有 `mentions` 纳入冻结 EdgeKind/EDGE_KINDS；`[[alias]]` 经持久化别名解析为 Document→Entity，双端 BFS 返回相同边的 incoming/outgoing 证据；稳定 documentRef/entityRef 可作为 neighborhood 种子；146/146 门禁验证见后续上下文契约提交。
- `b9088f9` — feat(eval): §266 形式达标——`WRITING_MCP_ABLATE` 运行时开关（store.ts，默认行为不变）+ ablation-test.mjs 重写（gold-span 口径，bm25 项/FTS 合并分离）+ gate-gold-evidence.mjs 门禁 4/4 PASS + `reports/gold-evidence-baseline.json` 快照提交（.gitignore 白名单）。ablation 实证：coverage/alias KEEP，proximity/heading/trust REMOVABLE，bm25 项与 FTS 合并为负因子（删后 MRR↑）——公式层非杠杆，与归因结论互证；127/127 + 30/30 绿。
- `c1de724` — fix(eval): P1 卷感知 holdout 切分（chaptersOf 带 volume、territories 从语料章题现算、容忍卷内章序异常与双 span heading）+ P3 miss 探针 rankAt100 + attribute-misses.mjs 三层归因工具（L1 词条可达/L2 候选可达/L3 因子分解）；切分恢复 18/24，归因结论：miss 全部纯排序因子问题（coverage 缺口）。
- `30f1e40` — refactor(eval): 评测仪表按用户拍板的 gold-span 口径重写（scripts/gold-hit.mjs 命中口径唯一宿主 + evaluate-reranking.mjs 真截断 recall@k/自检/异常分桶 + run-private-acceptance.mjs 改用共享模块行为等价；train recall@50=100% 够用门禁过、holdout @50=100%、acceptance 结果与历史金标准一致；127/127 + 30/30 绿）。
- `6b9957b` — revert(m4): 完整重排验证作废——回退 6 因子排序基线（用户审查 R1-R5 证实 f9bf134b验证无效：评测仪表缺陷 recall@k 忽略 k/词共现弱代理/章节 TODO、holdout 未验证、黄金证据门禁与 baseline.json 未落地；store.ts 公式恢复 6 因子、两个排序测试还原、状态与契约降级为作废；127/127 测试 + 30/30 基准全绿；评测脚本保留待重写）。
- `7d15486` — fix(f1+f2+f3): 消除指纹双算竞态、降级契约断言、补全文档摘要（待审阅；F1 指纹计算移入 indexUnlocked 消除双算竞态窗口，F2 M0_CONTRACT 措辞降级为 best-effort 并补充已知边缘案例，F3 M4 行摘要补录 status 快速路径 + diagnose 摘要；回归测试更新反映 M4 完整重排行为变化：trustBonus/headingMatches 已移除；127/127 测试通过，30/30 基准通过）。
- `a29ec45` — feat(m4): 完整重排落地——因子 ablation 优化排序公式（**【验证作废·已回退，见 2026-08-19 回退提交】** 评测集《语料A》42 facts，基线 Recall@5=83.33%/MRR=0.4247；ablation 测试 6 因子，决策保留 3 因子 coverage×4/aliasBoost/proximity，移除 3 因子 headingMatches/bm25/trustBonus；优化后 MRR=0.4493（+5.79%），Recall 不变；30/30 基准无冲突；新增 evaluate-reranking.mjs + ablation-test.mjs；契约补 M4 complete re-ranking amendment；.gitignore 保护私有数据。作废原因：评测仪表缺陷 + holdout 未验证 + 门禁未落地）。
- `0e3dd46` — docs: AUD-014 tokenizer 决策延后（保持 mixed-cjk-v1 启发式，理由见 IDEAS 文件 AUD-014 Tokenizer 决策记录）。
- `5c6f1ea` — docs: AUD-012 审阅修复二归档（契约 review clarification + Open TODO 更新 + 已知限制补充 + 提交清单补 18712147c4efef2d。
- `d321727` — fix(m4): AUD-012 审阅修复二（C4 contextSourceCounts ORDER BY kind 显式确定 / C5 byFill pinned 提升优先于锚定近距 / C6 pinned 边界文档化；新增 C5 回归测试；tsc 0 + lint 0 + node 验证脚本 6/6；vitest 与 benchmark 待用户环境）。
- `54b5cfb` — chore: 删除 b360ff78误提交的 `.commit-msg-tmp.txt` 临时文件。
- `67ae077` — feat(m4): AUD-012 残留「来源目录」可观测能力完成（writing_explore stats 操作新增 contextSources 字段：byLayer L1/L2/L3 + byKind 按文档种类计数；复用 AUD-013 注册表与归一逻辑；新增 source-directory-observable.test.ts；123/123 + 30/30 + lint 0；契约补 M4 source directory observable amendment）。
- `a464641` — fix(m4): AUD-012 接线审阅三缺陷修复（待审阅；描述优先级矛盾/budget_unsatisfiable 真实 omitted 原因/tests-README 漂移；另修接线测试偶发——ch3 夹具标题补查询词打破同分；契约补两条；122/122 + 30/30 + lint 0 + coverage 92.91%）。
- `2644920` — docs(status): AUD-012 接线完成归档 + AUD-013 审阅通过 + 验证记录。
- `732df85` — feat(m4): AUD-012 约束接口接线完成（excludeRefs/entityRefs/documentRefs/targetChapter 接线、taskType 值域开放且非驱动；移除被否决的 taskType 策略引擎；修复 WIP 的 db.close 共享句柄 bug 与 excluded 伪造 block hack；新增 context-constraint-wiring.test.ts 6 项 + 更新 context-reserved-params.test.ts；tsc 0 错 / lint 0 警告 / benchmark 30/30 / store 级接线脚本 16/16；契约新增 M4 constraint-interface wiring amendment）。
- `a13907c` — docs(contract): AUD-012 方向修订——taskType 不再驱动确定性来源策略，MCP 完善 Agent 自主上下文组装的约束接口（对齐 Reference §5.5 否决的智能路由）。
- `5aacdb0` — fix(m4): AUD-013 文档类型大小写归一（DOCUMENT_KIND_ALIASES：character→Character 等；修复 searchRows 小写 d.kind 全落 L3 缺陷，补真实路径 L1/L2 断言）。
- `d7f8c24` — feat(m4): AUD-013 来源提供器注册表 + evidenceHash 去重（待审阅；分层改来源类型映射、required 晋升 L0、duplicate_evidence 折叠、预算填充 L0→L3；新增 context-assembly.ts 纯模块与 6 项回归；114/114 + 30/30 + lint 0 + coverage 92.88%；同提交含状态文档已审阅叙事精简）。
- `9ed9594` — docs(m4): 采纳 REVIEW_2026-08-17 方向（M4 行按审议顺序重排：AUD-013 来源语义化+去重 → AUD-012 残留接线 → AUD-014 tokenizer；含 M4 审议下一步记录）。
- `0def9a7` — chore: 移除已迁至工作区级 .agents/ 的两个 SKILL.md（仓库内不再保留技能副本）。
- `8f93fef` — docs(review): M4 能力与边界第四次审阅（REVIEW_2026-08-17，本地化文档）。
- `086f46b` — feat(scripts): 语料加载与性能基准测试脚本（load-corpus.mjs + run-corpus-benchmark.mjs；491 万字语料首测：索引 25.7s、Explore P95 673ms、Context P95 382.5ms、Token 降幅 99.92%）。
- `1aa4e05` — docs: 批次 C 审阅归档（AUD-028～032 + AUD-035-1/2 共六条已审阅通过）。
- `0f79482` — chore: 收窄 .gitignore（reports/ 全忽略、docs/REVIEW*.md 与 docs/PRIVATE*.md 本地化；三个原跟踪文档移出索引）。
- `6369da2` — docs(m1): AUD-035 第三阶段 Biome 格式化延后至 M3/M4 重构窗口。
- `e3088af` — refactor(m1): AUD-035 第二阶段 generic 适配器策略模块抽离（index.ts 拆为 errors/numbering/txt/epub 四模块 + 编排入口，公共 API 经再导出兼容；覆盖率逐位不变证明纯结构重构；108/108 + 30/30 + lint 0 警告）。
- `c2093cd` — chore(m1): AUD-035 第一阶段 lint/coverage 门禁（oxlint 修到 0 警告 + @vitest/coverage-v8 棘轮阈值，vitest 别名改指 src 修复覆盖率失真；108/108 + 30/30）。
- `a3877c3` — feat(m1): AUD-032 进程生命周期与优雅关闭（`createStdioRuntime` + 统一 terminate 链 + 5 秒 grace guard，SIGINT/SIGTERM/stdin EOF 确定性退出，stdout 纯 JSON-RPC；5 项回归；108/108 + 30/30）。
- `2c89a2e` — feat(m1): AUD-030 span 硬上限、locator 精确与连续平铺边界规则（超长单行硬切为共享同一源行的有界 chunk、locator 排除被裁空行、无重叠无遗漏；重叠方案实测拒绝；5 项回归；103/103 + 30/30）。
- `b1da1f0` — feat(m1): AUD-029 snapshot 一致性与文本内存上限（loadConsistent 读前后指纹校验 + 有界重试，`SOURCE_CHANGED_DURING_READ`；文本单文件/总量上限；5 项回归；98/98 + 30/30）。
- `e150b88` — feat(m1): AUD-028 EPUB 资源上限（entry 数/单文档/总解码量三级确定性上限，防 ZIP bomb；含上轮半成品 L102 语法错误修复；4 项回归；93/93 + 30/30）。
- `55b5543` — feat(m1): AUD-027 章节编号语法明确化（阿拉伯/中文至九百九十九/规范罗马三语法冻结、非法编号确定性跳过、卷重置一致；5 项回归；89/89 + 30/30）。
- `2a02a89` — feat(m1): AUD-026 通用作品边界与 capabilities 实际化（逐 EPUB 独立候选、多书目录 ambiguous、无 epub 能力不加载 EPUB；4 项回归；84/84 + 30/30）。
- `35f7cb2` — docs(status): 补齐 AUD-005～025 检查点的可追溯提交清单。
- `9cd19d4` — feat(m0.1): AUD-025 协议层错误边界（输出 data schema 单一真相源 + wrapper 自校验 `OUTPUT_SCHEMA_MISMATCH` + 可注入 onerror→stderr；M0_CONTRACT protocol error boundary amendment；5 项回归；80/80 + 30/30）。
- `05d296d` — feat(m0.1): AUD-024 general JSONL 串行轮转与追加（并发不丢不乱、写失败降级；3 项回归；75/75 + 30/30）。
- `5d62d87` — feat(m0.1): AUD-023 开发捕获有界 outputHits（ref/score/locator 哈希，各列上限 100；1 项回归；72/72 + 30/30）。
- `5597936` — feat(m3): AUD-012 残留 search source-trust 排序因子（deterministic 命中 +0.25；1 项翻转回归；71/71 + 30/30）。
- `9107d56` — docs(contract): 将 AUD-012 残留（taskType/目标/排除引用）钉为 M4 显式 Open TODO。
- `77f1e9a` — feat(m3): AUD-012 M3 范围（timeline 章节时态过滤 + context reserved 输入）。
- `854fa5d` — feat(m3): AUD-022 确定性图/能力词汇表冻结（ENTITY_KINDS/EDGE_KINDS/WORK_CAPABILITIES）。
- `0808a1a` — feat(m3): AUD-015 timeline 独立确定性投影（时态实体 + precedes 边）。
- `6cf93ee` — perf(m3): AUD-020 BFS 逐层批量边查询与 locator 批量加载。
- `57d9b08` — fix(m4): AUD-005 requiredRefs 脱离 search 候选池直接解析。
- `f1bc326` — fix(m3): AUD-021 源指纹修复（`service.index()` 记录指纹；修复 `ensureFresh` 在 `previous === undefined` 时跳过增量更新的缺陷；55/55 测试通过）。
- `2f5950f` — fix(m3): AUD-018 响应字节上限（200KB 确定性截断 + `RESPONSE_TRUNCATED`）。
- `45f45cb` — fix(m3): AUD-021 源指纹复用 + AUD-018 时间上限（初版，含 `tests/service-reuse.test.ts`）。
- `aa84645` — fix(m3): 检索正确性（中文问句分析、歧义/未解析输出、稳定排序、输入边界、FTS 降级诊断）。
- `8d5b7b5` — fix(m2): schema v4（图身份/顺序、规范定义晋升、多 mention/关系证据、跨 spine locator）。
- `8f644e0` — fix(m2): schema v3（语义快照、真实 freshness、作品级串行、跨进程锁、崩溃恢复、`.gitignore` 保留）。
- `9c25e91` — fix(inkos): 角色别名去重与绑定书籍解析。
- `1e6e823` — fix(m1): EPUB 章节切分修复与验证。
- `e079e86` — docs(review): AUD-001~036 证据分级、门禁校准与修复顺序。

后续每次达到提交点（bug 修复 / 子门禁完成 / 计划调整）时，在本清单顶部追加一条，保持单一宿主。
