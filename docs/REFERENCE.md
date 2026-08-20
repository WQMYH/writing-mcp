# Writing MCP 设计参考

> 文档性质：调研结论与领域建模参考，不是公共接口规范、实现承诺或验收标准。若本文与 `Writing_MCP_Server_v2.md`、版本化合同或 ADR 冲突，以后者为准。

## 1. 参考目标

本文归纳成熟知识维护、结构化代码检索和代码图谱工具的通用经验，并将小说领域模型转换为 Writing MCP 可采用的设计输入。核心目标不是扩大 v1 范围，而是提高检索命中率、证据可追溯性和上下文 Token 效率。

三类经验可以概括为：

- 知识维护系统强调可重建、增量更新、来源审计和错误隔离。
- 精准代码检索系统强调“先定位，再读取”，避免为了寻找少量信息而加载整个项目。
- 属性图系统强调实体之间的可遍历关系、稳定路径和影响范围。

对应到 Writing MCP：原始创作文件是唯一事实源，索引是可删除的派生知识；检索先确定章节、实体和关系，再读取最小证据片段；图遍历只执行有界、确定性的访问。

## 2. 可采纳的架构原则

### 2.1 先定位，再读取

智能体不应为了寻找一个角色状态或伏笔而默认读取整本书。Writing MCP 应通过精确引用、规范名称、别名、全文种子和有界图扩展定位候选，再只返回支持任务的证据。

该原则不意味着 MCP 能强制客户端禁用原生文件工具。是否拦截直接读取属于客户端、Agent 指令和宿主权限层；MCP 只负责提供更可靠的知识访问路径。

### 2.2 增量维护与错误隔离

- 只重新解析新增、修改和删除的文档。
- 派生关系应按影响范围更新，避免无条件全图重建。
- 新 revision 验证失败时保留上一有效索引。
- 推断错误不得写回原始文本，也不得升级为无证据事实。
- 索引中的任何知识都必须能追溯到源文件、位置、内容哈希和 revision。

### 2.3 可观测的 Token 效率

除了最终上下文 Token，检索与装配结果还应提供可审计指标：

- 候选数和保留数。
- 图遍历访问节点数、路径数和最大实际跳数。
- 是否发生截断、截断位置及遗漏原因。
- 检索、图扩展和上下文装配耗时。
- 原始来源 Token、各层保留 Token、最终 Token 与缩减率。
- 索引是否更新；如实现缓存，再报告缓存命中情况。

这些指标用于优化和验收，不承诺固定 credits 节省比例。

## 3. 小说领域模型参考

### 3.1 v1 核心节点

| 节点 | v1 处理方式 | 说明 |
|---|---|---|
| Work | 必需 | 作品边界与索引归属 |
| Document | 必需 | 原始文件或 EPUB spine 文档 |
| Section/Span | 必需 | 最小证据与全文检索单元 |
| Chapter | 必需 | 章节顺序和范围锚点 |
| Character | 必需 | 角色及别名 |
| Location | 必需 | 仅从明确结构或标记生成 |
| Item | 必需 | 仅从明确结构或标记生成 |
| OutlineNode | 必需 | 大纲与正文映射 |
| Event | 必需 | 时间线和因果路径基础 |
| Fact | 必需 | 有来源、范围和状态的设定或状态 |
| Foreshadow | 必需 | 埋设、呼应、回收生命周期 |
| Scene | 条件支持 | 只有源文本存在明确场景分隔时生成 |

`World`、`Lore` 和独立 `Timeline` 暂不作为 v1 必需存储节点：World 可由 Work 范围表达，Lore 可映射为 Fact/OutlineNode，Timeline 优先作为 Event 与时序边的查询投影。多世界和分支时间线留待后续版本。

### 3.2 v1 关系

基础结构关系：

- `contains`
- `mentions`
- `appears_in`
- `precedes`

写作领域关系：

- `located_at`
- `causes`
- `plants`
- `echoes`
- `resolves`
- `implements_outline`
- `contradicts`

