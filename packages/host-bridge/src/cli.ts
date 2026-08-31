import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AUTH, PROTOCOL_VERSION } from "@writing-mcp/host-bridge-protocol";
import { createPairingManager } from "./auth.js";
import { acquireInstanceLock, InstanceLockError } from "./instance-lock.js";
import { createMcpClient } from "./mcp-client.js";
import { createBridgeServer } from "./server.js";
import { createBridgeState } from "./state.js";

export interface CliIo {
  stderr: { write: (chunk: string) => unknown };
  stdin: { once: (event: string, listener: () => void) => unknown; resume?: () => unknown };
  exit: (code: number) => void;
  signalOn: (event: string, listener: () => void) => unknown;
}

function defaultIo(): CliIo {
  return {
    stderr: process.stderr,
    stdin: process.stdin,
    exit: (code: number) => process.exit(code),
    signalOn: (event: string, listener: () => void) => process.on(event as NodeJS.Signals, listener),
  };
}

export interface ParsedCliArgs {
  root: string;
  port: number;
  mcpEntry: string;
  mcpRoot: string;
}

function parseArgs(argv: string[]): ParsedCliArgs | null {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) return null;
    values.set(flag.slice(2), value);
  }
  const root = values.get("root");
  if (root === undefined) return null;
  const portRaw = values.get("port");
  const mcpEntryRaw = values.get("mcp-entry");
  const mcpRootRaw = values.get("mcp-root");
  return {
    root: resolve(root),
    port: portRaw !== undefined ? Number(portRaw) : 48931,
    mcpEntry: mcpEntryRaw !== undefined ? resolve(mcpEntryRaw) : resolve(dirname(fileURLToPath(import.meta.url)), "../mcp-server/dist/index.js"),
    mcpRoot: mcpRootRaw !== undefined ? resolve(mcpRootRaw) : join(resolve(root), "projects"),
  };
}

/**
 * CLI entry: acquire the single-instance lock, start the MCP stdio child,
 * serve the loopback bridge, and print pairing codes to stderr only. Shutdown
 * is an idempotent chain triggered by SIGINT, SIGTERM, or stdin EOF.
 */
export async function runCli(argv: string[] = process.argv.slice(2), io: CliIo = defaultIo()): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    io.stderr.write("usage: writing-mcp-host-bridge --root <bridge-root> [--port 48931] [--mcp-entry <path>] [--mcp-root <path>]\n");
    io.exit(2);
    return 2;
  }
  let lock;
  try {
    lock = await acquireInstanceLock({ root: args.root, protocolVersion: PROTOCOL_VERSION });
  } catch (error) {
    if (error instanceof InstanceLockError) {
      io.stderr.write(`writing-mcp-host-bridge: instance lock held (${error.path}); another bridge instance is already running\n`);
      io.exit(3);
      return 3;
    }
    throw error;
  }

  const auth = createPairingManager({
    onCode: (code, reason) => io.stderr.write(`writing-mcp-host-bridge pairing code: ${code} (${reason}; valid ${Math.round(AUTH.pairingCodeTtlMs / 60000)} min)\n`),
  });
  const state = createBridgeState({
    countActiveSessions: () => auth.activeTokenCount(),
    onPluginStateChange: (next) => {
      if (next === "revoked") auth.revokeAll();
    },
  });
  const mcp = createMcpClient({
    command: process.execPath,
    args: [args.mcpEntry],
    env: { ...process.env, WRITING_MCP_ROOTS: args.mcpRoot },
  });
  mcp.onExit(() => state.setProcessState("degraded"));

  try {
    await mcp.start();
  } catch {
    io.stderr.write("writing-mcp-host-bridge: MCP child failed to start; check the built server entry\n");
    await lock.release();
    io.exit(2);
    return 2;
  }

  const server = createBridgeServer({
    auth,
    state,
    config: { port: args.port },
    log: (line) => io.stderr.write(`writing-mcp-host-bridge: ${line}\n`),
  });
  await server.listen();
  state.setProcessState("ready");

  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    void (async () => {
      state.setProcessState("stopped");
      await server.close();
      await mcp.stop();
      await lock.release();
      io.exit(0);
    })();
  };
  io.signalOn("SIGINT", shutdown);
  io.signalOn("SIGTERM", shutdown);
  io.stdin.once("end", shutdown);
  // A paused stdin never emits "end"; start flowing so EOF (client disconnect)
  // triggers the shutdown chain. The CLI consumes nothing from stdin.
  io.stdin.resume?.();
  await new Promise<void>(() => undefined);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  void runCli();
}
