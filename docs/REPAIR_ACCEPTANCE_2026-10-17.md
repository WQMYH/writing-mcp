# W-MCP-001～025 修复验收证据映射

本文记录 2026-10-17 的初次验收及后续复核补遗，不是第二份进度表。实时状态只读 [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)。原始独立审查针对 `af78942`；初次 MR6 客户端验收代码为 `0759c76`、跨项目断言为 `02eb2b8`；后续在 `d457e07` 复现 W017 同 Bridge 竞态，撤回其全面关闭声明，见下方补遗。原始材料、私有报告和完整 Token 输入只留本机，不随本文件提交。

## 25 项最小闭环

表内“失败断言”描述修复前被新回归击中的产品行为；控制例、参数化变体和修复后的恢复步骤不额外冒充独立缺陷。回归行号对应本次代码版本。

| 编号 | 原触发与应保持的不变式 | 修复提交 | 生产落点与回归证据 |
|---|---|---|---|
| 001 | 多行追加后超 cap；现在追加前切分，全部 span 有界且原文/locator 可重组 | `38ab81d` | `core/text.ts`；`tests/span-hard-split.test.ts:32`，旧派生版本重算见 `:41` |
| 002 | UTF-16 切点出现半代理对；分片、SQLite、窗口、图路径、EPUB 标题保留完整补充字符，小 cap 明确报错 | `0f246b0` | `core/text.ts`、`core/store.ts`、`adapter-generic/epub.ts`；`tests/span-hard-split.test.ts:74`、`tests/search-correctness.test.ts:108`、`tests/epub.test.ts:78` |
| 003 | required 超预算时 optional 也被标必选不足；每项保留真实原因 | `f70f29d` | `core/store.ts`；`tests/context-required-refs.test.ts:18` |
| 004 | 恢复 required/pin 后 ref 同时在 blocks/omitted；保留显式请求且移除矛盾 duplicate | `f70f29d` | `core/store.ts`；`tests/context-required-refs.test.ts:50` |
| 005 | NFD 漏查/兼容字符串 owner；统一 NFC+trim+lowercase，兼容不同字符仍独立 | `043172e` | `core/text.ts`、`core/store.ts`；`tests/graph-identity-evidence.test.ts:96`、`:119`、`:136` |
| 006 | 正确 span 被召回但大小写窗口漏唯一专名；评分与原文位置匹配一致，不承诺多词全部露出 | `bd592b6` | `core/store.ts`；`tests/search-correctness.test.ts:22` |
| 007 | 热 rebuild 旧连接仍打开；新建前释放受管理 store，成功返回新文/磁盘一致，失败保留旧索引与指纹 | `806d942` | `core/service.ts`；`tests/service-reuse.test.ts:20`、`tests/source-snapshot-reliability.test.ts:158`。Win/Linux 功能通过；原 Linux WAL/sidecar 的逐系统调用因果未单独复原 |
| 008 | LIMIT 隐藏第二 owner；歧义按展示截断前的独立身份判定，歧义种子不走 BFS | `7682cc7` | `core/store.ts`；`tests/search-correctness.test.ts:40`、`:57` |
| 009 | 大小写或旧别名依赖漏刷新；收集全部相关定义别名，再统一规范化回扫 resolved/unresolved | `5a117d5` | `core/store.ts`；`tests/graph-identity-evidence.test.ts:39`、`:75`，增加/删除/改名与冷建对照 |
| 010 | trim 前言后源行号未推进；0/1/3 空行、BOM、LF/CRLF 主/子 locator 与后续章节正确 | `23be2c6` | `adapter-generic/txt.ts`；`tests/generic-txt.test.ts:12` |
| 011 | 新产生的实体再次解码；正文/元数据只解原始一层，非法数字实体明确失败 | `8595bee` | `adapter-generic/epub.ts`；`tests/epub.test.ts:29`、`:65` |
| 012 | 改 dossier 后 precedes/证据丢失；只刷新受影响引用边，顺序边与 noop/重开/冷建一致 | `5890d83` | `core/store.ts`；`tests/graph-identity-evidence.test.ts:197` |
| 013 | Chapter 累积旧题别名，冷建不同；冻结仅当前标题派生别名，非 Chapter 持久别名不误删 | `8330a78` | `core/store.ts`；`tests/graph-identity-evidence.test.ts:149`。v1 没有显式 Chapter alias 写入语法，不把人工改缓存当事实源 |
| 014 | href XML 实体/异引号导致静默漏章；引号匹配与单层属性解码，缺必需 spine 明确失败 | `a13e659` | `adapter-generic/epub.ts`；`tests/epub.test.ts:105`、`:131`、`:143`、`:161`、`:171` |
| 015 | entity score 缺省 0 导致邻居挤 seed；命名精确 2/部分 1，稳定 ref seed 2 | `7682cc7` | `core/store.ts`；`tests/search-correctness.test.ts:78`，limit=1/2；不是通用 seed-first 排序 |
| 016 | 有普通属性的 br 被删后正文拼接；各合法闭合/引号/属性形式保持换行 | `8595bee` | `adapter-generic/epub.ts`；`tests/epub.test.ts:38` |
| 017 | 初次修复实际 CLI 未接 capture callback；同 Bridge 在初查后落盘的竞态仍可删数据，另见补遗与最终检查 | 初次 `1006fdd`，后续提交见唯一状态 | `mcp-server/diagnostics.ts`、`host-bridge/cli.ts`、`host-bridge/snapshot.ts`、`host-bridge/mcp-client.ts`；`tests/host-bridge-cli-boot.test.ts:162`、`tests/host-bridge-e2e.test.ts:137`、`:172` |
| 018 | context 用显示 chapter_number、timeline 用位置；统一 1-based 源章节序，保留 layer/pin 优先级 | `ef21164` | `core/store.ts`、MCP 描述/M0；`tests/context-constraint-wiring.test.ts:42`，10/20 编号、重置与非章节穿插 |
| 019 | 重启后捕获校验先于注册，绕过恢复；相关请求先 resolve bridge-owned 作品，真 missing/closed 不重试 | `6421740` | `host-bridge/tool-proxy.ts`；`tests/host-bridge-cli-boot.test.ts:100`，child/full CLI 首个 explore、再次重启首个 finish、PID 与退出/锁证据 |
| 020 | 引号内 > 提前结束标签，属性残片混入正文；正文/标题/过滤元素按匹配引号移除标签 | `8595bee` | `adapter-generic/epub.ts`；`tests/epub.test.ts:43` |
| 021 | 多别名 JOIN 把同 owner 计成歧义；先按身份聚合，再判 owner 数与展示 LIMIT | `7682cc7` | `core/store.ts`；`tests/search-correctness.test.ts:57` |
| 022 | 默认 CLI entry 少一级目录；编译布局默认/显式入口 × 仓库/其他 cwd 均 ready/EOF/exit0/释放锁 | `8af5dfb` | `host-bridge/cli.ts`；`tests/host-bridge-lifecycle.test.ts:215`，无空 PID 集合关闭证明 |
| 023 | status 展开内部 indexRevision，不合 strict schema；只投影既有公开字段，不放松 schema | `8af5dfb` | `host-bridge/snapshot.ts`；`tests/host-bridge-e2e.test.ts:228`、`:273`，fresh/restore HTTP data（位置随补遗新增测试后更新） |
| 024 | entity LIKE 未转义反斜杠；复用 literalLikePattern，%、_、反斜杠匹配字面量且 owner 独立 | `7682cc7` | `core/store.ts`；`tests/search-correctness.test.ts:98` |
| 025 | JSON Schema 码点与 Zod/core UTF-16 长度分歧；统一 query/taskType/label/四份 refs 的码点域 | `648895e` | `core/text.ts`、`core/store.ts`、`mcp-server/server.ts`、`mcp-server/diagnostics.ts`；`tests/unicode-input-limits.test.ts:17`、`:60`，真实 SDK BMP/补充/混合下界/恰好/超一 |