只有结构化字段、明确标题、显式标记或固定规则才能生成确定性关系。普通叙述中的潜在情感、因果和场景关系不得由 MCP 猜测。

当前冻结实现中，`mentions` 是 schema v4 已有、现由 M0 词汇表显式公开的关系：原生 `[[alias]]` 引用通过已持久化的别名确定性解析为 `Document → Entity`，逐边保留 span、定位与 revision 证据；它不能替代独立的 `Entity → Document` `appears_in` 关系。该对齐不新增源文件写入或 Agent 判断。

### 3.3 时态与证据

小说知识不是静态键值。人物关系、所在地点、能力、伏笔状态和事实可能随章节变化。实体、事实和关系至少需要：

- `sourceKind` 与 `confidence`。
- `spanRef`、源位置和证据片段。
- `contentHash` 与索引 `revision`。
- 可选 `validFromChapter`、`validToChapter`。
- 可选叙事时间和确定性属性对象。

查询目标章节存在时，只把该章范围内有效的事实作为“当前事实”；历史事实可以作为带时间说明的证据返回，不得与当前状态混合。

### 3.4 可验证的典型路径

- Character → `appears_in` → Chapter。
- Character/Event → `located_at` → Location。
- Chapter → `precedes` → Chapter。
- Foreshadow → `plants`/`echoes`/`resolves` → Chapter 或 Event。
- Event → `causes` → Event。
- OutlineNode → `implements_outline` 的反向或等价正文映射 → Chapter。
- Fact → `contradicts` → Fact。

每一跳都必须携带边证据；只返回终点片段不构成完整证据链。

## 4. 对检索与上下文的指导

### 4.1 多跳检索

- 0 跳只返回匹配种子。
- 1～3 跳按稳定顺序执行 BFS。
- 以精确匹配、来源可信度、图距离、目标章节距离和文本相关性重排。
- 同一节点经等价路径到达时稳定去重，但保留必要路径证据。
- 循环、fan-out 和全局访问上限必须产生明确截断元数据。
- 时间范围不适用于目标章节的节点或边不得伪装成当前事实。

### 4.2 上下文分层

- L0：任务目标、目标章节、强制约束和 `requiredRefs`。
- L1：目标人物的当前有效状态、直接事件、确定事实和活跃伏笔。
- L2：相邻章节、相关事件、局部大纲和近距离关系。
- L3：世界规则、历史事实和远距离背景资料。

`ContextPacket` 应区分 included、trimmed 和 omitted，并报告来源 Token、返回 Token、缩减率、检索路径和 index revision。

## 5. MCP 与 Agent 边界

Writing MCP 可以：

- 解析、索引、检索和确定性计算。
- 返回候选冲突、未解析引用和证据。
- 按明确预算裁剪并报告遗漏。
- 输出结构化性能和 Token 指标。

Writing MCP v1 不可以：

- 自动更新角色卡、世界观、伏笔池或正文。
- 自动判定冲突事实中哪一个正确。
- 生成摘要、关系、事件或场景来弥补源资料缺失。
- 修改客户端规则文件或强制宿主拦截文件读取。
- 编排写作流程、人工审核、PR 或多智能体协作。

候选知识的采纳、主观判断、用户确认和受控写回属于 Agent 或后续独立协议。

## 6. 对实施计划的结论

1. 保持四工具接口，不因领域类型增加公共工具数量。
2. 在 M3 前执行 M2.1 图模型校准，补齐 schema v2、证据字段、时态范围和原子替换。
3. M3 基准必须覆盖角色—事件—地点、伏笔生命周期、时间有效性、同名消歧和循环图。
4. M4 增加 included/trimmed/omitted 与分阶段 Token、耗时审计。
5. M5 文档说明 MCP 提供首选访问路径，但不能单独保证客户端不读取原文件。
6. Scene、World、Lore、分支 Timeline 和关系强度演化作为后续能力，除非源格式已有可确定解析的数据。

## 7. MCP 生态调研

> 调研日期：2026-08-14。以下信息基于 GitHub 公开仓库和 npm 注册表，不构成对第三方项目的质量背书。

