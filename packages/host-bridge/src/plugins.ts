import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostPluginManifestSchema, PLUGIN_ID, type HostPluginManifest } from "@writing-mcp/host-plugin-storyforge";
import type { BridgeState } from "./state.js";

export interface PluginRegistryOptions {
  bridgeRoot: string;
  state: BridgeState;
  log?: (line: string) => void;
}

/**
 * Governance home for the single static host plugin: the frozen manifest is
 * validated at registration, the enabled/disabled/revoked state lives in the
 * bridge state (so revocation hooks can revoke tokens), and both persist to
 * `<bridgeRoot>/.bridge/plugin-state.json` — the file project-scoped derived
 * data deletion must never touch.
 */
export function createPluginRegistry({ bridgeRoot, state, log }: PluginRegistryOptions) {
  const statePath = join(bridgeRoot, ".bridge", "plugin-state.json");
  let manifest: HostPluginManifest | null = null;

  async function persist(): Promise<void> {
    await mkdir(join(bridgeRoot, ".bridge"), { recursive: true });
    await writeFile(statePath, JSON.stringify({ pluginId: manifest?.id ?? PLUGIN_ID, state: state.pluginState, manifest }, null, 2));
  }

  return {
    register(input: unknown): { ok: true } | { ok: false; reason: string } {
      const parsed = hostPluginManifestSchema.safeParse(input);
      if (!parsed.success) return { ok: false, reason: "manifest failed frozen schema validation" };
      manifest = parsed.data;
      return { ok: true };
    },
    manifest(): HostPluginManifest | null {
      return manifest;
    },
    isAvailable(): boolean {
      return manifest !== null && state.pluginState === "enabled";
    },
    async setState(next: "enabled" | "disabled" | "revoked"): Promise<void> {
      state.setPluginState(next);
      await persist();
      log?.(`plugin state=${next}`);
    },
    async load(): Promise<boolean> {
      const raw = await readFile(statePath, "utf8").catch(() => null);
      if (raw === null) return false;
      try {
        const parsed = JSON.parse(raw) as { state?: unknown; manifest?: unknown };
        if (parsed.manifest !== undefined && parsed.manifest !== null) {
          const check = hostPluginManifestSchema.safeParse(parsed.manifest);
          if (check.success) manifest = check.data;
        }
        if (parsed.state === "disabled" || parsed.state === "revoked") state.setPluginState(parsed.state);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type PluginRegistry = ReturnType<typeof createPluginRegistry>;
