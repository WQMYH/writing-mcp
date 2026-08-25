# Writing MCP v1 客户端配置（stdio）

本页是 v1 的**本地 stdio** 客户端配置说明。它只描述已实现的五个 MCP 工具；不要求安装客户端扩展，不启动 HTTP 服务，也不代表更广泛的 M5 验收已经完成。

## 前置条件

- Node.js 24.x（项目使用内置 `node:sqlite`）；确认 `node --version` 的主版本是 24。
- pnpm 11+。
- 一个已获授权的本地作品目录。下文以 `<authorized-writing-root>` 表示，必须替换为你的实际目录；不要保留尖括号。

在仓库根目录执行：

```powershell
pnpm install
pnpm build
```

构建产物是 `packages/mcp-server/dist/index.js`。本 v1 只通过 stdio 运行：客户端启动 `node` 子进程，并把 JSON-RPC 写入 stdin、从 stdout 读取；不要把 stdout 用作日志通道。

`WRITING_MCP_ROOTS` 是必填授权边界。它可列出一个或多个目录，Windows 用 `;` 分隔、Unix 用 `:` 分隔。来源文件和被遍历的 symlink/junction 都必须留在这些根目录内。

## 客户端配置

以下两个占位符都必须替换：`<repo-root>` 是已构建仓库的绝对路径，`<authorized-writing-root>` 是允许检索的作品根目录。示例故意不用真实个人路径。

### Qoder（JSON）

将下列条目放入 Qoder 的 MCP servers JSON 配置中：

```json
{
  "mcpServers": {
    "writing-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["<repo-root>/packages/mcp-server/dist/index.js"],
      "cwd": "<repo-root>",
      "env": {
        "WRITING_MCP_ROOTS": "<authorized-writing-root>"
      }
    }
  }
}
```

Windows 路径也可以写成 JSON 双反斜杠。若授权多个根，请在 `WRITING_MCP_ROOTS` 中使用 `;`，而不是 JSON 数组。

### Codex（TOML）

将下列配置加入 Codex 的 MCP TOML 配置：

```toml
[mcp_servers.writing-mcp]
command = "node"
args = ["<repo-root>/packages/mcp-server/dist/index.js"]
cwd = "<repo-root>"

[mcp_servers.writing-mcp.env]
WRITING_MCP_ROOTS = "<authorized-writing-root>"
```

配置变更后重新启动客户端会话，使其启动新的 stdio 进程。

## 首次调用路由

`workRef` 只在当前 server 进程中有效；每次重启客户端都从 `writing_resolve` 开始。推荐的最小诊断路由是：

1. `writing_resolve`：传入位于 `<authorized-writing-root>` 下的 `sourcePath`，保存返回的 `workRef`。
2. `writing_index(status)`：用该 `workRef` 检查索引是否存在、是否为 `fresh`，以及是否报告 `stale`。
3. 若需要索引或需更新，调用 `writing_index` 的 `rebuild` 或允许的增量操作；不要猜测或复用其他进程的 `workRef`。
4. `writing_diagnose(inspect)`：传入同一个 `workRef`，检查可观察的索引与诊断摘要。
5. 只有上述状态明确后，再调用 `writing_explore` 或 `writing_context`。

成功和失败响应都带有简明诊断。`writing_diagnose(inspect)` 用于检查当前可见状态，不会替你建立跨进程会话。

## 七类常见故障与处理

| 症状或诊断 | 含义 | 处理 |
|---|---|---|
| 命令无法识别 | 客户端尝试运行未安装的全局命令。 | 使用配置中的 `node <repo-root>/packages/mcp-server/dist/index.js`，不要假设全局命令存在。 |
| dist 尚未构建 | `packages/mcp-server/dist/index.js` 不存在或版本过期。 | 在 `<repo-root>` 运行 `pnpm build`，再重启客户端。 |
| 授权根拒绝（`ROOTS_NOT_CONFIGURED` / `SOURCE_OUTSIDE_ROOT`） | 未设置 `WRITING_MCP_ROOTS`，或路径及其链接解析后落在授权根外。 | 设置实际授权根；不要绕过边界。`SOURCE_NOT_FOUND` 则应修正 `sourcePath` 并确认读取权限。 |
| `INDEX_BUSY` | 另一个 Writing MCP 进程正持有合作式 writer lock。 | 等待该写入完成后重试；不要删除 `.writing-index` 或 lock 文件。 |
| workRef 失效（`WORK_REF_NOT_FOUND`） | `workRef` 不属于当前进程，通常是客户端已重启。 | 再次调用 `writing_resolve`，不要缓存旧 `workRef`。 |
| stdout 污染 | server 或包装脚本向 stdout 写入日志，破坏 JSON-RPC 帧。 | 业务日志只写 stderr；移除 `console.log`、shell banner 或其他 stdout 输出后重启。 |
| 诊断报告位置与隐私 | 需要追溯调用，但不应泄漏创作正文或个人路径。 | 报告位于 `.writing-index/<workId>/diagnostics/`；默认不保存正文、查询文本、绝对路径、堆栈、SQL 或凭据。 |

## 诊断与隐私

每次调用可在作品派生的 `.writing-index/<workId>/diagnostics/` 下生成脱敏的每调用报告及有界 JSONL 事件。默认诊断不保存正文、不保存查询文本、不保存绝对路径、堆栈、SQL 或凭据；仅保存 MCP 可观察的摘要，如工具、结果状态、耗时、revision、证据引用、截断与 Token 指标。

如需小规模本地开发捕获，使用 `writing_diagnose` 的 `start_capture` 取得 `diagnosticRunRef`，将它传给后续调用，最后用 `finish_capture` 结束。只有显式选择 `contentPolicy: "query"` 才允许在该本地捕获中保存查询文本；它仍不保存正文或绝对路径。请把诊断目录当作本地开发数据，并按项目数据治理要求处理。

## v1 边界

v1 是本地 stdio 集成：五工具、受授权 roots 限制、进程内 `workRef` 与可检查诊断。它不承诺 HTTP 传输、托管服务、自动客户端安装、跨进程 `workRef`、真实 InkOS 全覆盖或所有 EPUB 2/3 变体。
