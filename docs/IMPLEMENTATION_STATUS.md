# Writing MCP MVP 实施状态

> 检查点时间：2026-08-14
> 当前状态：M0～M2 已完成，M0.1 诊断协议增补已落地，M3 进行中；整体仍是可演示 MVP，尚未达到 `Writing_MCP_Server_v2.md` 的 v1 完整验收标准。

## 恢复入口

```powershell
cd E:\Programming\AI\Agents\Writing\writing-mcp
pnpm install
pnpm build
pnpm benchmark
pnpm test
```

五个 MCP 工具由 stdio server 暴露：

```powershell
pnpm start
```

实现中断后，依次运行 `pnpm build`、`pnpm benchmark` 和 `pnpm test`。三者都通过后，才可继续增加功能。

最近验证：2026-08-14，构建通过；30/30 公共基准任务、10/10 固定事实召回和 100% 证据覆盖通过；fixture 上下文 Token 降幅 61.24%；本地私有长篇达到 41/42 span 召回、16/16 required 召回、100% 来源覆盖、首次索引约 0.46 秒及暖查询 P95 约 44 毫秒。

## 已实现闭环

- TypeScript monorepo：`core`、`adapter-inkos`、`adapter-generic`、`mcp-server`。
- Node.js 24 内置 `node:sqlite`，SQLite 3.53 和 FTS5 trigram。
- `writing_resolve`、`writing_index`、`writing_explore`、`writing_context`、`writing_diagnose`。
- InkOS 书籍识别，新旧大纲路径、角色目录、状态、伏笔和章节读取。
- Markdown、UTF-8/GB18030 TXT 和 EPUB OPF/spine 解析；单文件 TXT 支持章节切分、卷内编号重置与原始行号保留，转换型 EPUB 支持作品元数据、封面过滤、正文清洗和跨 spine 内部章节切分。
- 项目内 `.writing-index/<workId>/index.sqlite`。
- 文档哈希增量更新、revision、无变化不新增 revision、事务回滚。
- Span 全文检索、角色实体、mention、`contains` 和 `appears_in` 关系。
- 基础 entity/neighborhood/document/stats/search 查询。
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
| M0 | 已完成（含 M0.1 增补） | 版本化协议/存储合同、五工具 schema、统一诊断信封、四类最小 fixture、30 个任务、Token/事实基线、EPUB 技术验证、两项 ADR | 无 |
| M1 | 已完成 | 授权 roots、realpath/链接防护、稳定候选与引用、单/多书诊断、InkOS 新旧结构、Markdown/TXT/EPUB、损坏 EPUB 错误码 | 无 |
| M2 | 已完成 | SQLite/FTS5、schema v2、works/index_revisions、证据哈希/属性/时态/revision、临时库验证后原子替换、未实现关系延期 ADR、按受影响文档/实体增量刷新派生图、稳定 revision 回归 | 无 |
| M3 | 进行中 | search/entity/neighborhood/document/stats、0～3 跳稳定 BFS、逐边路径证据、64 fan-out/512 节点上限、检索指标、正确 documentRef、短中文词重排、低权重称呼形态扩展、私有长篇性能门禁、全工具自动诊断、显式调用链捕获与诊断文件 | timeline、歧义模型、章节时态过滤、完整重排、诊断容量/并发的进一步压力验证 |
| M4 | 待开始（已有纵向切片） | ContextPacket、预算上限、抽取式选择 | L0～L3 正式策略、requiredRefs 完整解析、tokenizer profile、任务类型/章节范围 |
| M5 | 待开始（已有纵向切片） | stdio、五工具注册、structuredContent、outputSchema、统一结果/错误/诊断信封、协议测试、单个真实转换型 EPUB 回归 | 真实 InkOS、更多 EPUB 2/3 变体、客户端安装与故障文档 |

M0～M2 已满足计划完成条件。M2 的完成以原子重建、受影响范围增量更新、跨文档引用修复和无关派生记录 revision 稳定回归为依据。M3～M5 仍未完成；现有成果不能据此宣称 Writing MCP v1 已完成。

## 当前测试覆盖

