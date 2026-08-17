---
name: writing-mcp-plan
description: Execute the Writing MCP Server v2 implementation plan: recovery, gate probing, task routing, doc navigation, and commit rules for the writing-mcp monorepo at E:\Programming\AI\Agents\Writing\writing-mcp. Use when continuing implementation work, resuming after interruption, auditing plan-vs-code consistency, or deciding what to fix next.
version: 0.7.0
---

# Writing MCP 计划执行 Skill

本 Skill 由 `plan-to-skill` 元技能（v0.2.0）生成：先经步骤 0 计划审查（状态唯一、文件边界合格），再按生成规则产出。它是 `Writing_MCP_Server_v2.md` 执行计划的**操作手册**：在哪读什么、恢复时做什么、按什么顺序修、何时提交。不是契约本身——契约细节以各文档为准。

## 文档地图（先读这个，不清晰就点开原文）

| 主题 | 文档 | 何时必须读 |
|---|---|---|
| 执行计划（Step/门禁/任务顺序） | `E:\Programming\AI\Agents\Writing\.qoder\plans\Writing_MCP_Server_v2.md` | 每次动手前 |
| 项目定位/工具语义/架构 | `E:\Programming\AI\Agents\Writing\.qoder\plans\Writing_MCP_Server_README.md` | 理解工具/边界时 |
| 冻结契约（协议/schema/错误/基准） | `writing-mcp/docs/M0_CONTRACT.md` | 改接口/schema/验收前 |
| **实施状态（唯一事实源）** | `writing-mcp/docs/IMPLEMENTATION_STATUS.md` | **每次恢复核对；所有"当前状态"判断以此为准** |
| 问题库/审查（AUD-001~036） | `writing-mcp/docs/REVIEW_2026-08-15_CONSOLIDATED.md` | 决定修哪个 AUD 时 |
| 测试覆盖清单 | `writing-mcp/tests/README.md` | 新增/删除测试时 |
| 未来构想（非承诺） | `E:\Programming\AI\Agents\Writing\.qoder\plans\Writing_MCP_Server_IDEAS.md` | 评估扩展时 |

**状态单一事实源纪律**：`IMPLEMENTATION_STATUS.md` 是唯一状态文件。计划、README、REVIEW 文档**只引用它，不维护状态副本**。若发现其他文件记载了状态，以状态文件为准并修正该文件。

## 恢复协议（每次继续先做）

门禁命令来自 `writing-mcp/package.json`（真实 scripts，若文档与此不一致以 package.json 为准）：

```powershell
cd E:\Programming\AI\Agents\Writing\writing-mcp
git status --short          # 未提交改动？
git log -3 --oneline        # 最近提交与阶段
pnpm check                  # = tsc -b --pretty false
pnpm benchmark              # = pnpm build && node scripts/run-benchmark.mjs
pnpm test                   # = pnpm build && vitest run（含 build 前置）
```

核对四项：当前里程碑、最近通过门禁、未提交改动、真实 fixture/私有语料是否仍在。若计划或代码被外部修改，先做契合度审查再动手。

## 状态确定协议（替代一切静态进度快照）

> 目的：从"文档声称 + 机器门禁 + 代码事实"三方得出**可信当前状态**。本 skill 不保存状态快照；以下每次执行。

**输入**：唯一状态文件 + git + 门禁结果。

1. **读文档声称**：从 `IMPLEMENTATION_STATUS.md`「里程碑完成度」「可追溯提交清单」「下一步」读出各 Step/AUD 的声称状态。
2. **跑机器门禁**：`pnpm check && pnpm test && pnpm benchmark`，记录全绿/失败。
3. **核对代码事实**：对每个"声称已完成"的 AUD，用 grep 定位对应代码路径 + 回归测试存在性（按「任务代码锚点」表核对）。
4. **判定分类**：
   - 声称完成 + 门禁绿 + 代码/测试在 → **确认完成**
   - 声称完成但缺代码或测试 → **虚报完成**（修正状态，先补测试）
   - 代码/测试在但文档未记 → **超前完成**（回写状态文件，标记完成）
   - 文档标记未开发（M4/M5）→ **预期未完成**（不是缺陷，不进入路由候选）
5. **输出**：`{ 当前Step, 已关闭AUD集, 剩余AUD集, 漂移项[], 超前项[] }`，写入工作记忆（不落盘，不污染唯一状态源）。

## 精准路由协议（状态确定后，输出下一步）

**输入**：状态确定协议输出。**规则（可复现，同一输入必然同一结论）**：

