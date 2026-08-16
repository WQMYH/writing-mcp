---
name: writing-mcp-plan
description: Execute the Writing MCP Server v2 implementation plan: recovery, audit, milestone gates, AUD fix order, doc navigation, and commit rules for the writing-mcp monorepo at E:\Programming\AI\Agents\Writing\writing-mcp. Use when continuing implementation work, resuming after interruption, auditing plan-vs-code consistency, or deciding what to fix next.
version: 0.4.0
---

# Writing MCP 计划执行 Skill

本 Skill 是 `Writing_MCP_Server_v2.md` 执行计划的**操作手册**：它告诉你在哪读什么、恢复时做什么、按什么顺序修、何时提交。它不是契约本身——契约细节以各文档为准。

## 文档地图（先读这个，不清晰就点开原文）

| 主题 | 文档 | 何时必须读 |
|---|---|---|
| 执行计划（Step/门禁/AUD 顺序） | `E:\Programming\AI\Agents\Writing\.qoder\plans\Writing_MCP_Server_v2.md` | 每次动手前 |
| 项目定位/工具语义/架构 | `E:\Programming\AI\Agents\Writing\.qoder\plans\Writing_MCP_Server_README.md` | 理解工具/边界时 |
| 冻结契约（协议/schema/错误/基准） | `writing-mcp/docs/M0_CONTRACT.md` | 改接口/schema/验收前 |
| **实施状态（唯一状态文件）** | `writing-mcp/docs/IMPLEMENTATION_STATUS.md` | **每次恢复核对；所有"当前状态"判断以此为准** |
| 问题证据库（AUD-001~036） | `writing-mcp/docs/REVIEW_2026-08-15_CONSOLIDATED.md` | 决定修哪个 AUD 时 |
| 测试覆盖清单 | `writing-mcp/tests/README.md` | 新增/删除测试时 |
| 未来构想（非承诺） | `E:\Programming\AI\Agents\Writing\.qoder\plans\Writing_MCP_Server_IDEAS.md` | 评估扩展时 |

**状态单一事实源纪律**：`IMPLEMENTATION_STATUS.md` 是唯一状态文件。计划、README、REVIEW 文档**只引用它，不维护状态副本**（测试计数、里程碑状态、AUD 关闭、提交清单）。若发现其他文件记载了状态，以状态文件为准并修正该文件——历史教训见下文「已发现的问题」。

## 恢复协议（Step 0，每次继续先做）

```powershell
cd E:\Programming\AI\Agents\Writing\writing-mcp
git status --short          # 未提交改动？
git log -3 --oneline        # 最近提交与阶段
pnpm check                  # tsc 类型检查
pnpm benchmark              # 30/30 门禁
```

核对四项：当前里程碑、最近通过门禁、未提交改动、真实 fixture/私有语料是否仍在。若计划或代码被外部修改，先做契合度审查再动手。

## 执行顺序（以计划 §8 为准，勿跳步）

> 状态随 `IMPLEMENTATION_STATUS.md` 更新；以下是最后一次核对时的进度。

- **Step 1 索引事实性**：✅ 已闭环（`ccc36bc`，schema v3）
- **Step 2 图身份/顺序/证据**：✅ 已闭环（`6058075`，schema v4）
- **Step 3 检索基本正确性**：🔄 进行中——中文问句/歧义/排序/输入上限/FTS 诊断（`4030085`）+ AUD-021 源复用（`c376df7` + 修复 `2e07df2`）+ AUD-018 响应字节上限（`3aee442`）已完成；AUD-020（BFS 批量取边）与 AUD-015（timeline 独立投影）主体已落地；**剩余：候选统计校准、章节时态过滤、完整重排**
- **Step 4 诊断契约**：AUD-023~025
- **Step 5 渐进模块化并完成 M3**：AUD-022 已落地（词汇表冻结）；剩余 AUD-016 相关与重排
- **Step 6 完成 M4**：AUD-005（requiredRefs 直解）✅ 已提前落地；剩余 AUD-012/013/014
- **Step 7 完成 M5**：AUD-026~036

## 修复纪律

1. **先加失败回归测试，再实现**（计划 §5.3/§13.2 明确）。
2. 每完成一个 AUD 或子门禁：跑 `pnpm check` + 全量测试 + `pnpm benchmark`，三者通过才可继续。
3. 公共输出/schema 变化 → 更新 `M0_CONTRACT.md` 或新增 ADR；索引 schema 变化 → 走重建不迁移。
4. 诊断不变式：所有工具必须仍走统一诊断 wrapper；不得绕过。
5. 测试新增时同步更新 `tests/README.md` 的映射表。
6. **完成判定绑定机器门禁**：一个 AUD/Step 只有在 `pnpm check && pnpm test && pnpm benchmark` 全绿 + 对应回归测试存在时才算完成；不得仅凭文档自述标记完成。

## 提交规范（§13.2）