### 7.1 直接相关项目

#### codebase-memory-mcp（DeusData，31K+ Stars）

- 仓库：`github.com/DeusData/codebase-memory-mcp`
- 定位：高性能代码智能 MCP 服务器，用 tree-sitter + LSP 将代码库索引为 SQLite 知识图谱。
- 核心指标：毫秒级索引平均仓库、亚毫秒查询响应、官方宣称 99% Token 缩减。
- 技术栈：Go/Rust 核心 + SQLite 存储 + MCP SDK。
- 与 Writing MCP 的关系：**架构对标**。它是代码领域的「知识图谱 + MCP」验证案例。Writing MCP 做的是同一件事的小说版本——将创作文件索引为属性图，提供结构化检索和上下文装配。其成功（31K Stars）证明了市场对「索引→精准检索→减少 Token」模式的需求。
- 可借鉴点：
  - SQLite 知识图谱 + FTS5 的存储选型与 v2 计划一致，验证了技术路线。
  - 「毫秒级索引、亚毫秒查询」的性能承诺值得在小说领域追求类似目标（百万字小说秒级索引）。
  - tree-sitter 式的确定性语法解析对应小说领域就是章节分割器 + InkOS truth files 解析器。

#### novel-workflow-mcp（@ttaqt/novel-workflow-mcp）

- 包：`npmjs.com/package/@ttaqt/novel-workflow-mcp`
- 定位：AI 辅助小说创作**工作流引擎**。覆盖故事概念→大纲→场景→正文的完整流程，含三幕式结构、两难抉择、审批工作流、实时 Web 仪表板。
- 技术栈：TypeScript/Node.js，MCP SDK，支持 Cursor/Claude Desktop。
- 项目结构：`.novel-workflow/steering/`（世界观/角色档案）、`stories/`（大纲/场景）、`approvals/`（审批记录）、`archive/`（已完成作品）。
- 与 Writing MCP 的关系：**互补而非竞争**。它是 Agent/工作流层（负责编排、审批、进度追踪），Writing MCP 是知识基础设施层（负责索引、检索、上下文装配）。两者可组合：Agent 用 Writing MCP 获取结构化上下文，用 novel-workflow-mcp 管理工作流和审批。
- 可借鉴点：
  - 它的 `.novel-workflow/` 目录结构可作为一种输入格式被通用适配器识别。
  - 审批工作流的设计可供 Writing MCP 后续写回协议参考。
  - 多语言支持（11 种语言，中文优先）的 i18n 策略值得参考。

#### MemoryMesh（CheMiguel23，340 Stars）

- 仓库：`github.com/CheMiguel23/MemoryMesh`
- 定位：面向文字 RPG 和互动叙事的通用知识图谱 MCP 服务器。基于 schema 驱动的动态工具生成，节点（NPC/道具/地点）+ 边（关系）模型。
- 技术栈：TypeScript/Node.js，MCP SDK v1.25.2。
- 核心特性：动态 schema 定义 → 自动生成 CRUD 工具；metadata 为字符串数组；支持关系权重（0-1）；事件系统追踪图操作。
- 与 Writing MCP 的关系：**部分重叠但层次不同**。MemoryMesh 的节点/边模型过于通用（metadata 是无结构字符串数组），缺少小说领域必需的时态维度（validFromChapter/validToChapter）、证据链（sourceKind/confidence/spanRef）和上下文预算装配。Writing MCP 提供了更深的领域建模。
- 可借鉴点：
  - Schema 驱动的动态工具生成模式：用户定义 schema → 自动暴露 MCP 工具。可考虑在 Writing MCP 的扩展阶段为自定义实体类型提供类似能力。
  - 节点权重（relationship strength）概念可融入伏笔/关系的确定性属性。

#### memento-mcp（gannonh，402 Stars）

