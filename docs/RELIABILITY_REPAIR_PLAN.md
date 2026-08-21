# Writing MCP 可靠性修复执行计划

> 冻结日期：2026-08-20  
> 权威来源：用户批准的“Writing MCP 可靠性修复计划（审查定稿）”  
> 状态来源：`docs/IMPLEMENTATION_STATUS.md`

## 全局约束

- 在 `fix/reliability-hardening` 隔离分支执行；每个阶段性修复独立提交，提交正文包含动机、关键改动和验证结果。
- 行为变更严格执行 TDD：先观察覆盖真实行为的测试失败，再写最小实现。
- 私有书稿、标注、索引、Token 材料和本地报告不得提交。
- `verify`、`gold:gate`、`gold:check` 及所有 `verify:*` 命令不得修改已跟踪文件；只有 `gold:update` 可以更新黄金快照。
- 所有公共工具继续经过统一诊断 wrapper；公共 schema、错误码或响应语义变更必须同步 M0 contract amendment。
- 每个任务完成后运行任务级测试；提交前运行 `pnpm verify`。涉及私有召回、PRF 或长篇语料时追加对应 private gate，最终按 Task 7 运行完整 public/private 门禁。
- 100% 证据覆盖只表示证据定位存在；Token 指标必须标明估算范围，不得冒充外部 tokenizer 结论。

## Task 1：适配器级 SourceSnapshot 与双指纹 freshness

- 新增 `SourceSnapshotEntry` 与 `SourceSnapshot`，由每个 `WorkAdapter.snapshot(candidate)` 精确枚举实际读取文件。
- entry 保存完整相对路径、内部绝对路径、size、mtimeNs；fingerprint 按相对路径稳定排序。
- `load(candidate, snapshot?)` 读取 snapshot 的精确文件集合，并在读取时重新 realpath、校验授权根和 stat。
- `loadConsistent` 使用同一适配器 snapshot 做前后检查，变化时重试一次，再返回 `SOURCE_CHANGED_DURING_READ`。
- EPUB snapshot 只记录外层 EPUB；mtime/size 同时不变的原地替换作为明确限制保留。
- 服务状态改为 `store + loadedFingerprint + indexedFingerprint`：stale/missing/incompatible 不提交 indexed；incremental/rebuild 或 fresh status 才提交 indexed。
- 新 store 索引失败必须恢复旧 store 和两个旧 fingerprint；status stale 后的 explore/context 必须触发增量更新。
- 覆盖单文件、深目录、重名相对路径、增删、symlink 越界、读取中变化、失败注入和状态组合。

## Task 2：实验隔离与只读门禁

- 删除生产检索对 `WRITING_MCP_ABLATE` 的读取；新增 evaluator-only 调用级 `SearchExperimentOptions` 与 `WritingService.evaluateSearch`。
- 实验入口只供 core 评测脚本使用，不进入 MCP schema、Zod、工具描述和普通 explore/context。
- ablation 改为单次建索引、多变体评测；证明环境变量不影响生产路径且注入能产生变体差异。
- 修复 `gold-hit.mjs` lint；新增 `verify`、`gold:gate`、`gold:check`、`gold:update`、`private:measure`、`verify:private:pre-prf`、`verify:private`。
- 将黄金计算与快照写入拆开；任何 verify 命令运行后 Git diff 必须不变。
- corpus 门禁机器检查索引 ≤60 秒/百万字、Explore P95 ≤1000ms、Context P95 ≤500ms；另输出本地、未跟踪的外部 Token 复核材料，未复核时标为 `not_evaluated`。
- 立即更新实施状态、v2 计划、M0 契约、测试清单和运行 skill，消除 lint、私有语料位置、M4 完成度等漂移。

## Task 3：图与上下文契约硬化

- 将 `mentions` 加入冻结 `EdgeKind`/`EDGE_KINDS` 与文档，方向固定为 Document/Span → Entity，并覆盖方括号别名和 BFS 证据路径。
- `ContextPacket` 增加 `accountingScope: "evidence_excerpts_only"`；同步类型、schema、工具描述、契约和包形状测试。

## Task 4：响应字节上限

- `structuredContent.result` 最大 200000 UTF-8 bytes；诊断预留 8192 bytes；Markdown fallback 最大 16384 bytes。
- 用 8192-byte 合成诊断占位符先裁业务 data，recorder 只记录最终 data，再装配有界诊断。
- explore 先裁 ambiguous 再裁结果；context 从可选 L3 向上裁并记 `response_limit`，required 无法容纳返回 `RESPONSE_TOO_LARGE`；resolve 稳定裁候选；diagnose 裁 recent events。
- core 预裁剪使用 `Buffer.byteLength`，server 执行最终契约。200000 只约束 structured result，Markdown 独立受限。

## Task 5：EPUB、诊断留存与生命周期

- EPUB OPF/XHTML 上限统一按 UTF-8 byteLength，覆盖中文多字节边界。
- 诊断目录使用缓存估算；每 64 次写或新增 1 MiB 扫描。按 mtime→文件名清理 per-call reports、再清已关闭 capture，永不删除 active capture。
- 使用合作式跨进程清理锁；100 MiB 是最终收敛目标，允许并发进程短暂超限并如实报告。
- SIGINT、SIGTERM、stdin EOF 共用幂等 terminationPromise，等待 server/service 关闭，5 秒仅作兜底。

## Task 6：PRF 候选层改进

- 先提交 M0 amendment，冻结 PRF 为确定性 search 候选扩展，不改变 Agent/MCP 边界。
- 单轮两遍：第一遍基线；从 top-k `{5,8,12}` heading/excerpt 提词；过滤原词、别名、停用词、单字，要求至少两个 top span 共现；按 rank-weighted co-occurrence 预排并截到 128，再以三字精确 FTS vocabulary DF/其他长度保守 DF 加权，词数 `{4,6,8}`；第二遍权重 `{0.15,0.25,0.35}`。
- train 先淘汰 recall@5、recall@10、MRR、recall@50、required@50 任一回退的配置，再按 recall@5、MRR、低复杂度选唯一配置；holdout 只验证。运行时严禁读取 expectedTerms、expectedChapters、evidenceQuotes、gold refs。
- 成功门禁：公开 30/30；train/holdout recall@5、recall@10、MRR、recall@50 与 required@50 不退；私有 top-20 recall ≥90%、required=1；性能与确定性通过。当前接受配置 `12/8/0.35`，Context 内部池为 12。
- 无配置满足时不降低门禁、不发布 PRF。代码先提交，再显式 `gold:update` 并用第二个提交归档基线和被测代码哈希。

## Task 7：最终复审与交付

- 运行 `pnpm verify`、`pnpm verify:private:pre-prf`、PRF 后 `pnpm verify:private`；保存但不提交外部 tokenizer 材料。
- 核对 Git diff、M0 契约、实施状态、v2 计划、测试清单和运行 skill 一致。
- 对整分支做代码审查，修复 Critical/Important 后再进入分支集成流程。
