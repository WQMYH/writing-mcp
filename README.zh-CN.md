# Writing MCP

[![verify](https://github.com/WQMYH/writing-mcp/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/WQMYH/writing-mcp/actions/workflows/verify.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--v3.0--only-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-24.x-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](#质量门禁)
[![pnpm](https://img.shields.io/badge/pnpm-11%2B-orange.svg)](https://pnpm.io/)

[English](README.md) | **简体中文**

面向写作智能体的本地、确定性知识访问与上下文供给层，经 [Model Context Protocol](https://modelcontextprotocol.io)（stdio）提供服务。Writing MCP 把授权范围内的创作项目——InkOS、Markdown、UTF-8/GB18030 TXT 和转换型 EPUB——转换为可重建的 SQLite/FTS5 索引，并以可验证的证据摘录回答检索、有界图探索和预算化上下文查询。服务内部没有 LLM：执笔的始终是你的智能体。

## 为什么需要它

一部小说往往在写完之前就先撑爆了上下文窗口。当智能体只能凭"读过什么"的印象下笔时，已确立的事学会漂移，貌似合理的编造会浮现——角色的瞳色、某场戏里谁在场、某条伏笔是否已经回收。多数面向文本的 MCP 服务用两种方式回应这个问题：包一层向量数据库（最近邻，没有定位器），或包一层 LLM（流畅，但无法审计）。Writing MCP 两者都不包：它以确定性方式读书稿，返回精确的 span、所在文件、行号区间和正文哈希，于是一条说法可以对着原文核验，而不是靠信任。若服务无法支撑某个答案，它会明说，并给出原因。

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

workspace 内的包目前仍是 `private: true`——没有 `npm install writing-mcp` 这条路。请从克隆开始：

```bash
git clone https://github.com/WQMYH/writing-mcp.git
cd writing-mcp
pnpm install
pnpm build
pnpm verify   # 隐私门禁 + 类型检查 + lint + 测试 + 基准 + 覆盖率
```

以 stdio 启动服务，并授权一个或多个写作目录：

```bash
export WRITING_MCP_ROOTS="/path/to/your/writing-projects"
pnpm start
```

```powershell
$env:WRITING_MCP_ROOTS = "C:\path\to\writing-projects"
pnpm start
```

`WRITING_MCP_ROOTS` 为必填项，多个根目录按平台路径分隔符分隔（Windows 用 `;`，Unix 用 `:`）。解析后的源文件与被穿透的符号链接/junction 都必须留在授权根内——越界的路径在读取之前就以 `PATH_NOT_ALLOWED` 拒绝。

派生索引写在源文件旁边的 `.writing-index/<workId>/` 下；书稿本身绝不被修改。删掉该目录，索引即从零重建。

在 MCP 客户端中指向构建产物：

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

## 一段真实响应

下面两块都是从本仓库提交的三文件合成工程 `fixtures/generic-novel/` 实测得到的输出，采集自源码构建的 `dist`，任何 MCP 客户端都能复现。过长的字段以 `…` 省略。

```jsonc
// writing_explore  { "workRef": "work:…", "operation": "search", "query": "铜钥匙", "limit": 3 }
{
  "revision": 1,
  "freshness": "fresh",
  "operation": "search",
  "results": [
    {
      "ref": "span:fe51910281f7c57c279bebec",
      "kind": "character",
      "title": "林秋",
      "sourceKind": "deterministic",
      "confidence": 1,
      "evidence": {
        "relativePath": "characters.md",
        "startLine": 3,
        "endLine": 5,
        "excerpt": "## 林秋\n\n林秋是调查员，随身携带一枚铜钥匙。",
        "evidenceHash": "afb424773a948012f12d855575b97f1096bdacf06411b48c0491eaf89acdb53d"
      }
    }
    // …另外两个 chapter span，结构相同
  ],
  "ambiguous": [],
  "truncated": false,
  "metrics": { "candidateCount": 3, "returnedCount": 3, "visitedNodes": 3, "maxActualHops": 0, "omittedEstimate": 0 },
  "diagnostics": [
    { "code": "QUERY_ANALYZED", "message": "Deterministic query analysis produced 1 term(s)" },
    { "code": "PRF_EXPANDED", "message": "Deterministic two-pass search added 8 bounded expansion term(s): 钥匙, 铜钥, 下档案, 地下档, 档案室, 下档, 下档案室, 北塔" }
  ]
}
```

一个中文查询命中了它从未分过词的文本：没有词典、没有分词模型、没有 embedding。`relativePath` 与 `startLine`/`endLine` 定位说法出处，`evidenceHash` 是对返回的 `excerpt` 逐字计算的 SHA-256，读者因此可以确认服务端没有转述。`diagnostics` 里列出了排序实际使用的扩展词——机制是可查验的，而不是被暗示的。

```jsonc
// writing_context  { "workRef": "work:…", "query": "铜钥匙 和 北塔 有什么关系？", "budgetTokens": 160 }
{
  "status": "complete",
  "revision": 1,
  "budgetTokens": 160,
  "usedTokens": 140,
  "estimated": true,
  "estimator": "mixed-cjk-v1",
  "accountingScope": "evidence_excerpts_only",
  "blocks": [
    { "layer": "L1", "kind": "character", "title": "林秋",  "tokens": 24, "required": false, "evidence": { "relativePath": "characters.md", "startLine": 3, "endLine": 5, "evidenceHash": "afb4247…" } },
    { "layer": "L1", "kind": "character", "title": "周岚",  "tokens": 23, "required": false, "evidence": { "…" : "…" } },
    { "layer": "L2", "kind": "chapter",   "title": "第一章 雨夜",  "tokens": 41, "required": false, "evidence": { "relativePath": "chapter-01.md", "…" : "…" } },
    { "layer": "L2", "kind": "chapter",   "title": "第二章 地下室", "tokens": 52, "required": false, "evidence": { "relativePath": "chapter-02.md", "…" : "…" } }
  ],
  "omitted": []
}
```

请注意 `usedTokens` 声称了什么、没声称什么：`estimated: true` 与 `accountingScope: evidence_excerpts_only` 意味着这个数值只计入返回的摘录——不含 ref、标题、定位器、遗漏项、诊断与 JSON 外壳——并采用公开的 `mixed-cjk-v1` 启发式估算。它是供外部 tokenizer 复核的材料，不是精确的模型 Token 数。每个 block 标注了它来自哪一层，`omitted` 列出没装下的内容与原因（这里是空的：全部装下了）。

这些文本一共 174 个字符，是合成 fixture。它们示范的是响应的*形状*与口径的诚实，说明不了长篇规模下的速度与质量。那部分门禁记录在 [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)。

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

`pnpm verify` 就是整条链，CI 在每次推送 `main` 与每个 pull request 上、在 ubuntu 与 windows 两个平台上运行它：

| 门禁 | 命令 | 阈值固定在 |
|---|---|---|
| 发布隐私门禁 | `pnpm privacy:gate` | 本地分支/标签可达的任一对象含被禁隐私标记即失败；*最先*运行，因此泄漏不可能只离 `main` 一个提交 |
| 严格类型检查 | `pnpm check` | `tsc -b` 且 `strict: true`；包源码中 `any` 注解为零、`@ts-ignore` 为零，两者都可 grep 核验 |
| 零警告 lint | `pnpm lint` | 对 `packages`、`tests`、`scripts` 运行 `oxlint --deny-warnings`——其中 `packages/core/src/store.ts` 仍在忽略清单里（它的密集排版触发了 oxlint 的压缩文件启发式；记为 AUD-035，解法是拆分该文件） |
| 测试 | `pnpm test` | 全量测试加文档契约测试；文件 → 主题映射见 [tests/README.md](tests/README.md) |
| 冻结公共基准 | `pnpm benchmark` | 30 个任务；事实召回下限 0.90、证据覆盖下限 1.00、Token 降幅下限 0.60 |
| 覆盖率棘轮 | `pnpm coverage` | lines 90%、statements 87%、functions 85%、branches 73% |

`pnpm benchmark` 在仓库 fixture 上是确定的，当前结果为 **30/30 任务通过、30/30 证据覆盖、事实召回 10/10、Token 降幅 0.669**（门禁为 0.60）——平均一个上下文包估算 55 Token，而整部 fixture 是 166 Token。用 `pnpm build && pnpm benchmark` 复现。

基准**不**测量的东西：正文质量、装配出的上下文包是否真能写出更好的一章、你的语料上的检索质量、精确的模型 Token 节省。它门禁的是检索正确性、证据可追溯性与摘录级 Token 口径，跑在已提交的 fixture 上。更大规模的语料门禁确实存在，但依赖未公开发布的材料，因此记录在 [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)，而不在本文件里声称。

## 仓库结构

```text
packages/
├─ core/                  # 存储、检索、PRF、上下文装配
├─ adapter-generic/       # Markdown / TXT / EPUB 适配器
├─ adapter-inkos/         # InkOS 项目结构适配器
├─ mcp-server/            # stdio 服务、五工具、诊断
├─ host-bridge/           # 面向浏览器宿主的可选 loopback bridge 运行时
├─ host-bridge-protocol/  # 冻结的宿主插件协议 v1（Zod + fixture）
└─ host-plugin-storyforge/# 首个受治理的静态宿主插件 manifest
tests/  docs/  scripts/  fixtures/
```

## 宿主集成插件

Writing MCP 刻意保持核心专注：宿主相关的集成以受治理的静态插件存在，不进入五工具公共契约。首个插件——面向浏览器写作宿主的本地 loopback host bridge——线上协议已冻结为 v1（[`packages/host-bridge-protocol`](packages/host-bridge-protocol)），规范 fixture 位于 [`fixtures/host-bridge-protocol`](fixtures/host-bridge-protocol)，运行时已实现在 [`packages/host-bridge`](packages/host-bridge)。Storyforge 联合启动与真实“浏览器 → Bridge → Writing MCP”验收链已经落地，包含失败关闭与显式单次绕过。任何宿主专属逻辑都不进入核心 MVP。

## 项目状态

分 M0～M5 五个阶段，下表使用的措辞就是 [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) 实际携带的措辞——那个文件是唯一事实源，本节只是它的摘要，不与之竞争：

| | |
|---|---|
| M0 协议与契约 | 基本完成（版本化契约、五工具 schema、统一信封、30 任务基准、Token 与事实基线） |
| M0.1 诊断 | 完成（全工具诊断包装器、显式捕获、脱敏、有界保留） |
| M1 适配器与边界 | 持续加固（授权根目录、InkOS/Markdown/TXT/EPUB、定位器与生命周期加固） |
| M2 索引与真实性 | 基础门禁完成（SQLite/FTS5 schema v4、revision、事务、原子替换、恢复） |
| M3 检索 | 基本完成（search/entity/neighborhood/document/stats、未分词中文查询分析、有界 BFS、timeline、确定的两趟 PRF） |
| M4 上下文装配 | 进行中——抽取与预算门禁已落地，Token 估算的外部 tokenizer 复核仍未完成 |
| M5 客户端验收 | 进行中——文档切片已落地，真实客户端连通与更多 EPUB/InkOS 变体尚未完成 |

本仓库没有任何部分是 v1 完整的：M3～M5 仍在推进，项目不做相反的声称。目前没有版本化发布标签、没有 GitHub release，包在 M4 外部 tokenizer 复核通过之前保持 `private: true`；首个 `v0.x` 跟随该门禁发布，而不是跟随某个日期。当前的下一步列在 [docs/IMPLEMENTATION_STATUS.md § 下一步](docs/IMPLEMENTATION_STATUS.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/CLIENT_SETUP.md](docs/CLIENT_SETUP.md) | Node/pnpm 前置、Qoder/Codex stdio 配置、首次调用、故障排查 |
| [docs/M0_CONTRACT.md](docs/M0_CONTRACT.md) | 冻结协议与数据契约：工具 schema、信封、诊断 |
| [docs/REFERENCE.md](docs/REFERENCE.md) | 工具语义与参数详解 |
| [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) | 里程碑状态、门禁证据、可追溯提交 |
| [docs/RELIABILITY_REPAIR_PLAN.md](docs/RELIABILITY_REPAIR_PLAN.md) | 2026-08-20 可靠性修复轮的冻结执行计划：分支纪律、红测先行规则、逐任务门禁（中文） |
| [docs/adr/](docs/adr) | 五份已接受的架构决策记录（确定性本地内核、EPUB 解析，以及 schema v2→v4 的证据模型演进） |
| [tests/README.md](tests/README.md) | 测试文件 → 主题覆盖映射 |
| [SECURITY.md](SECURITY.md) | 威胁模型边界、隐私保证覆盖到哪、如何上报漏洞（英文） |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 门禁链、红测先行惯例、文档纪律（英文） |

语言说明：本 README、[README.md](README.md)、`docs/M0_CONTRACT.md`、各 ADR、`SECURITY.md` 与 `CONTRIBUTING.md` 属英文一侧——`SECURITY.md` 和 `CONTRIBUTING.md` 只提供英文，因为 GitHub 会把它们呈现给可能不读中文的报告者与贡献者；`docs/CLIENT_SETUP.md`、`docs/REFERENCE.md`、`docs/IMPLEMENTATION_STATUS.md` 与 `docs/RELIABILITY_REPAIR_PLAN.md` 以中文撰写。`docs/M0_CONTRACT.md` 对线上行为具有规范性——译述与契约不一致时，以契约为准。

## 参与贡献

什么都不靠信任合入。一个改动可合入的判据是 `pnpm verify` 在它上面通过——包括文档契约测试，它检查配置示例既可解析又不含个人路径。依赖非公开材料的评估链（`pnpm verify:private`）只在状态文档里单独报告，绝不替代公共门禁。新行为先以失败测试的形式到来；测试与实现的先后顺序不是风格问题，而是一个门禁是否成立的前提。

设计与计划文档按惯例不进 Git：可执行的契约是已发布的 schema 加已提交的 fixture，而 `docs/IMPLEMENTATION_STATUS.md` 是唯一记录状态声明的地方。完整规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

Writing MCP 采用 GNU Affero General Public License v3.0 only（[LICENSE](LICENSE)）；第三方依赖遵循其各自许可证。