- 通用文本：resolve → rebuild index → 中文搜索 → context → 无变化索引 → entity/neighborhood → 单章增量更新。
- 适配器优先级：InkOS 根目录不会同时被 generic fallback 报为第二个作品。
- MCP stdio：枚举五工具，顺序调用 resolve/index/explore/context/diagnose，确认所有成功/失败响应均经过诊断 hook 并验证结构化错误信封。
- 诊断链：覆盖默认元数据脱敏、显式 query 策略、捕获序号、JSON/Markdown 产物、SHA-256、幂等 finish、关闭运行引用和不可持久化降级。
- M0 基准：固定 fixture 上 30 个检索、实体、邻域、文档、统计和上下文任务全部命中且具有证据。
- M0 基线：整书估算 166 Token，10/10 预期事实召回，证据覆盖 100%，三项上下文任务平均 64.33 Token，降幅 61.24%。
- 私有长篇：外部 schema v2 标注包含 42 条事实、101 条逐字证据和七类知识；数据不入库、不进入 Git，运行器只输出汇总及失败 ID。
- TXT：覆盖 GBK/GB18030 解码、章节切分、章节编号重置推断新卷和原始文件行号偏移。
- EPUB：正常双章节 spine、OPF 属性顺序变化、元数据标题、封面过滤、跨 spine 章节续文、单作品多 EPUB 引用隔离，以及损坏 ZIP、缺 container、缺 OPF、无可读 spine 四类失败。
- 私有转换型 EPUB：本机《语料A》从 5 个 spine 文档重建为 1 个前置文档、55 个编号章节和 1 个尾部段落；索引为 57 documents、121 spans、31 entities、208 edges，中文检索、500 Token context、无变化增量更新和多调用诊断捕获均通过，原文及索引不入 Git。
- InkOS：静态最小 fixture 的稳定作品引用、原生文档类型和章节编号。
- 路径安全：MCP 缺少授权 roots 时拒绝访问，入口越界及作品目录内 symlink/junction 越界均被阻止。
- 作品识别：覆盖单书、多书歧义、空目录、不支持扩展名、同目录直接文件隔离和 InkOS 新旧结构。
- 稳定诊断：`AUTHORIZED_ROOTS_REQUIRED`、`PATH_NOT_ALLOWED` 以及四类 EPUB 确定性错误码。
- 索引生命周期：不兼容 schema 只读报告/显式重建、失败事务保留上一 revision、未解析方括号引用入库。
- 增量影响范围：无关文档的派生记录不改写 revision；新增实体会重新解析其他文档中匹配的未解析引用。
- 属性图：原生 Chapter/Character/OutlineNode/Fact/Foreshadow，显式 Location/Item/Event，以及 contains/appears_in/mentions/precedes。
- 可重建性：删除整个 `.writing-index` 后可从原始文本恢复等价稳定引用和检索结果。
- Reference 边界：保持确定性知识访问、无 LLM、无自动写回；第五工具只增加可观测性和派生诊断文件，Scene 仅按明确分隔条件生成，World/Lore/独立 Timeline 不作为 v1 必需存储节点。

## 已知限制

- `timeline` 目前没有独立语义实现。
- `taskType` 尚未改变上下文来源策略。
- 角色实体提取只覆盖角色类文档 heading；查询期仅提供透明的中文称呼形态扩展，尚无持久化别名解析。
- EPUB 仍采用确定性轻量解析，尚未覆盖 DRM/加密、复杂命名空间、导航目录语义、脚注回链、图片内容和全部 EPUB 2/3 变体；内部章节切分目前依赖独占行的中英文编号标题。
- `workRef` 只在当前 server 进程中注册；重启后客户端需重新调用 `writing_resolve`。
- 私有长篇仍有 1 条 optional 事实未进入前 20，900 字抽取摘要的逐字证据暴露率为 88.10%；这些指标与 span 召回、来源覆盖分别报告。

## 下一步

继续 M3：先对真实 Qoder/Codex 调用执行一次显式诊断捕获，审查工具路由、重复调用、实体回退和 context 误用；随后实现 timeline、歧义模型、章节时态过滤和剩余重排，并继续提高私有语料 optional 召回与证据窗口暴露率。
