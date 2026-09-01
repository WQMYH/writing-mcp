# Writing MCP MVP 实施状态

> **本文档是 Writing MCP 实施状态的唯一事实源。** v2 计划、README、REVIEW 文档均只引用本文件，不维护状态副本；任何"当前做到哪、多少测试、哪些 AUD 已关闭"的判断以本文为准。发现其他文件记载状态时，以本文为准并修正该文件。
>
> 检查点时间：2026-09-01（HB-M0～HB-M6 的 Storyforge 首宿主链已交付；Writing MCP v1 的 M5 仍有独立客户端与格式覆盖门禁）
> 当前状态：可靠性 Task 1～7、确定性两遍 PRF、公开前隐私门禁和 Storyforge 首宿主 HB-M0～HB-M6 均已完成。Host Bridge 配对检查点为 Writing MCP `80ac885` 与 Storyforge `655ae8e`：联合启动、静态插件注册、快照激活、五工具代理、章节证据注入、失败关闭、显式单次绕过、零自动写回、维护期 MCP 子进程可恢复重启及递归路径脱敏均有可执行回归。最新公共门禁为 Writing MCP 54 文件/278 项、公共基准 30/30、coverage lines 92.92%；Storyforge 266 文件/1002 项、生产依赖审计 0 漏洞、Playwright 35/35。外部 tokenizer 仍为 `not_evaluated`；Writing MCP v1 的 M5 仍缺真实 InkOS、更多 EPUB 2/3 变体和独立客户端安装/连通性验收。上述 HB 提交均只在本地，未推送；push 仍需用户明确授权。
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

| 里程碑 | 状态 | 已完成 | 未完成门禁 |
|---|---|---|---|
| M0 | 主体完成 | 版本化协议/存储合同、五工具 schema、统一信封、最小 fixture、30 个任务、Token/事实基线 | 指标含义和实现契约继续校准 |
| M0.1 | ✅ 完成 | 全工具诊断 wrapper、显式 capture、脱敏与报告哈希、开发捕获有界命中 ref（AUD-023 主体）、general JSONL 串行轮转与并发/写失败护栏（AUD-024 主体）、协议层错误边界（AUD-025 主体） | — |
| M1 | 补强中 | 授权 roots、realpath/链接防护、InkOS、Markdown/TXT/EPUB、跨 spine 分段 locator、通用作品边界与 capabilities 实际化（AUD-026 主体）、章节编号语法明确化（AUD-027 主体）、EPUB 资源上限（AUD-028 主体）、snapshot 一致性与文本内存上限（AUD-029 主体）、span 硬上限与 locator 精确规则（AUD-030 主体）、进程生命周期与优雅关闭（AUD-032 主体）、工程硬化门禁与适配器模块抽离（AUD-035 第一/二阶段主体） | AUD-035 格式化阶段（用户决策延后至 M3/M4 语义冻结后的重构窗口再评估） |
| M2 | ✅ 基础门禁完成 | SQLite/FTS5、schema v4、语义 snapshot、truthful status、revision/事务、原子替换、作品级串行/写锁、恢复、work/document 作用域身份、规范定义晋升、多 mention/关系证据、源顺序图 | 后续只随 M3/M4 查询语义做受控增强 |
| M3 | 主体完成 | search/entity/neighborhood/document/stats、中文问句分析、别名/歧义/未解析输出、稳定排序、输入上限、0～3 跳 BFS、timeline、词汇表、source-trust、A1 freshness、确定性两遍 PRF 与 revision-scoped 有界暖缓存；真实长语料性能门禁通过 | 后续仅做受控检索质量增强与重构，不再以未验证的“完整重排”作为完成声明 |
| M4 | 进行中（已有纵向切片） | ContextPacket、预算上限、抽取式选择、AUD-005/AUD-012/AUD-013 的约束与来源装配；`accountingScope: evidence_excerpts_only` 已冻结；Context 内部池 12 且真实长语料 P95 通过；A1、server 响应字节、EPUB/诊断/lifecycle 均完成 | 外部 tokenizer 复核尚未完成；token-evaluation-materials 只提供复核材料，不给出精确 Token 结论 |
| M5 | 进行中（Storyforge 首宿主链已闭环） | stdio、五工具注册、structuredContent、outputSchema、统一结果/错误/诊断信封、协议测试、单个真实转换型 EPUB 回归；`CLIENT_SETUP.md` 覆盖 Node 24、pnpm/build、Qoder/Codex stdio 配置、首次调用路由、七类故障、诊断隐私与 v1 边界；Storyforge Host Bridge HB-M0～HB-M6 已完成（最终配对提交：Writing MCP `80ac885` + Storyforge `655ae8e`），真实浏览器链验证证据注入、失败关闭、显式单次绕过与零自动写回 | 真实 InkOS、更多 EPUB 2/3 变体、独立 MCP 客户端安装/连通性验收；外部 tokenizer 结论仍属 M4 独立门禁 |