- 提交点：可独立回滚的 bug 修复、子门禁完成、计划方向调整、中断前稳定成果。
- 提交信息：标题 + 正文（动机/关键改动/验证结果）。
- **不提交**：本地真实书稿、私有标注、生成索引（`.writing-index/`）、`reports/`、未授权审查文件。
- 提交后：在 `IMPLEMENTATION_STATUS.md` 的「可追溯提交清单」顶部追加一条（该清单是唯一宿主）。

## 已知边界（别踩）

- vitest 在本会话沙箱下无法运行（spawn EPERM）——写测试后需在正常环境跑；`tsc -b` 与 node 直跑脚本可验证行为。
- 私有 `标注数据.json` 当前不在工作区，私有指标（41/42、88.10%）只作历史参考，不可复现。
- `REVIEW_2026-08-14.md`/`REVIEW_2026-08-15.md` 是未跟踪的局部审查，未确认来源前不作为正式基线提交。
- 不要为模块化重写已稳定工具注册/stdio；不引入动态插件。

## 已发现的问题（历史教训，2026-08-16 记录）

以下是从审阅中发现的真实问题，**每次恢复与审阅时都要警惕重演**：

1. **状态多源漂移（实质缺陷，已收敛）**
   - 症状：测试计数曾在 4 个文件里各写各的（计划 13、README 14、状态 15、旧 review 12）；AUD 关闭状态在计划/状态/review 三处可能矛盾。
   - 根因：完成判定靠人维护文本，未绑定机器门禁；状态散落多文件。
   - 处置：`IMPLEMENTATION_STATUS.md` 定为唯一状态文件；计划/README 已改为引用；若再发现别处记载状态，以状态文件为准并修正。
2. **虚报完成（AUD-021）**
   - `c376df7` 声称"源指纹复用已落地"，但 `service.index()` 未记录指纹，`ensureFresh` 在 `previous === undefined` 时跳过增量更新——"编辑后 explore 看不到新内容"，对应测试失败。`2e07df2` 修复。
   - 教训：完成声称必须能由失败回归测试证伪。
3. **漏报完成（代码超前于计划）**
   - AUD-005（requiredRefs 直解）、AUD-015（timeline 独立投影）、AUD-020（BFS 批量取边）、AUD-022（词汇表冻结）均已实现，但计划/旧 review 仍列为"待做"。
   - 教训：文档可能落后于代码；审阅时先核对代码事实，再相信文档状态。
4. **审阅框架错误（本次记录）**
   - 曾把"计划中明确排在后面的未开发里程碑（M4/M5）门禁"当作"应该已完成却未完成"来审阅并打 ❌——这是错误框架。**未开发里程碑的门禁未关闭是预期状态，不是缺陷**；只有"声称完成但实际未完成"才是真问题。
   - 教训：审阅前先确认某 AUD/Step 在计划中的预期状态，再判定"未落实"是缺陷还是正常。
5. **M4/M5 尚未开发（现状）**
   - M4（AUD-012/013/014 剩余）、M5（AUD-026~036）按计划未开始；除 AUD-005 已提前落地外，其余门禁未关闭是预期状态，不视为回归。
6. **开发中修复 ≠ 已发布修复（AUD-025 落地时的方法论差异，2026-08-16）**
   - 场景：设计 AUD-025（协议层校验边界）落地方案时，一开始按"已发布程序"的约束想（不能动契约、最小化行为变化、防御性双校验），用户点出**这是开发中修复**——方案立即不同。
   - 差异清单：
     | 维度 | 已发布程序修复 | 开发中修复（本项目） |
     |---|---|---|
     | 契约 | 已冻结，不能动 | **可经 M0_CONTRACT amendment 修订** |
     | 行为变化 | 最小化，怕破坏兼容 | **允许改变**（失败形态可升级为结构化错误） |
     | SDK 内部行为 | 不能依赖 | **可以依赖并用测试锁定**（如 SDK mcp.js L193：`result.isError` 时跳过 output 校验） |
     | 校验策略 | 防御性双校验（wrapper + SDK） | **单点所有权**（校验收进 wrapper，利用 isError 短路让 SDK 不二次触发） |
     | 测试 | 实现后补 | **测试先行**（先写失败测试锁定依赖行为，再实现） |
   - 本项目是开发中修复：**每次设计修复方案前先问"这是开发中还是已发布"**——决定能否改契约、能否依赖 SDK 行为、失败形态是否要保守。
   - AUD-025 落地要点（开发中形态）：output 校验由 server wrapper 在记录 success 前执行，失败返回 `OUTPUT_VALIDATION_FAILED` + traceId 的 `isError:true` 结果（SDK 因 isError 短路不二次校验，诊断与客户端错误一致）；输入校验失败（客户端参数错，非服务端 bug）保持 SDK 前置拒绝并记录为已知限制，不进诊断链。
   - 教训：**"我们拥有这个代码库、契约未冻结"是开发中的最大自由**——不要用已发布程序的保守约束限制自己；反过来，也不要因为可改就轻率改契约（仍需 amendment + 测试）。