## 验收口径

- MR1～MR5 各阶段完整本机/Windows/Linux 门禁见唯一状态文件的提交清单。MR5 最后产品修复 `6421740` 对应 CI [38934125779](https://github.com/WQMYH/writing-mcp/actions/runs/38934125779)，不是复用 MR4 的 396 项记录。MR6 `0759c76` 对应双平台 CI [38934729394](https://github.com/WQMYH/writing-mcp/actions/runs/38934729394)，最终 `02eb2b8` 对应双平台 CI [38935521968](https://github.com/WQMYH/writing-mcp/actions/runs/38935521968)，均 completed/success；本机完整 verify 等价展开仅为测试增加原生 JSON reporter，58 文件/409 项、0 失败/0 跳过、公开 30/30、coverage lines 91.21%/branches 79.91%，既有门禁未下调。
- MR6 `tests/mcp-stdio.test.ts:25` 经真实 SDK stdio 走全部五工具、改源、stale、incremental、rebuild、进程重启后 resolve、关闭后删除自有派生索引及完整重建。逐次检查原文摘录、revision、稳定 ref、去除旧标记、诊断持久化和 accountingScope。
- 原始 108 项缺口以 checkpoint ZIP 中 `inventory/remaining-gaps.json` 的物理文件路径 + 原始 fullName 为键，对比本次 Vitest 原生 JSON：106 项原名通过，2 项明确审阅的替代组通过，未匹配 0。替代组分别是旧 CLI EOF/health 脱敏例→4 个入口/cwd 例（保留全部旧断言），以及旧 incremental 失败例→incremental/rebuild 两种失败例（保留磁盘旧内容/revision、stale 与后续恢复断言）。不以相似名称或总数强行关闭，不倒推历史 canonical pass。
- 私有黄金与产品门禁分别统计：top-20 42/42、required 16/16、证据关联覆盖 1.0；完整引文露出 36/42 不是 42/42。MR2 正确分片下黄金 @5/MRR 的重校准已有单变量对照与用户接受，仅 `gold:update` 更新过快照；本轮其余 gate/check 都不写基线。
- 本机超大语料解析 4,789,903 字符：rebuild 56,586ms、每百万字符 11,814ms，暖 Explore P95 54.71ms、Context P95 4.32ms；阈值依次为 60,000/1,000/500ms，未放宽。任务集合是有限代表性查询，不证明任意查询或其它机器均同延迟。
- 外部 Python tiktoken 0.13.0 对本地冻结材料独立测量：cl100k_base 最低完整 packet 降幅 99.9540%，o200k_base 最低 99.9458%，三项 context 都非空，超过 95% 材料门禁。比较的是解析后整书输入和序列化 ContextPacket，不含 Agent 其他提示、工具定义、JSON-RPC framing、真实模型账单或 credits；MCP 本身仍只返回 evidence-excerpts-only 启发式估算。

本机未跟踪的工作区 `reports/2026-10-16-writing-mcp-independent-review/` 保存：`mr6-vitest.json`（完整原生回执）、`mr6-capture-boundary-vitest.json`（最终捕获补强）、`mr6-original-gaps-reconciled.json`（全部原名与两个明确替代组）、`mr5-gold-gate.json`/`mr5-gold-check.json`/`mr5-private-gate.json`（产品代码不再变化后的私有结果）、`mr6-corpus/corpus-benchmark-report.json`/`token-evaluation-materials.json` 与 `mr6-external-token-report.json`。最后三份材料不上传，公开记录只包含汇总数值。

既有 `writing-mcp-plan` 本机执行技能仅校准文档路由、授权连续执行与实际工作树解释，增加 MR0～MR6 计划/本记录入口；入口缺失先验证失败，修正后路径与单一状态源检查通过，UTF-8 模式的官方 quick_validate 通过。没有新增技能框架、子智能体行为评测或额外治理服务。

## 独立复核补遗：W017 同 Bridge 交错

- 在 `d457e07` 上用真实 restartable MCP child、pipeline、proxy、HTTP 调用和真实 inspect，仅读后 barrier 固定交错：inspect 返回 0 → 同项目 start_capture 成功且读回 active meta → 释放 barrier → DELETE 返回 200，project/index/meta 全消失且 child 被替换。本机原生失败回执为 `w017-race-red.json`，不是静态可达性或假 count 的断言。
- 根因是第一次数量检查早于 maintenance admission 关闭。HTTP 工具调用不经过 DELETE 的项目 mutex，因此“只有独立外部 writer 不受保护”的原说明不足以覆盖这个同 Bridge 反例。
- 修复复用现有 maintenance：关闭 admission → drain 已接纳调用 → 通过仍存活的独占 child 再 inspect → 无捕获才 stop/remove/restart。最终检查发现活动捕获或失败时不停止旧 child，释放 admission、返回 `DERIVED_DATA_BUSY`。CLI 直接使用该独占 invoker，避免回到普通 admission 造成自锁；代码有对应 why 注释。
- `tests/host-bridge-e2e.test.ts:172` 覆盖上述捕获先完成交错，要求 HTTP 409、project/index/meta/原 child 全保留并可 finish。`:137` 覆盖删除先封 admission，要求新 start_capture 返回既有 HTTP 503 / `BRIDGE_MCP_UNAVAILABLE`，其他项目已活动的捕获不误挡删除、重启后仍可 finish。两项先失败再修复；第二项还复现并修正了 admission 错误被 HTTP 层误标 500/SNAPSHOT_INVALID。
- 修复提交 `9d3ada3`：针对性 24 项与完整 pnpm verify 58 文件/411 项、公开 30/30、coverage lines 91.32%/branches 80.16% 通过；[CI 38942293970](https://github.com/WQMYH/writing-mcp/actions/runs/38942293970) 的 Windows/Linux 均 completed/success，绑定该代码提交，不复用旧 409 项结果。PR 正文已同步并读回确认仍 Draft、旧 MR2 in progress 已清除。
- 不修改检索/排序/预算，未重复私有、超大语料或 tokenizer 测量；上文数值仍绑定原提交，不声称这轮重测。没有新增工具、依赖、锁框架、自动重试或超时 RPC 服务端取消保证。

## 保留边界

- 原始书稿是唯一事实源；索引及诊断可重建，不引入创作生成、内容写回、模型调用、运行时学习或动态插件市场。
- mtime/size 都未变化的原地改写仍是 freshness 明示边界；外部/非合作 SQLite 占用仍可能 `INDEX_BUSY`；不宣称任意跨进程快照事务。
- 捕获计数来自持久元数据，坏元数据失败关闭。Bridge 删除与独立外部 capture writer 之间不提供跨进程事务；不得将一次顺序检查声称为全局并发互斥。
- Storyforge 实际 UI、浏览器 PNA、Windows junction、macOS 与完整 EPUB 2/3/DRM 变体不是这些合成/双平台测试的通过项。SDK/HTTP/CLI 工程验收不等于小说内容质量或用户最终使用验收。
- Draft PR 保持不合并 main；完整本地证据、机器回执与报告路径由唯一状态文件引用。