Step 1 已关闭 AUD-003、006、011、031；Step 2 已关闭 AUD-001、002、007～010 的当前门禁；Step 3 已完成中文问句、别名/歧义、稳定排序、输入上限、FTS 降级与检索诊断（提交 `aa84645`），并完成 AUD-018 时间上限（提交 `45f45cb`）；AUD-021 源指纹复用修复（`service.index()` 增加指纹记录，修复 `ensureFresh` 在 `previous === undefined` 时跳过增量更新的逻辑缺陷，55/55 测试全部通过）。AUD-005（REVIEW_2026-08-16 P0，提前于 Step 3 剩余项处理）：`requiredRefs` 脱离 search top-50 候选池按 entity/span/document 三级直接解析，池外必选 ref 进 blocks 并计入预算最小值，不存在 ref 以 `not_found` 进 omitted，预算不足触发 `budget_unsatisfiable`；`ContextPacket` 形状与状态词汇未变（M0_CONTRACT 新增 M4 requiredRefs amendment）。M0.1、M1 其余问题和 M3～M5 尚未完成，现有成果不能据此宣称 Writing MCP v1 已完成。

## 当前测试覆盖

> 详细清单（测试文件 → 主题映射、按能力域的覆盖条目）见 [`tests/README.md`](../tests/README.md)。本段只保留概述，细节以测试清单为准。

- 54 个测试文件 / 278 项测试，覆盖：通用链路、MCP 协议与诊断、M5 客户端文档契约、HB-M0 host-bridge 协议与 Storyforge manifest 冻结、HB-M1 配对/令牌/安全边界/单实例锁/MCP stdio 客户端/CLI 生命周期、HB-M2 快照事务/binding/派生数据删除与 Storyforge 确定性导出、HB-M3 五工具代理路由/工作引用恢复/脱敏诊断与 Storyforge 薄客户端/Settings 开发面/协议 fixture 门禁、HB-M5 联合启动、HB-M6 MCP 子进程维护期重启/递归路径脱敏/真实 Bridge 链、诊断 retention/协作锁、server/core 响应字节上限与 recorder ordering、统一进程关闭链、检索正确性、短原词候选保留、revision-scoped 暖查询复用与索引失效、A1 SourceSnapshot/fingerprint、A2 evaluator/gold/private/corpus 只读门禁、两遍 PRF/双字候选/批量频率上限、公开前隐私门禁、上下文装配、BFS、timeline、图词汇、基准、TXT/EPUB/InkOS、路径安全和索引生命周期。
- 关键门禁：30/30 公共基准；无分词中文问句命中；重复 Chapter 身份独立；源变化 status 转 stale；未变化源零重载；删除索引可完整重建。

## 已知限制

