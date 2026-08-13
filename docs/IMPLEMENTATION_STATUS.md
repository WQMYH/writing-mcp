# Writing MCP MVP 实施状态

> 检查点时间：2026-08-13  
> 当前状态：可演示 MVP，尚未达到 `Writing_MCP_Server_v2.md` 的完整验收标准。

## 恢复入口

```powershell
cd E:\Programming\AI\Agents\Writing\writing-mcp
pnpm install
pnpm build
pnpm test
```

四个命令行工具由 stdio MCP server 暴露：

```powershell
pnpm start
```

实现中断后，先运行 `pnpm build` 和 `pnpm test`。两者都通过后，才可继续增加功能。

## 已实现闭环

- TypeScript monorepo：`core`、`adapter-inkos`、`adapter-generic`、`mcp-server`。
- Node.js 24 内置 `node:sqlite`，SQLite 3.53 和 FTS5 trigram。
- `writing_resolve`、`writing_index`、`writing_explore`、`writing_context`。
- InkOS 书籍识别，新旧大纲路径、角色目录、状态、伏笔和章节读取。
- Markdown、TXT 和基础 EPUB spine 解析。
- 项目内 `.writing-index/<workId>/index.sqlite`。
- 文档哈希增量更新、revision、无变化不新增 revision、事务回滚。
- Span 全文检索、角色实体、mention、`contains` 和 `appears_in` 关系。
- 基础 entity/neighborhood/document/stats/search 查询。
- 抽取式上下文选择、Token 估算和预算上限。
- MCP stdio 客户端端到端测试。

## 里程碑完成度

| 里程碑 | 状态 | 已完成 | 未完成门禁 |
|---|---|---|---|
| M0 | 进行中 | 工程、核心类型、SQLite v1 schema、依赖和基础 fixture | 30 个基准任务、完整 output schema、排序权重文档、EPUB 异常样本、ADR |
| M1 | 进行中 | InkOS/通用适配器、稳定 work/document/span ID | 授权 roots 配置、junction/symlink 测试、完整 InkOS 新旧 fixture、损坏 EPUB 诊断 |
| M2 | 进行中 | SQLite/FTS5、增量文档、revision、基础图谱 | schema 兼容检测/迁移、临时库原子替换、unresolved mention 实际填充、更多节点关系 |
| M3 | 进行中 | search/entity/neighborhood/document/stats 基础查询 | 真正的 0～3 跳 BFS、timeline、fan-out/全局上限、歧义模型和完整重排 |
| M4 | 进行中 | ContextPacket、预算上限、抽取式选择 | L0～L3 正式策略、requiredRefs 完整解析、tokenizer profile、任务类型/章节范围 |
| M5 | 进行中 | stdio、四工具注册、structuredContent、协议测试 | outputSchema、稳定错误映射、真实 InkOS/EPUB 回归、客户端安装与故障文档 |

任何里程碑当前都不能标记为 `complete`。现有成果是跨里程碑的“纵向切片 MVP”。

## 当前测试覆盖

- 通用文本：resolve → rebuild index → 中文搜索 → context → 无变化索引 → entity/neighborhood → 单章增量更新。
- 适配器优先级：InkOS 根目录不会同时被 generic fallback 报为第二个作品。
- MCP stdio：枚举四工具并顺序调用 resolve/index/explore/context。

## 已知限制

- `maxHops` 参数目前尚未驱动真正的多跳 BFS；neighborhood 只有基础一跳扩展。
- `timeline` 目前没有独立语义实现。
- `taskType` 尚未改变上下文来源策略。
- 角色提取只覆盖角色类文档的 heading，尚无别名解析和未解析 mention 生成。
- EPUB 解析为最小实现，尚未覆盖加密、复杂命名空间、脚注和损坏包。
- `workRef` 只在当前 server 进程中注册；重启后客户端需重新调用 `writing_resolve`。
- 尚未达到 90% 事实召回、100% 证据覆盖、60% Token 缩减等正式基准结论。

## 下一步

继续 M0，不直接宣称进入下一里程碑完成态：

1. 建立至少 30 个机器可读基准任务和评分器。
2. 补全四工具 output schema 与错误 envelope。
3. 建立 InkOS、EPUB、安全路径和预算失败 fixtures。
4. 用基准结果决定多跳、排序和上下文层级的具体参数。