- 仓库：`github.com/gannonh/memento-mcp`
- 定位：基于 Neo4j 的知识图谱记忆系统，面向通用 LLM 长期记忆。支持实体/关系的完整版本历史、时间感知、置信度衰减、混合语义搜索（向量 + 关键词）。
- 技术栈：Python，Neo4j（图存储 + 向量搜索统一后端），MCP SDK。
- 核心特性：
  - 实体和关系的完整版本历史，支持任意时间点的图谱状态查询。
  - 关系强度与置信度动态衰减（信息时效性保证）。
  - 混合检索（向量语义搜索 + BM25 关键词检索）。
  - 丰富元数据（来源、标签、时间戳）。
- 与 Writing MCP 的关系：**机制可借鉴，定位不同**。memento-mcp 面向通用对话记忆，缺少小说领域的章节时态、伏笔生命周期和上下文预算。但它的置信度衰减和时间感知机制对长篇小说非常有价值——伏笔埋设越久、角色关系变化越多，旧证据的权重应自动降低。
- 可借鉴点：
  - 置信度衰减函数：`confidence = base_confidence × decay^(chapters_since_evidence)`，可融入 `writing_explore` 的重排逻辑。
  - 版本历史查询：查询「第 5 章时的世界状态」，对回溯性写作有直接价值。
  - 混合检索模式（向量 + BM25）可作为 v1 纯 FTS5 的后续增强路径。

### 7.2 间接参考项目

| 项目 | Stars | 定位 | 参考价值 |
|---|---|---|---|
| **cognigraph-mcp-server** | ~100 | 思维导图/关系图谱/知识图谱生成 MCP，使用 markmap + mermaid + OpenAI | 可视化输出模式可参考；但它依赖 LLM 生成图谱，违反 Writing MCP「不使用 LLM」原则 |
| **mem0-mcp**（mem0ai） | 650 | Mem0 长期记忆 MCP 适配层 | 记忆管理 API 设计参考 |
| **mcp-memory-service** | 1.4K | 基于 ChromaDB + 句子转换器的语义记忆 | 向量存储 + 语义搜索的实现参考 |
| **Provenant**（shreyash-sharma） | ~200 | 代码库架构记忆 MCP，64.5× 上下文缩减 | 「先建索引再精准检索」的又一验证案例 |
| **SimpleMem**（aiming-lab） | ~100 | 跨会话持久记忆，检索规划 + token 高效上下文构建 | 「Retrieval Planning」推断搜索意图的设计可参考 |
| **Recall**（H-XX-D） | ~100 | 结构化可操作记忆 MCP，42 工具，SQLite 后端 | 工具数量设计（42 个 vs 我们的 4 个）形成对比，验证了精简工具集的合理性 |

### 7.3 生态位分析

```
代码领域:   codebase-memory-mcp (31K★) → 代码知识图谱 + MCP
记忆领域:   memento-mcp (402★)          → 通用对话记忆图谱 + MCP
RPG 领域:   MemoryMesh (340★)           → 角色扮演结构化记忆 + MCP
工作流层:   novel-workflow-mcp           → 小说创作流程编排 + MCP
              ↑ 缺失的拼图 ↓
小说领域:   Writing MCP (本项目)         → 小说知识基础设施 + MCP
```

**当前市场空白**：截至调研日期，不存在同时具备以下全部能力的 MCP 服务：

1. 小说领域专属的结构化索引（章节/角色/伏笔/时间线/大纲映射）。
2. 证据链 + 置信度 + 来源追溯（sourceKind/confidence/spanRef）。
3. 有界多跳图遍历（BFS 0-3 跳 + fan-out 限制 + 截断元数据）。
4. Token 预算化上下文装配（L0-L3 分层裁剪 + included/trimmed/omitted 审计）。
5. 多格式输入适配（InkOS/Markdown/TXT/EPUB）。

Writing MCP 的差异化价值是明确的：它是「小说世界的 codebase-memory-mcp」——不是记忆工具、不是工作流引擎、不是文本生成器，而是面向智能体的结构化知识检索与上下文供给层。

## 8. 发展建议

> 本节记录基于生态调研和 v2 计划评审得出的演进方向，不是实施承诺。具体采纳需通过 ADR 流程决定。

