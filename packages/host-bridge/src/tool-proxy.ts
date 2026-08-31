import { join } from "node:path";
import { TIMEOUTS } from "@writing-mcp/host-bridge-protocol";
import type { ProjectToolOperation, ProjectToolProxy } from "./server.js";
import { BridgeError, type SnapshotPipeline, type ToolInvoker } from "./snapshot.js";

export interface ProjectToolProxyOptions {
  bridgeRoot: string;
  mcp: ToolInvoker;
  pipeline: Pick<SnapshotPipeline, "projectKey" | "status">;
  isPluginAvailable?: () => boolean;
}

type ToolResultEnvelope = {
  ok?: boolean;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string };
  diagnostic?: unknown;
};

function resultEnvelope(value: unknown): ToolResultEnvelope {
  const result = (value as { structuredContent?: { result?: ToolResultEnvelope } }).structuredContent?.result;
  if (!result || typeof result.ok !== "boolean") {
    throw new BridgeError("BRIDGE_MCP_UNAVAILABLE", "MCP returned an invalid structured result");
  }
  return result;
}

const TOOL_NAMES: Readonly<Record<ProjectToolOperation, string>> = {
  resolve: "writing_resolve",
  index: "writing_index",
  explore: "writing_explore",
  context: "writing_context",
  diagnose: "writing_diagnose",
};

function browserSafeDiagnose(result: ToolResultEnvelope): ToolResultEnvelope {
  if (!result.data) return result;
  const { artifactPath: _artifactPath, diagnosticsDirectory: _diagnosticsDirectory, ...data } = result.data;
  return { ...result, data };
}

/**
 * Project-scoped proxy for the five frozen Writing MCP tools. Browser supplied
 * sourcePath/workRef values never cross the trust boundary: resolve targets the
 * derived project directory and every other call uses the bridge-owned binding.
 * A lost MCP in-memory work registry is repaired by one deterministic resolve
 * and one retry; the shared child is never stopped by a timed-out/cancelled call.
 */
export function createProjectToolProxy(options: ProjectToolProxyOptions): ProjectToolProxy {
  const workRefs = new Map<string, string>();

  const resolveWork = async (hostProjectId: string, origin: string): Promise<ToolResultEnvelope> => {
    const key = options.pipeline.projectKey(hostProjectId, origin);
    const result = resultEnvelope(await options.mcp.callTool(
      TOOL_NAMES.resolve,
      { sourcePath: join(options.bridgeRoot, "projects", key), adapterHint: "generic" },
      TIMEOUTS.toolMs,
    ));
    const workRef = result.ok ? result.data?.workRef : undefined;
    if (typeof workRef === "string") workRefs.set(key, workRef);
    return result;
  };

  const boundWorkRef = async (hostProjectId: string, origin: string): Promise<string> => {
    const key = options.pipeline.projectKey(hostProjectId, origin);
    const status = options.pipeline.status(hostProjectId, origin);
    if (status.bindingState === "degraded" || status.bindingState === "empty") {
      throw new BridgeError("BRIDGE_BINDING_DEGRADED", "project snapshot is not available for tool calls");
    }
    const known = workRefs.get(key) ?? status.workRef;
    if (known) return known;
    const resolved = await resolveWork(hostProjectId, origin);
    const workRef = resolved.ok ? resolved.data?.workRef : undefined;
    if (typeof workRef !== "string") throw new BridgeError("BRIDGE_MCP_UNAVAILABLE", "resolve did not yield a workRef");
    return workRef;
  };

  return {
    async invoke(operation, hostProjectId, origin, args): Promise<unknown> {
      if (options.isPluginAvailable && !options.isPluginAvailable()) {
        throw new BridgeError("BRIDGE_PLUGIN_DISABLED", "host plugin is disabled or revoked");
      }
      if (operation === "resolve") return resolveWork(hostProjectId, origin);

      const call = async (workRef: string): Promise<ToolResultEnvelope> => {
        const callArgs: Record<string, unknown> = { ...args, workRef };
        if (operation === "diagnose") callArgs.contentPolicy = "metadata";
        return resultEnvelope(await options.mcp.callTool(
          TOOL_NAMES[operation],
          callArgs,
          operation === "index" ? TIMEOUTS.snapshotMs : TIMEOUTS.toolMs,
        ));
      };

      let result = await call(await boundWorkRef(hostProjectId, origin));
      if (!result.ok && result.error?.code === "WORK_REF_NOT_FOUND") {
        const resolved = await resolveWork(hostProjectId, origin);
        const workRef = resolved.ok ? resolved.data?.workRef : undefined;
        if (typeof workRef !== "string") return resolved;
        result = await call(workRef);
      }
      return operation === "diagnose" ? browserSafeDiagnose(result) : result;
    },
  };
}