- `timeline` 已实现为携带时态属性实体与 precedes 时序边的确定性投影，支持 targetChapter 章节时态过滤（AUD-012 M3 范围）。
- context 的 `targetChapter`/`entityRefs`/`documentRefs`/`excludeRefs` 已接线（AUD-012，`732df85`）：targetChapter 锚定层内排序、entityRefs/documentRefs 直解入 blocks、excludeRefs 过滤；`taskType` 仍为保留 hint——值域开放（未知值接受并记录）、**永不影响装配**（2026-08-17 方向：无 taskType 策略引擎）。
- 角色实体提取只覆盖角色类文档 heading；原生 `[[alias]]` 会查询持久化 aliases，唯一 owner 才形成 `mentions`，多 owner 保持 `AMBIGUOUS_ALIAS` 未解析；查询期另提供透明的中文称呼形态扩展。
- EPUB 仍采用确定性轻量解析，尚未覆盖 DRM/加密、复杂命名空间、导航目录语义、脚注回链、图片内容和全部 EPUB 2/3 变体；内部章节切分目前依赖独占行的中英文编号标题。
- `workRef` 只在当前 server 进程中注册；重启后客户端需重新调用 `writing_resolve`。
- schema v4 writer lock 是 Writing MCP 进程间的合作式协议，不能强制无关程序释放 SQLite 句柄；此类占用稳定返回 `INDEX_BUSY`。
- A1 SourceSnapshot/fingerprint 已完成并回归覆盖：未变化时复用 store，来源变化即通过 adapter snapshot 触发一致性重读/索引；保留同 mtime/size 原地替换的明确边界，不再标记为待审阅或待落地。
- 私有 top-20 当前为 41/42，required 16/16；唯一未命中为 optional `event-004`（probe-100 rank 22）。该产品门禁与 gold @50 候选门禁继续分开报告。
- 中文问句分析当前是有界规则与 n-gram，不是通用分词器；问题短语表会继续通过真实调用链回归校准。
- `stats` 的 content 受 900 字符 excerpt 截断（既有模式，`item()` 切片）；`contextSources` 增大了 stats JSON，现实 kind 数下安全，但 stats 内容截断属潜在坑。
- `entityRefs`/`documentRefs` 的 pinned 块不参与 evidenceHash 去重（显式请求豁免，与 requiredRefs 一致）；已是搜索命中的 pinned ref 保持搜索命中排名，不再获得 pinned 提升。

## 下一步

