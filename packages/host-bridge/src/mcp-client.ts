import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { TIMEOUTS } from "@writing-mcp/host-bridge-protocol";

export interface McpClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stderrLimitBytes?: number;
  readyTimeoutMs?: number;
  graceMs?: number;
}

export interface McpUnavailableError extends Error {
  code: "BRIDGE_MCP_UNAVAILABLE";
}

export interface McpClient {
  readonly pid: number;
  start(): Promise<void>;
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  callTool(name: string, args: unknown, timeoutMs?: number): Promise<unknown>;
  stop(): Promise<void>;
  isRunning(): boolean;
  stderrText(): string;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface RestartableMcpClient extends McpClient {
  /** Run one Bridge-owned maintenance action while no MCP child or tool call is active. */
  restartAround<T>(operation: () => Promise<T>): Promise<T>;
}

function unavailable(detail: string): McpUnavailableError {
  const error: McpUnavailableError = Object.assign(new Error(detail), { code: "BRIDGE_MCP_UNAVAILABLE" as const });
  return error;
}

/**
 * Minimal newline-delimited JSON-RPC client for one MCP stdio child. Stderr is
 * kept as a bounded tail capture; stdout noise that does not parse as protocol
 * JSON is ignored; every pending request fails with BRIDGE_MCP_UNAVAILABLE
 * when the child exits. stop() is idempotent.
 */
export function createMcpClient(options: McpClientOptions): McpClient {
  const stderrLimitBytes = options.stderrLimitBytes ?? 64 * 1024;
  const readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
  const graceMs = options.graceMs ?? 3_000;
  const child = spawn(options.command, options.args ?? [], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
  child.stdin.on("error", () => undefined);
  child.on("error", () => undefined);

  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  let nextId = 1;
  let stderrTail = Buffer.alloc(0);
  let running = child.exitCode === null && child.signalCode === null;
  let stopPromise: Promise<void> | null = null;

  const failAll = (error: McpUnavailableError) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      running = false;
      failAll(unavailable("mcp child exited before responding"));
      for (const listener of exitListeners) listener(code, signal);
      resolve({ code, signal });
    });
  });

  createInterface({ input: child.stdout }).on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: { id?: unknown; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error !== undefined && message.error !== null) entry.reject(unavailable("mcp child returned a protocol error"));
    else entry.resolve(message.result);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const combined = Buffer.concat([stderrTail, chunk]);
    stderrTail = combined.length <= stderrLimitBytes ? combined : combined.subarray(combined.length - stderrLimitBytes);
  });

  function write(message: unknown): void {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method: string, params: unknown, timeoutMs: number = TIMEOUTS.toolMs): Promise<unknown> {
    if (!running) return Promise.reject(unavailable("mcp child is not running"));
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(unavailable(`mcp request ${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      write({ jsonrpc: "2.0", id, method, params });
    });
  }

  return {
    pid: child.pid ?? -1,
    async start(): Promise<void> {
      await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "writing-mcp-host-bridge", version: "0.1.0" } }, readyTimeoutMs);
      write({ jsonrpc: "2.0", method: "notifications/initialized" });
    },
    request,
    callTool(name: string, args: unknown, timeoutMs?: number): Promise<unknown> {
      return request("tools/call", { name, arguments: args }, timeoutMs);
    },
    stop(): Promise<void> {
      if (!stopPromise) {
        stopPromise = (async () => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
            const killer = setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            }, graceMs);
            await exited;
            clearTimeout(killer);
          }
        })();
      }
      return stopPromise;
    },
    isRunning(): boolean {
      return running;
    },
    stderrText(): string {
      return stderrTail.toString("utf8");
    },
    onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
      exitListeners.push(listener);
    },
  };
}

/**
 * Supervises replaceable MCP children for Bridge maintenance. Normal requests
 * share one child. restartAround() closes admission, drains in-flight calls,
 * stops that child, runs the filesystem action, then starts a fresh child.
 * Planned exits are hidden from Bridge degraded-state listeners.
 */
export function createRestartableMcpClient(options: McpClientOptions): RestartableMcpClient {
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const plannedStops = new WeakSet<McpClient>();
  let current = makeChild();
  let started = false;
  let stopping = false;
  let maintenanceActive = false;
  let activeCalls = 0;
  let resolveDrained: (() => void) | null = null;
  let maintenanceQueue: Promise<void> = Promise.resolve();

  function makeChild(): McpClient {
    const child = createMcpClient(options);
    child.onExit((code, signal) => {
      if (plannedStops.has(child)) return;
      if (current === child) for (const listener of exitListeners) listener(code, signal);
    });
    return child;
  }

  async function admitted<T>(run: (client: McpClient) => Promise<T>): Promise<T> {
    if (maintenanceActive || stopping) throw unavailable("mcp child is temporarily unavailable for bridge maintenance");
    const child = current;
    activeCalls += 1;
    try {
      return await run(child);
    } finally {
      activeCalls -= 1;
      if (activeCalls === 0) {
        resolveDrained?.();
        resolveDrained = null;
      }
    }
  }

  async function waitForDrain(): Promise<void> {
    if (activeCalls === 0) return;
    await new Promise<void>((resolve) => { resolveDrained = resolve; });
  }

  const supervised: RestartableMcpClient = {
    get pid(): number { return current.pid; },
    async start(): Promise<void> {
      if (started) return;
      await current.start();
      started = true;
    },
    request(method, params, timeoutMs): Promise<unknown> {
      return admitted((child) => child.request(method, params, timeoutMs));
    },
    callTool(name, args, timeoutMs): Promise<unknown> {
      return admitted((child) => child.callTool(name, args, timeoutMs));
    },
    async restartAround<T>(operation: () => Promise<T>): Promise<T> {
      let releaseQueue!: () => void;
      const previous = maintenanceQueue;
      maintenanceQueue = new Promise<void>((resolve) => { releaseQueue = resolve; });
      await previous;
      maintenanceActive = true;
      let operationResult!: T;
      let operationError: unknown;
      let restartError: unknown;
      try {
        await waitForDrain();
        const oldChild = current;
        plannedStops.add(oldChild);
        await oldChild.stop();
        try {
          operationResult = await operation();
        } catch (error) {
          operationError = error;
        }
        if (!stopping) {
          const nextChild = makeChild();
          current = nextChild;
          try {
            await nextChild.start();
            started = true;
          } catch (error) {
            restartError = error;
            started = false;
          }
        }
      } finally {
        maintenanceActive = false;
        releaseQueue();
      }
      if (operationError !== undefined && restartError !== undefined) {
        throw new AggregateError([operationError, restartError], "bridge maintenance and MCP restart both failed");
      }
      if (operationError !== undefined) throw operationError;
      if (restartError !== undefined) throw restartError;
      return operationResult;
    },
    async stop(): Promise<void> {
      stopping = true;
      await maintenanceQueue;
      plannedStops.add(current);
      await current.stop();
      started = false;
    },
    isRunning(): boolean { return started && current.isRunning(); },
    stderrText(): string { return current.stderrText(); },
    onExit(listener): void { exitListeners.push(listener); },
  };
  return supervised;
}
