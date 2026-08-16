---
name: writing-mcp-plan
description: writing-mcp monorepo 项目开发过程的标准操作手册。覆盖执行计划、中断恢复、门禁审计、AUD 修复顺序、文档导航和提交规则。**任何涉及 writing-mcp 的计划执行、实现修复、状态审计或提交决策时都必须首先调用此技能。**
version: 0.3.0
---

# Writing MCP 项目开发过程 Skill

本 Skill 是 writing-mcp 项目的**标准开发过程操作手册**：它告诉你在哪读什么、恢复时做什么、按什么顺序修、何时提交。**任何涉及本项目的开发工作都应首先调用此 Skill**，而不是手动读取计划文件。它不是契约本身——契约细节以各文档为准。

## 文档地图（先读这个，不清晰就点开原文）

| 主题 | 文档 | 何时必须读 |
|---|---|---|
| 执行计划（Step/门禁/AUD 顺序） | `E:\Programming\AI\Agents\Writing\.qoder\plans\Writing_MCP_Server_v2.md` | 每次动手前 |
| 项目定位/工具语义/架构 | `E:\Programming\AI\Agents\Writing\.qoder\plans\Writing_MCP_Server_README.md` | 理解工具/边界时 |
| 冻结契约（协议/schema/错误/基准） | `writing-mcp/docs/M0_CONTRACT.md` | 改接口/schema/验收前 |
| 实施状态（已闭环/已知限制/下一步） | `writing-mcp/docs/IMPLEMENTATION_STATUS.md` | 每次恢复核对 |
| 问题证据库（AUD-001~036） | `writing-mcp/docs/REVIEW_2026-08-15_CONSOLIDATED.md` | 决定修哪个 AUD 时 |
| 测试覆盖清单 | `writing-mcp/tests/README.md` | 新增/删除测试时 |
| 未来构想（非承诺） | `E:\Programming\AI\Agents\Writing\.qoder\plans\Writing_MCP_Server_IDEAS.md` | 评估扩展时 |

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

- **Step 1 索引事实性**：✅ 已闭环（`ccc36bc`，schema v3）
- **Step 2 图身份/顺序/证据**：✅ 已闭环（`6058075`，schema v4）
- **Step 3 检索基本正确性**：🔄 进行中——中文问句/歧义/排序/输入上限/FTS 诊断（`4030085`）+ AUD-021 源复用修复（`service.index()` 增加指纹记录，55/55 测试通过）+ 时间上限（`c376df7`）已完成；**剩余：BFS/locator 批量化（AUD-020）**、候选统计校准、timeline、章节时态过滤、完整重排
- **Step 4 诊断契约**：AUD-023~025
- **Step 5 渐进模块化并完成 M3**：AUD-015/016/022
- **Step 6 完成 M4**：AUD-005（requiredRefs 直解）→ 012/013/014
- **Step 7 完成 M5**：AUD-026~036

## 修复纪律

1. **先加失败回归测试，再实现**（计划 §5.4/§13.2 明确）。
2. 每完成一个 AUD 或子门禁：跑 `pnpm check` + 全量测试 + `pnpm benchmark`，三者通过才可继续。
3. 公共输出/schema 变化 → 更新 `M0_CONTRACT.md` 或新增 ADR；索引 schema 变化 → 走重建不迁移。
4. 诊断不变式：所有工具必须仍走统一诊断 wrapper；不得绕过。
5. 测试新增时同步更新 `tests/README.md` 的映射表。

## 提交规范（§13.2）

- 提交点：可独立回滚的 bug 修复、子门禁完成、计划方向调整、中断前稳定成果。
- 提交信息：标题 + 正文（动机/关键改动/验证结果）。
- **不提交**：本地真实书稿、私有标注、生成索引（`.writing-index/`）、`reports/`、未授权审查文件。

## 已知边界（别踩）

- vitest 在本会话沙箱下无法运行（spawn EPERM）——写测试后需在正常环境跑；`tsc -b` 与 node 直跑脚本可验证行为。
- 私有 `标注数据.json` 当前不在工作区，私有指标（41/42、88.10%）只作历史参考，不可复现。
- `REVIEW_2026-08-14.md`/`REVIEW_2026-08-15.md` 是未跟踪的局部审查，未确认来源前不作为正式基线提交。
- 不要为模块化重写已稳定工具注册/stdio；不引入动态插件。
