# Writing MCP 综合实现审查（2026-08-15）

> 审查基线：`5b93711094802821463e387052d90ec3f9fed4c7` 及当前工作区
>
> 审查范围：协议、适配器、索引、属性图、检索、上下文、诊断、安全、性能、测试和文档
>
> 输入材料：本地 `REVIEW_2026-08-14.md`、`REVIEW_2026-08-15.md`，并重新对照当前代码与运行结果
>
> 性质：证据化审查记录，不替代工具 schema、ADR 或 `Writing_MCP_Server_v2.md`

## 1. 结论

当前实现已经形成可运行的 `resolve → index → explore/context → diagnose` 纵向链，构建、34 项测试和 30 项公开基准均稳定通过。路径防护、事务回滚、有界 BFS、逐边证据和诊断信封是真实资产。

但现有门禁主要证明“最小 fixture 可运行”，尚不能证明索引事实性、图身份、真实证据定位、自然语言检索、并发恢复和 Token 预算在代表性作品上正确。综合审查发现若干违反既有契约的缺口，因此 M0.1、M1、M2 应保留成果但重新打开补强；M3/M4 不能在这些基础问题修复前冻结公共模块边界。

“可能存在的所有问题”无法作为绝对完备性承诺。本文记录的是当前代码、测试和可用真实语料能够发现或由明确代码路径推出的问题，并按证据强度区分：

- **已复现**：本轮或既有真实语料中可稳定重现；
- **代码确认**：实现路径可直接证明，不依赖运行概率；
- **风险/缺测**：存在明确失败机制，但需要专门故障注入或更多语料验证。

## 2. 复核基线

- `pnpm check` 通过。
- 12 个测试文件、34/34 测试通过。
- 公开基准 30/30 通过；固定 fixture 事实召回与 locator 存在率为 100%；估算 Token 降幅 61.24%。
- `writing_context("林秋", 200)`：4 blocks、91 estimated tokens。
- `writing_context("林秋在北塔调查什么", 200)`：`complete`、0 blocks、无诊断。
- `neighborhood("林秋", 2)`：12 个结果、11 个扩展节点均有 path evidence；四组内容分别以 entity/document/span 三份重复返回。
- 修改已索引源文件后立即调用 `writing_index(status)`，仍返回 `fresh`、revision 不变；随后 incremental 才识别 1 个 updated 文档。
- 真实《语料A》EPUB：57 documents、121 spans、31 entities、208 edges；56 个章节文档仅对应 31 个 Chapter 实体。

公开基准中的“证据覆盖”当前只验证结果具有 `relativePath/startLine`，并不验证 locator 真正覆盖命中的事实；Token 指标只统计 excerpt 的 `mixed-cjk-v1` 估算，不包含标题、引用、JSON/Markdown 包装和模型 tokenizer 差异。

## 3. 问题清单

### P0：冻结任何图或上下文公共基线前必须解决

| ID | 证据 | 问题 | 影响与完成条件 |
|---|---|---|---|
| AUD-001 | 已复现 | Chapter 实体 ID 仅由类型和规范化标题生成，多卷重复章名被合并 | ID 纳入 work/document/父层级；真实 56 章不再折叠，重复标题仍可独立引用 |
| AUD-002 | 代码确认 | `precedes` 只按全局 `chapter_number` 排序；SourceDocument/DB 没有作品内稳定 ordinal 或 volume | 保存源顺序和卷语义；编号重置、同号章节和 EPUB spine 顺序均正确 |
| AUD-003 | 已复现 | `writing_index(status)` 不重载源文件，只要存在 revision 就报告 `fresh` | status 必须比较廉价快照或明确返回 `unknown/stale`；源修改测试通过 |
| AUD-004 | 已复现 | 无空格中文自然语言整句被当作一个 LIKE/FTS phrase，静默返回 `complete + 0 blocks` | 确定性 CJK query analysis；真无结果与检索未命中有诊断区分 |
| AUD-005 | 代码确认 | `requiredRefs` 只能在 search top-50 中标记；缺失引用不进 blocks/omitted | 按 ref 直接解析并校验；不存在、超预算和超 top-N 均有稳定语义 |
| AUD-006 | 代码确认 | 增量快照只比较正文哈希，标题、kind、chapterNumber、来源顺序等元数据变化可能被跳过 | 文档派生语义进入 snapshot；元数据单独变化触发正确更新 |
| AUD-007 | 代码确认 | entity/edge `content_hash` 多数哈希关系键或名称+spanRef，而非来源证据内容；返回项也不暴露对应哈希/行级 revision | 明确 identity hash 与 evidence hash；证据哈希必须能验证来源片段，查询返回 revision 语义一致 |
| AUD-008 | 代码确认 | 普通实体提及只记录每个 span 的第一次出现；同实体同文档多个 span 的 `appears_in` edgeRef 相同，后续证据被 `INSERT OR IGNORE` 丢弃 | 所有提及可定位；关系证据支持多值或独立 evidence record，不静默丢失 |
| AUD-009 | 代码确认 | 同名实体由 `INSERT OR IGNORE` 决定归属；SQL 同分/同章节顺序不完整，哪个 span 成为规范实体可能不稳定；删除首个定义时无法可靠晋升另一来源 | 先定义实体身份与歧义集合，再确定规范来源；重复定义增删回归稳定 |
| AUD-010 | 代码确认 | EPUB 章节可跨多个 spine 拼接，但 document 只保留首个 entryPath/startLine，后续片段行号无法映射回真实 XHTML | span 支持分段 EPUB locator/entryPath；每个返回 excerpt 可追溯到实际 spine 位置 |
| AUD-011 | 已观察风险 | 同作品没有进程内/跨进程单写者锁；并发 rebuild 共用 `.previous`，Windows 已观察到 `EBUSY`；崩溃停在 active→previous 后没有启动恢复 | 每作品串行、跨进程锁或明确冲突码；启动恢复 `.previous/tmp`；并发和崩溃注入通过 |

