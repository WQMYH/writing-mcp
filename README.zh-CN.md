# Writing MCP

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--v3.0--only-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-24.x-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](#质量门禁)
[![pnpm](https://img.shields.io/badge/pnpm-11%2B-orange.svg)](https://pnpm.io/)

[English](README.md) | **简体中文**

面向写作智能体的本地、确定性知识访问与上下文供给层，经 [Model Context Protocol](https://modelcontextprotocol.io)（stdio）提供服务。Writing MCP 把授权范围内的创作项目——InkOS、Markdown、UTF-8/GB18030 TXT 和转换型 EPUB——转换为可重建的 SQLite/FTS5 索引，并以可验证的证据摘录回答检索、有界图探索和预算化上下文查询。服务内部没有 LLM：执笔的始终是你的智能体。

## 设计原则

- **构造上确定**——同一索引 revision 与查询永远得到同一答案；排序与装配完全可复现，并受机器门禁约束。
- **证据支撑**——每条事实都带来源引用、字节/字符数、SHA-256 摘录哈希；预算装不下时给出明确的遗漏原因。
- **只读且沙箱化**——来源只能经显式授权的根目录访问，带符号链接/junction 越界防护；服务绝不写回你的书稿。
- **诚实的 Token 口径**——Token 数值明确标注为证据摘录上的启发式估算（`accountingScope: evidence_excerpts_only`），并输出足够材料供外部 tokenizer 独立复核。
- **默认保护隐私**——诊断只记录参数摘要、结果、耗时与引用哈希；正文与绝对路径默认不落盘。

## 五个工具

| 工具 | 用途 |
|---|---|
| `writing_resolve` | 识别授权根目录下的作品，返回 `workRef` |
| `writing_index` | 构建/增量刷新作品索引；`status` 报告新鲜度 |
| `writing_explore` | 检索、实体、邻域、关系、0～3 跳 BFS、timeline、document 与 stats 查询 |
| `writing_context` | 装配 `ContextPacket`：L0～L3 分层证据选择，支持 requiredRefs、章节/实体/文档约束、排除项、去重与预算裁剪 |
| `writing_diagnose` | 健康检查与脱敏诊断捕获 |

典型调用顺序：`writing_resolve` → `writing_index(status)` → `writing_explore` / `writing_context`。`workRef` 仅在当前 server 进程内有效。

## 快速开始

环境要求：**Node.js 24.x**（内置 `node:sqlite` 与 FTS5）和 **pnpm 11+**。

```powershell
pnpm install
pnpm verify   # 隐私门禁 + 类型检查 + lint + 测试 + 基准 + 覆盖率
```

以 stdio 启动：

```powershell
$env:WRITING_MCP_ROOTS = "E:\WritingProjects"   # bash: export WRITING_MCP_ROOTS=...
pnpm start
```

`WRITING_MCP_ROOTS` 必须指向显式授权的目录（Windows 用 `;` 分隔多个根目录，Unix 用 `:`）。在 MCP 客户端中指向构建产物：

```json
{
  "mcpServers": {
    "writing-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["<repo-root>/packages/mcp-server/dist/index.js"],
      "cwd": "<repo-root>",
      "env": { "WRITING_MCP_ROOTS": "<authorized-writing-root>" }
    }
  }
}
```

完整客户端配置——Qoder 与 Codex 配置、首次调用走查、七类故障排查——见 [docs/CLIENT_SETUP.md](docs/CLIENT_SETUP.md)。

## 整体架构

```text
InkOS / Markdown / TXT / EPUB          （授权根目录，只读）
        │  适配器（格式识别、章节切分、EPUB spine 解析）
        ▼
.writing-index/<workId>/index.sqlite   （SQLite + FTS5，schema 版本化，
        │                               增量、事务化、可重建）
        │  确定性检索（精确 + FTS5/BM25、别名、PRF、
        │             有界 BFS、关系证据）
        ▼
MCP stdio 工具                         （resolve → index → explore → context → diagnose）
        │  证据摘录 + 哈希 + 预算核算
        ▼
你的 AI 智能体                          （负责创作；MCP 绝不代笔）
```

## 明确不做

- 生成、改写或写回正文，不做创作决策；
- 调用外部 LLM、向量数据库或网络服务；
- 保存智能体推理、会话记忆或模型状态；
- 宣称精确 Token 节省——见上文"诚实的 Token 口径"。

## 质量门禁

每次 `pnpm verify` 依次运行隐私历史门禁、严格 TypeScript 构建、零警告 lint、全量测试、冻结的 30 任务公共基准（事实召回、证据覆盖、响应预算）与覆盖率棘轮。测试清单见 [tests/README.md](tests/README.md)。

## 仓库结构

```text
packages/
├─ core/                  # 存储、检索、PRF、上下文装配
├─ adapter-generic/       # Markdown / TXT / EPUB 适配器
├─ adapter-inkos/         # InkOS 项目结构适配器
├─ mcp-server/            # stdio 服务、五工具、诊断
├─ host-bridge-protocol/  # 冻结的宿主插件协议 v1（Zod + fixture）
└─ host-plugin-storyforge/# 首个受治理的静态宿主插件 manifest
tests/  docs/  scripts/  fixtures/
```

## 宿主集成插件

Writing MCP 刻意保持核心专注：宿主相关的集成以受治理的静态插件存在，不进入五工具公共契约。首个插件——面向浏览器写作宿主的本地 loopback host bridge——线上协议已冻结为 v1（[`packages/host-bridge-protocol`](packages/host-bridge-protocol)，规范 fixture 见 [`fixtures/host-bridge-protocol`](fixtures/host-bridge-protocol)），bridge 运行时正在开发中。任何宿主专属逻辑都不进入核心 MVP。

## 项目状态

M0～M3（协议、索引、检索）已完成并通过机器门禁；M4（上下文装配）处于最后的验证切片，等待外部 tokenizer 复核；M5（真实客户端验收）的文档切片已落地。所有状态声明的唯一事实源是 [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/CLIENT_SETUP.md](docs/CLIENT_SETUP.md) | Node/pnpm 前置、Qoder/Codex stdio 配置、首次调用、故障排查 |
| [docs/M0_CONTRACT.md](docs/M0_CONTRACT.md) | 冻结协议与数据契约：工具 schema、信封、诊断 |
| [docs/REFERENCE.md](docs/REFERENCE.md) | 工具语义与参数详解 |
| [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) | 里程碑状态、门禁证据、可追溯提交 |
| [tests/README.md](tests/README.md) | 测试文件 → 主题覆盖映射 |

## 许可证

Writing MCP 采用 GNU Affero General Public License v3.0 only（[LICENSE](LICENSE)）；第三方依赖遵循其各自许可证。
