import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  computeContentHash, computeProjectKey, computeSnapshotHash, hostSnapshotDraftSchema,
  LIMITS, PROTOCOL_VERSION, type ProjectBindingState,
} from "@writing-mcp/host-bridge-protocol";
import { PLUGIN_ID } from "@writing-mcp/host-plugin-storyforge";
import type { PluginRegistry } from "./plugins.js";
import type { BridgeState } from "./state.js";

export interface ToolInvoker {
  callTool(name: string, args: unknown): Promise<unknown>;
}

const ERROR_STATUS: Record<string, number> = {
  BRIDGE_PROJECT_ID_INVALID: 400,
  BRIDGE_SNAPSHOT_INVALID: 400,
  BRIDGE_PLUGIN_DISABLED: 403,
  DERIVED_DATA_BUSY: 409,
  BRIDGE_REQUEST_TOO_LARGE: 413,
  BRIDGE_SNAPSHOT_ACTIVATION_FAILED: 500,
  BRIDGE_BINDING_DEGRADED: 500,
  BRIDGE_MCP_UNAVAILABLE: 503,
};

export class BridgeError extends Error {
  constructor(readonly code: keyof typeof ERROR_STATUS & string, message: string) {
    super(message);
  }
}

export function bridgeStatus(code: string): number {
  return ERROR_STATUS[code] ?? 500;
}

interface BindingMemory {
  bindingState: ProjectBindingState;
  snapshotHash?: string;
  workRef?: string;
  indexRevision?: number;
}

export interface SnapshotPipelineOptions {
  bridgeRoot: string;
  registry: PluginRegistry;
  state: BridgeState;
  mcp: ToolInvoker;
  pluginId?: string;
  hasActiveCapture?: () => boolean;
  renameFn?: (from: string, to: string) => Promise<void>;
  log?: (line: string) => void;
}

interface StoredManifest {
  pluginId: string;
  hostProjectId: string;
  projectKey: string;
  snapshotHash: string;
  workRef: string;
  indexRevision: number;
  manifestSchemaVersion: number;
  bindingState: string;
}

function toolData(result: unknown): Record<string, unknown> {
  const envelope = (result as { structuredContent?: { result?: { ok?: boolean; data?: unknown; error?: { code?: string } } } }).structuredContent?.result;
  if (!envelope?.ok) {
    const code = envelope?.error?.code;
    throw new BridgeError("BRIDGE_MCP_UNAVAILABLE", `tool call failed${code ? `: ${code}` : ""}`);
  }
  return (envelope.data ?? {}) as Record<string, unknown>;
}