### P1：M3/M4 正式完成前必须解决

| ID | 证据 | 问题 | 影响与完成条件 |
|---|---|---|---|
| AUD-012 | 代码确认 | `taskType` 在 MCP schema 中存在，但 service/store 丢弃；targetChapter/entityRefs/documentRefs/excludeRefs 尚未进入公共 schema | 参数要么生效并版本化，要么明确标记 reserved；不得伪装已实现 |
| AUD-013 | 已复现 | L0 从不产生；L1～L3 只是排名位置；context 仅按 ref 去重，内容三重重复 | 语义来源分层、content/evidence 去重、required 优先和遗漏报告通过 |
| AUD-014 | 代码确认 | Token 只估算 excerpt，不计标题、元数据、引用和序列化开销；预算可能低估真实模型输入 | 定义 packet 计费边界和 tokenizer profile；对至少一种真实 tokenizer 校准 |
| AUD-015 | 代码确认 | `timeline` 等同全文 search；valid_from/to/narrative_time 没有参与查询/BFS/排序 | timeline 有独立确定性投影；目标章节时态过滤和测试通过 |
| AUD-016 | 代码确认 | aliases 仅保存规范名，实体查询不查 alias；`ambiguous` 永远为空；unresolved mention 未形成可观察闭环 | 同名/别名/未解析引用返回候选与证据，不自动猜测 |
| AUD-017 | 代码确认 | LIKE 候选在 `LIMIT` 前无 ORDER BY，entity/document 同分结果缺少完整稳定排序，部分排序使用环境相关 `localeCompare` | 候选截断前稳定排序；跨重复运行/平台的 tie-break 明确 |
| AUD-018 | 代码确认 | query、term 数和 requiredRefs 无长度/数量上限；动态 LIKE 参数可过多；explore 最多返回约 100×900 字证据 | 冻结输入、候选、响应字节和执行时间上限；超限返回稳定错误/截断 |
| AUD-019 | 代码确认 | FTS5 异常被空 catch 吞掉；空 query/无命中返回正常 complete 且无检索通道诊断 | 记录 FTS 降级、term 分析、候选计数和 `NO_MATCHING_TERMS/NO_RESULTS` |
| AUD-020 | 代码确认 | BFS 对每个访问节点单独查边，最多数百次同步 SQLite 查询；entity 查询全表载入 JS；LIKE 前缀 `%` 全扫 | 批量/递归查询或明确性能预算；百万字和高 fan-out P95 门禁 |
| AUD-021 | 代码确认 | 每次 explore/context 都执行 incremental，重新读取所有文件；多个 work store 无 LRU/闲置释放 | mtime/size 快速快照后按需哈希；作品级资源生命周期与上限 |
| AUD-022 | 代码确认 | 图只稳定产生少数节点/边；普通叙事不会推断事件、因果、伏笔等，`EntityKind` 还遗漏代码实际使用的 OutlineNode | 冻结“确定性可抽取子集”能力声明和类型契约；未实现关系不得作为已有能力 |
| AUD-023 | 代码确认 | 诊断契约声称保存证据引用，但持久化 output summary 只保存 results/blocks 数量；无法判断命中了哪些 ref | 开发捕获保存有界 ref、sourceKind、score、locator/ref hash 与截断，不保存正文 |
| AUD-024 | 风险/缺测 | general diagnostics JSONL 的 rotate+append 没有统一串行锁；并发调用可能覆盖或乱序；仅 capture append 使用队列 | general event 写入也串行/原子化；并发、轮转、写失败和容量测试 |
| AUD-025 | 风险/缺测 | MCP SDK 在 handler 前的 schema 错误不经过 `handleDiagnosed`；handler 后 output schema 失败可能与已记录 outcome 不一致 | 明确可观察边界；协议级无效输入/输出验证错误测试和日志策略 |

### P2：M5、文档和工程硬化