- Host Bridge：Storyforge 首宿主 HB-M0～HB-M6 已关闭；维持静态单宿主、loopback、显式配对、失败关闭和零自动写回边界，不在本轮扩成动态插件市场。下一步先把真实使用反馈转成协议兼容性回归，再决定第二宿主或可配置端口等扩展。
- M5 收尾：补真实 InkOS、更多 EPUB 2/3 变体及独立 MCP 客户端安装/连通性验收；`.github/workflows/verify.yml` 已存在并只跑公共 `pnpm verify`，私有验收链永不进 CI。
- 可靠性修复 Task 7 已关闭：完整 public/private 门禁、契约/状态/v2/测试清单/运行 skill 一致性核对及整分支 Critical/Important 复审均已完成；可靠性分支已合并进 `main`。该关闭声明只针对可靠性批次，不覆盖上列 M4/M5 产品门禁。
- 批次 C（AUD-026～032 + AUD-035 第一/二阶段）已全部完成并审阅归档。
- AUD-035 第三阶段（Biome 格式化）已由用户决策延后：store.ts 即将被 M3/M4 修改，现在做巨型函数展开与全量格式化必然返工；正确时机是完整重排落地后（检索侧冻结）的重构窗口，届时再评估格式化是否必要。
- Corpus 阈值门禁已在 4,789,903 字符《语料B》上重跑并通过：索引 11.92s/百万字符、暖 Explore P95 4.42ms、暖 Context P95 4.76ms；报告与 Token 材料仅留本机。该口径按契约先预热每个冻结任务一次，随后测量 revision-scoped 生产缓存路径。
- **重构窗口按触碰面分流（2026-08-18）**：装配侧窗口已开（M4 冻结后）——context 拆 registry/sources/dedup/budget/layer 纯模块（registry+dedup 已落地，sources/budget/layer 可与完整重排并行）；检索侧窗口待**完整重排落地后**——（1）store.ts 图构建/检索 SQL 抽离；（2）移除 oxlintrc.json 对 store.ts 的 ignorePatterns 忽略项；（3）评估 Biome 格式化（若执行：quoteStyle single / semicolons asNeeded / lineWidth 120）。
- M4 剩余：PRF 与真实长语料重测已关闭；仍待外部 tokenizer 对本地材料复核。`mixed-cjk-v1` 继续只是 excerpt-only 启发式估算，不升级为精确 Token 结论。
- M4 审议：已完成的来源/约束装配、excerpt-only accountingScope、server response-size 与 Task 5 运行时硬化保留；A1 使用 adapter-owned `SourceSnapshot`、一致读取重试、及 `loadedFingerprint`/`indexedFingerprint` 双指纹状态语义。真实长语料已由本轮 `verify:private` 重测，结果见上方 Corpus 门禁；后续不得沿用脱离 revision 的历史数字。

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
| **AUD-035-1** lint/coverage 门禁 | ✅ 合格：oxlint 0 警告、coverage 阈值棘轮、vitest 别名修复覆盖率失真 | `c2093cd` | 108/108 回归 | 无产品接口变更（工程基建） |
| **AUD-035-2** generic 适配器模块抽离 | ✅ 合格：21.8KB 单文件拆为 errors/numbering/txt/epub 四策略模块、公共 API 兼容、覆盖率逐位不变 | `e3088af` | 108/108 回归 | 无（纯结构重构） |
| **AUD-013** 来源提供器注册表与 evidenceHash 去重 | ✅ 合格（含缺陷修复）：语义分层、required 晋升 L0、duplicate_evidence 折叠；审阅发现 kind 输入接错——searchRows 返回小写文档类型（d.kind）而注册表键为大写实体类型，全落 L3 → `5aacdb0` 以 DOCUMENT_KIND_ALIASES 归一修复并补真实路径 L1/L2 断言（教训：原单元测试喂大写键绕过真实输入路径而漏检） | `d7f8c24` + `5aacdb0` | `context-source-registry.test.ts` 7 项 | 无接口变更（内部装配语义） |

**审阅附注**：2026-08-16 首批三条与 2026-08-17 批次 C 六条均在已提交 HEAD 上通过 `tsc -b`、全量测试与 30/30 基准验证；2026-08-16 发现的工作区待办（AUD-028 半成品与 L102 语法错误）已在 AUD-028 提交中修复。

## 待审阅修复方案（Pending Review）

> 按用户授权（2026-08-16）自主执行的修复，逐条记录方案内容并标注待审阅；审阅通过后归档入上节。AUD-035-3（Biome 格式化）经用户决策延后至 M3/M4 语义冻结后的重构窗口再评估，评估数据保留于末条供重构窗口参考。

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

> 本清单是计划 §13.3 检查点的唯一宿主（原计划内副本已移除）。按时间倒序（各阶段提交哈希在下一阶段入清单）：

- `655ae8e`（Storyforge）+ `80ac885`（Writing MCP）— HB-M6 真实宿主验收收口：浏览器快照经 Bridge 激活并把 Writing MCP 证据注入 provider，Bridge 停止后失败关闭且只允许显式单次绕过，候选不自动写回；Bridge 在派生数据维护期间可恢复地重启 MCP 子进程，并递归脱敏本地路径。Writing MCP `pnpm verify` 54 文件/278 项、公共基准 30/30、coverage lines 92.92%；Storyforge `npm run ci` 266 文件/1002 项、生产依赖审计 0 漏洞，Playwright 35/35。均为本地提交，未推送。
- `1c1f0c1`（Storyforge）+ `e53d4d8`（Writing MCP）— HB-M5 联合启动收口：`npm run dev` 同启 Storyforge 与 Bridge，终端提供 pairing code；Bridge 接受严格 loopback Origin 参数并在冷启动静态注册 Storyforge 插件。均为本地提交，未推送。
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