### 8.1 短期（v1 范围内可考虑）

**确定性 NER fallback**：通用适配器从纯文本中提取实体的能力有限。可引入轻量确定性 NER 层（中文 jieba 分词 + 英文 capitalized word pattern），所有结果标记为 `sourceKind: "heuristic"` + 低置信度。这不违反「不使用 LLM」原则，但能显著改善非结构化源的召回率。需要评估：jieba 作为依赖的许可证兼容性（MIT）、分词精度对 mention 识别的影响、以及是否需要在 M2.1 中增加 heuristic 节点的 schema 支持。

**`writing_review` 纳入评估**：静态质量检查（字数 LengthSpec、人名一致性、章节结构）是纯确定性操作，完全符合 MCP 边界。但 v2 计划明确将其排除在 v1 之外。如需纳入，应作为 `writing_explore` 的 `stats` operation 扩展或独立第五工具，不在 v1 范围内做最终决定，留待 M5 验证后评估。

### 8.2 中期（v1 验收后的扩展方向）

**置信度衰减机制**：借鉴 memento-mcp 的时间感知设计，在重排阶段引入章节距离衰减：距离目标章节越远的证据，默认排序权重越低。实现为 `effective_confidence = base_confidence × decay^(abs(evidence_chapter - target_chapter))`，decay 参数可配置。

**novel-workflow-mcp 集成接口**：Writing MCP 的 `writing_context` 已返回 `ContextPacket`，novel-workflow-mcp 的场景管理可消费该包作为写作输入。两者通过 Agent 中介组合，不需要 MCP 之间的直接协议。但可考虑在文档中提供组合使用的参考配置和示例。

**goink/storycraftr 适配器**：goink 的 SQLite schema 相对简单（characters/chapters/story_arcs/arc_nodes/time_entries 表），实现只读适配器工作量可控（1-2 天）。storycraftr 的 Markdown 目录结构可通过通用适配器覆盖。优先级取决于实际用户需求。

**混合检索增强**：当前 v1 仅使用 FTS5/BM25。后续可增加可选的向量检索层（本地 embedding 或 API），作为 `writing_explore` 的补充模式。参考 memento-mcp 的混合搜索策略：先 BM25 获取种子 → 向量扩展语义相似 → 图遍历关联扩展 → 确定性重排。

### 8.3 长期（架构级演进）

**关系强度演化**：当前 v1 的关系是确定性的（存在或不存在）。长期可引入关系强度（0-1）和演化模型：角色关系随章节事件变化而加强/减弱，伏笔从 planted 到 echoed 到 resolved 的置信度逐步提升。参考 MemoryMesh 的 weight 字段和 memento-mcp 的置信度衰减。

**多作品联合查询**：当前 `workRef` 为单值。架构上预留 `workRefs: string[]` 支持跨作品查询，用于比较两个项目的角色设定差异、世界观异同等场景。不在 v1 实现，但不妨碍 schema 设计时保留扩展空间。

**可视化输出**：借鉴 cognigraph-mcp-server 的图谱可视化（mermaid/markmap），在 `writing_explore` 返回中可选附加 mermaid 格式的实体关系图。这对 Agent 和人类用户都有直观的探索价值，但优先级低于核心检索能力。

### 8.4 不建议的方向

- **在 MCP 中集成 LLM 调用**：违反确定性原则。所有 LLM 调用（实体抽取、摘要生成、质量判断）属于 Agent 职责。
- **全功能写作平台**：与 goink/inkos/storyforge 等现有项目功能重叠，且远超 MCP 作为「知识基础设施层」的定位。
- **替代 novel-workflow-mcp 的工作流能力**：审批、进度追踪、场景管理等编排逻辑属于 Agent/工作流层，不应反向塞入 MCP。
- **追求工具数量**：Recall MCP 有 42 个工具，我们的 v1 只有 4 个。精简工具集是经过深思熟虑的设计选择——减少 LLM 工具选择负担和 schema token 成本。