| ID | 证据 | 问题 | 影响与完成条件 |
|---|---|---|---|
| AUD-026 | 代码确认 | generic 目录把所有支持文件递归合成一个作品，不能识别目录内多个独立书籍；capabilities 总是声明 epub | 定义通用作品边界/歧义候选；capabilities 由实际输入决定 |
| AUD-027 | 代码确认 | TXT regex 接受罗马数字 chapter，但用 `Number("iv")` 解析导致跳过；Markdown 中文数字章名与百以上中文数字覆盖不足 | 明确支持语法并增加罗马/中文/重置/异常编号 fixture |
| AUD-028 | 代码确认 | EPUB 使用正则解析 XML/HTML；未限制 ZIP 展开大小、entry 数和单文档大小；复杂 namespace、加密、脚注、图片等不支持 | 资源上限、防 ZIP bomb、格式能力诊断；支持子集文档与更多 EPUB 2/3 fixture |
| AUD-029 | 风险/缺测 | 读取多文件期间源可能变化，snapshot 可混合不同时间状态；全文和 EPUB 整体驻留内存 | 读取前后快照校验或重试；文件/作品内存上限和源变化错误 |
| AUD-030 | 代码确认 | `splitDocument` 对超长单行不硬切分，trim 后 locator 包含被裁掉空行，跨 span 无重叠 | 最大 span 硬上限、locator 精确规则、边界证据回归 |
| AUD-031 | 代码确认 | open 每次覆盖 `.writing-index/.gitignore`；只读源目录无法使用默认索引；与“不要修改用户文件”边界易混淆 | managed file 仅缺失时创建或不创建；定义可配置缓存根/只读源行为 |
| AUD-032 | 风险/缺测 | SIGINT/SIGTERM handler 只关闭 service，不关闭 MCP server/显式退出；同步 SQLite 长操作不可取消 | 进程生命周期、取消、优雅关闭和无 stdout 污染测试 |
| AUD-033 | 代码确认 | Markdown fallback 实质是 fenced JSON；usage diagnose 解释有限，capture Markdown 只有汇总没有调用明细 | 保留 structuredContent，提供简洁使用者摘要与可审阅开发 Markdown |
| AUD-034 | 代码确认 | 公共 evidenceCoverage 只检查 locator 字段存在；私有 required 指标不是 MCP `requiredRefs`；私有标注当前缺失 | 指标重新命名并验证事实—证据对应；恢复可复现代表性语料后才作产品验收 |
| AUD-035 | 代码确认 | `store.ts`/适配器大量单行函数、职责集中；无 lint/format/coverage 门禁，修改和审查容易漏差异 | 先修正确性，再在行为测试保护下格式化并抽离已批准策略模块 |
| AUD-036 | 代码确认 | 仓库状态文档仍以 08-14 为检查点；两份输入审查未跟踪且缺少 trace/artifact；部分“完成”声明已被新问题推翻 | 更新状态与问题 ID；审查记录注明 commit/命令/语料/可复现性 |

## 4. 两份原审查的结论校准

### 仍然成立

- `requiredRefs`、`taskType`、timeline、时态、L0～L3、FTS 空 catch、内容重复和诊断压力缺口均真实。
- core 与 transport 解耦、依赖注入、事务回滚、有界 BFS、逐边 evidence 和诊断写失败隔离均是应保留资产。
- 模块化应围绕实体身份、排序、时间、歧义、抽取和上下文来源渐进进行，不应立刻引入通用动态插件框架。

### 需要撤回或加限定

- “M0～M2 无剩余门禁”不再成立：AUD-003、006～011、023～025 违反 freshness、证据、恢复或诊断契约。
- “中文长句是最大缺陷”只对最小 InkOS fixture 成立；真实多卷 EPUB 的身份与顺序错误优先级更高。
- “诊断内部串行队列防并发损坏”只对显式 capture 生效，general JSONL 没有同等串行保护。
- “证据覆盖 100%”目前表示 locator 字段存在，不等于命中事实与证据逐字对应，也不保证 EPUB locator 真实。
- “L1/L2 分层正确”只能描述示例结果的表面位置，不能表示语义分层已实现。
- 私有 41/42、88.10%、44ms 等是历史结果；私有标注缺失时不可作为当前可复现门禁。

## 5. 推荐修复顺序

1. **索引事实性**：AUD-003、006、011、031。
2. **图身份与证据**：AUD-001、002、007～010。
3. **检索可用性与确定性**：AUD-004、016～020。
4. **诊断可信度**：AUD-023～025。
5. **M3 语义**：AUD-015、016、022。
6. **M4 上下文**：AUD-005、012～014。
7. **M5 适配器、安全、生命周期和验收**：AUD-026～036。

每一组都必须先加入失败回归测试，再实现修复，最后运行 `pnpm check`、34+ 全量测试、公开基准和相关真实语料验证。公共输出或 schema 变化需要更新 `M0_CONTRACT.md`/ADR；索引身份或 schema 变化必须通过重建而不是迁移原文。

## 6. 本轮未修改的内容

本审查不修改业务代码、不提交本地书稿或索引，也不把未来 LLM/插件构想升级为 v1 范围。两份原始本地审查继续作为输入记录；本文件是自包含的校准结果。