1. **顺序主规则**：按 Step 1→7 推进，不跳步。Step N 未全关，不路由到 Step N+1 的 AUD。
2. **Step 内部**：按 AUD 编号升序修；每条路由输出 = `{ 目标AUD, 完成门禁(测试文件+必须新建的失败测试), 契约影响(是否需要 amendment/ADR) }`。
3. **超前项处理**：路由第一步永远是"回写状态文件"，把超前完成 AUD 标记完成。
4. **未开发里程碑特例**：M4/M5 的 AUD 不进入候选，除非前置 Step 门禁全关。
5. **契约影响判定**：公共输出/schema/错误码变化 → 必须带 amendment 或 ADR 一起路由；索引 schema 变化 → 走重建不迁移。
6. **开发中判定**：每次路由到修复前，先问"开发中还是已发布"——决定能否改契约、能否依赖 SDK 行为、失败形态是否保守。

## 任务代码锚点（路由判定用，非状态）

> 定位线索，不是状态。发现失效先更新本表再路由。

| Step | AUD/任务 | 代码锚点 | 回归测试 |
|---|---|---|---|
| 1 | 003/006/011/031 | `store.ts` freshness/snapshot/write-lock/.gitignore | `index-lifecycle.test.ts` |
| 2 | 001/002/007~010 | `store.ts` Chapter ID/entity_definitions/edge_evidence/span_locators | `graph-identity-evidence.test.ts` |
| 3 | 004/016/017/018/019/020/021 | `store.ts` analyzeQuery/entityRows/compareText/limits/FTS_DEGRADED/expandNeighborhood；`service.ts` ensureFresh | `search-correctness.test.ts`/`explore-bfs.test.ts`/`service-reuse.test.ts` |
| 4 | 023/024/025 | `diagnostics.ts` summarizeOutput/serial/rotate；`server.ts` handleDiagnosed | `diagnostics.test.ts`/`protocol-boundary.test.ts`(规划) |
| 5 | 015/016/022 | `store.ts` timelineRows/ENTITY_KINDS | `explore-bfs.test.ts`/`search-correctness.test.ts` |
| 6 | 005/012/013/014 | `store.ts` context requiredRefs 直解；`server.ts` reserved 参数 | `context-reserved-params.test.ts` |
| 7 | 026~036 | 适配器/安全/生命周期 | M5 未开始，暂无 |

## 修复纪律

1. **先写失败回归测试，再实现**（计划 §5.3/§13.2 明确）。
2. 每完成一个 AUD 或子门禁：跑 `pnpm check` + `pnpm test` + `pnpm benchmark`，三者通过才可继续。
3. 公共输出/schema 变化 → 更新 `M0_CONTRACT.md` 或新增 ADR；索引 schema 变化 → 走重建不迁移。
4. 诊断不变式：所有工具必须仍走统一诊断 wrapper；不得绕过。
5. 测试新增时同步更新 `tests/README.md` 的映射表。
6. **完成判定绑定机器门禁**：一个 AUD/Step 只有在门禁全绿 + 对应回归测试存在时才算完成；不得仅凭文档自述标记完成。
7. **闭环**：完成一个 AUD 后 → 更新唯一状态文件 → 重新跑状态确定 → 由精准路由给出下一目标。状态文件是唯一落盘点，工作记忆不落盘。

## 提交规范（§13.2）

- 提交点：可独立回滚的 bug 修复、子门禁完成、计划方向调整、中断前稳定成果。
- 提交信息：标题 + 正文（动机/关键改动/验证结果）。
- **不提交**：本地真实书稿、私有标注、生成索引（`.writing-index/`）、`reports/`、未授权审查文件。
- 提交后：在 `IMPLEMENTATION_STATUS.md` 的「可追溯提交清单」顶部追加一条（该清单是唯一宿主）。

## 已知边界

- vitest 在本会话沙箱下无法运行（spawn EPERM）——写测试后需在正常环境跑；`tsc -b` 与 node 直跑脚本可验证行为。
- 私有 `标注数据.json` 当前不在工作区，私有指标（41/42、88.10%）只作历史参考，不可复现。
- `REVIEW_2026-08-14.md`/`REVIEW_2026-08-15.md` 是未跟踪的局部审查，未确认来源前不作为正式基线提交。
- 不要为模块化重写已稳定工具注册/stdio；不引入动态插件。
- 门禁命令：`check`=tsc、`test`/`benchmark` 均含 `pnpm build` 前置（来自 package.json 实测）。
- 本 skill 由 `plan-to-skill` v0.2.0 生成；计划结构变化时按元技能步骤 0 重新审查并再生成，不手工改本文件维持。