async function boundedRename(renameFn: (from: string, to: string) => Promise<void>, from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameFn(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 3 || (code !== "EBUSY" && code !== "EPERM")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/**
 * Transactional snapshot activation per project: validate and recompute every
 * hash, stage documents outside the project, two-phase replace source/ on
 * Windows (EBUSY/EPERM bounded retry), resolve + index through the MCP child
 * until fresh, then atomically record the binding manifest. Any failure
 * restores the previous source; only a failed restore is allowed to degrade.
 * `.writing-index/` is never touched by the replace.
 */
export function createSnapshotPipeline(options: SnapshotPipelineOptions) {
  const pluginId = options.pluginId ?? PLUGIN_ID;
  const registry = options.registry;
  const state = options.state;
  const mcp = options.mcp;
  const log = options.log ?? (() => undefined);
  const locks = new Map<string, Promise<unknown>>();
  const bindings = new Map<string, BindingMemory>();

  let currentRename = options.renameFn ?? rename;

  const mutex = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const previous = locks.get(key) ?? Promise.resolve();
    const chained = previous.catch(() => undefined).then(run);
    locks.set(key, chained);
    try {
      return await chained;
    } finally {
      if (locks.get(key) === chained) locks.delete(key);
    }
  };

  const projectKey = (hostProjectId: string, origin: string) => computeProjectKey(pluginId, origin, hostProjectId);
  const projectDir = (key: string) => join(options.bridgeRoot, "projects", key);
  const manifestPath = (key: string) => join(projectDir(key), ".bridge", "manifest.json");

  async function readManifest(key: string): Promise<StoredManifest | null> {
    const raw = await readFile(manifestPath(key), "utf8").catch(() => null);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as StoredManifest;
    } catch {
      return null;
    }
  }

  async function writeManifest(manifest: StoredManifest): Promise<void> {
    await mkdir(dirname(manifestPath(manifest.projectKey)), { recursive: true });
    const tmp = `${manifestPath(manifest.projectKey)}.tmp`;
    await writeFile(tmp, JSON.stringify(manifest, null, 2));
    await currentRename(tmp, manifestPath(manifest.projectKey));
  }

  async function activateLocked(hostProjectId: string, origin: string, input: unknown): Promise<{ outcome: "activated" | "noop"; snapshotHash: string; bindingState: ProjectBindingState }> {
    if (!registry.isAvailable()) throw new BridgeError("BRIDGE_PLUGIN_DISABLED", "host plugin is disabled or revoked");
    const parsed = hostSnapshotDraftSchema.safeParse(input);
    if (!parsed.success) throw new BridgeError("BRIDGE_SNAPSHOT_INVALID", "draft failed protocol validation");
    const draft = parsed.data;
    if (draft.hostProjectId !== hostProjectId) throw new BridgeError("BRIDGE_PROJECT_ID_INVALID", "route and draft disagree on hostProjectId");
    let totalBytes = 0;
    for (const document of draft.documents) {
      const bytes = Buffer.byteLength(document.content, "utf8");
      if (bytes > LIMITS.maxDocumentBytes) throw new BridgeError("BRIDGE_SNAPSHOT_INVALID", "single document exceeds the 16 MiB limit");
      totalBytes += bytes;
    }
    if (totalBytes > LIMITS.maxTotalDocumentBytes) throw new BridgeError("BRIDGE_SNAPSHOT_INVALID", "documents exceed the 64 MiB total limit");
    for (const document of draft.documents) {
      if (computeContentHash(document.content) !== document.sha256) throw new BridgeError("BRIDGE_SNAPSHOT_INVALID", "document content hash mismatch");
    }
    const snapshotHash = computeSnapshotHash(PROTOCOL_VERSION, draft.documents);
    const key = projectKey(hostProjectId, origin);

    return mutex(key, async () => {
      const existing = await readManifest(key);
      const memory = bindings.get(key);
      if (existing?.snapshotHash === snapshotHash && memory?.bindingState === "fresh") {
        return { outcome: "noop" as const, snapshotHash, bindingState: "fresh" as const };
      }
      const operationId = randomUUID();
      const stagingRoot = join(options.bridgeRoot, ".staging", key, operationId);
      const stagingSource = join(stagingRoot, "source");
      const previousSource = join(stagingRoot, "previous-source");
      const finalSource = join(projectDir(key), "source");
      for (const document of draft.documents) {
        const target = join(stagingSource, document.relativePath);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, document.content, "utf8");
      }
      const hadPrevious = existsSync(finalSource);
      await mkdir(projectDir(key), { recursive: true });
      try {
        if (hadPrevious) await boundedRename(currentRename, finalSource, previousSource);
        await boundedRename(currentRename, stagingSource, finalSource);
      } catch {
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        throw new BridgeError("BRIDGE_SNAPSHOT_ACTIVATION_FAILED", "could not put the new source in place");
      }

      try {
        const resolveData = toolData(await mcp.callTool("writing_resolve", { sourcePath: projectDir(key), adapterHint: "generic" }));
        if (resolveData.status !== "resolved" || typeof resolveData.workRef !== "string") throw new BridgeError("BRIDGE_SNAPSHOT_ACTIVATION_FAILED", "resolve did not yield a workRef");
        const workRef = resolveData.workRef;
        const indexCall = async (mode: string) => toolData(await mcp.callTool("writing_index", { workRef, mode }));
        let indexData = await indexCall("status");
        if (indexData.freshness === "missing" || indexData.freshness === "stale") indexData = await indexCall("incremental");
        else if (indexData.freshness === "incompatible") indexData = await indexCall("rebuild");
        if (indexData.freshness !== "fresh") throw new BridgeError("BRIDGE_SNAPSHOT_ACTIVATION_FAILED", "index did not reach fresh");

        const manifest: StoredManifest = {
          pluginId,
          hostProjectId,
          projectKey: key,
          snapshotHash,
          workRef,
          indexRevision: Number(indexData.revision),
          manifestSchemaVersion: 1,
          bindingState: "fresh",
        };
        await writeManifest(manifest);
        bindings.set(key, { bindingState: "fresh", snapshotHash, workRef, indexRevision: manifest.indexRevision });
        state.setProjectBinding(hostProjectId, "fresh");
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        log?.(`snapshot activated project=${key.slice(0, 8)} hash=${snapshotHash.slice(0, 8)}`);
        return { outcome: "activated" as const, snapshotHash, bindingState: "fresh" as const };
      } catch (activationError) {
        let restored = false;
        if (hadPrevious) {
          try {
            await rm(finalSource, { recursive: true, force: true });
            await boundedRename(currentRename, previousSource, finalSource);
            await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
            restored = true;
          } catch {
            restored = false;
          }
        } else {
          await rm(finalSource, { recursive: true, force: true }).catch(() => undefined);
          await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        }
        if (restored && existing) {
          bindings.set(key, { bindingState: "fresh", snapshotHash: existing.snapshotHash, workRef: existing.workRef, indexRevision: existing.indexRevision });
          throw activationError instanceof BridgeError ? activationError : new BridgeError("BRIDGE_SNAPSHOT_ACTIVATION_FAILED", "activation failed; previous snapshot restored");
        }
        if (!hadPrevious) {
          bindings.delete(key);
          throw activationError instanceof BridgeError ? activationError : new BridgeError("BRIDGE_SNAPSHOT_ACTIVATION_FAILED", "activation failed; no previous snapshot existed");
        }
        bindings.set(key, { bindingState: "degraded" });
        state.setProjectBinding(hostProjectId, "degraded");
        await writeManifest({
          pluginId,
          hostProjectId,
          projectKey: key,
          snapshotHash: existing?.snapshotHash ?? snapshotHash,
          workRef: existing?.workRef ?? "",
          indexRevision: existing?.indexRevision ?? 0,
          manifestSchemaVersion: 1,
          bindingState: "degraded",
        }).catch(() => undefined);
        throw new BridgeError("BRIDGE_BINDING_DEGRADED", "activation failed and the previous snapshot could not be restored");
      }
    });
  }

  return {
    projectKey,
    setRenameFnForTest(fn: (from: string, to: string) => Promise<void>): void {
      currentRename = fn;
    },
    activate(hostProjectId: string, origin: string, input: unknown): Promise<{ outcome: "activated" | "noop"; snapshotHash: string; bindingState: ProjectBindingState }> {
      return activateLocked(hostProjectId, origin, input);
    },
    status(hostProjectId: string, origin: string): { hostProjectId: string; bindingState: ProjectBindingState; snapshotHash?: string; workRef?: string } {
      const key = projectKey(hostProjectId, origin);
      const memory = bindings.get(key);
      if (memory) return { hostProjectId, ...memory };
      return { hostProjectId, bindingState: "empty" };
    },
    async restoreFromManifests(): Promise<number> {
      const projectsDir = join(options.bridgeRoot, "projects");
      if (!existsSync(projectsDir)) return 0;
      let loaded = 0;
      for (const entry of await readdir(projectsDir).catch(() => [] as string[])) {
        const manifest = await readManifest(entry);
        if (!manifest) continue;
        bindings.set(entry, {
          bindingState: "stale",
          snapshotHash: manifest.snapshotHash,
          workRef: manifest.workRef || undefined,
          indexRevision: manifest.indexRevision || undefined,
        });
        state.setProjectBinding(manifest.hostProjectId, "stale");
        loaded += 1;
      }
      return loaded;
    },
    async deleteDerivedData(hostProjectId: string, origin: string): Promise<{ bindingState: "empty" }> {
      if (options.hasActiveCapture?.()) throw new BridgeError("DERIVED_DATA_BUSY", "a diagnostic capture is active");
      const key = projectKey(hostProjectId, origin);
      return mutex(key, async () => {
        await rm(projectDir(key), { recursive: true, force: true });
        bindings.delete(key);
        state.setProjectBinding(hostProjectId, "empty");
        log?.(`derived data deleted project=${key.slice(0, 8)}`);
        return { bindingState: "empty" as const };
      });
    },
  };
}

export type SnapshotPipeline = ReturnType<typeof createSnapshotPipeline>;
