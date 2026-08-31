import type { BridgeProcessState, HostStatusProjection, PluginState, ProjectBindingState, SessionState } from "@writing-mcp/host-bridge-protocol";

export interface BridgeStateOptions {
  countActiveSessions?: () => number;
  onPluginStateChange?: (next: PluginState, previous: PluginState) => void;
}

/**
 * The four orthogonal state axes from protocol v1. Session state is derived
 * from the live pairing manager; plugin revocation is delegated to the wiring
 * that owns the pairing manager (revoking tokens is its side effect).
 */
export function createBridgeState(options: BridgeStateOptions = {}) {
  const countActiveSessions = options.countActiveSessions ?? (() => 0);
  const projects = new Map<string, ProjectBindingState>();
  let processState: BridgeProcessState = "starting";
  let pluginState: PluginState = "enabled";

  return {
    get processState(): BridgeProcessState {
      return processState;
    },
    setProcessState(next: BridgeProcessState): void {
      processState = next;
    },
    get pluginState(): PluginState {
      return pluginState;
    },
    setPluginState(next: PluginState): void {
      const previous = pluginState;
      pluginState = next;
      options.onPluginStateChange?.(next, previous);
    },
    setProjectBinding(hostProjectId: string, bindingState: ProjectBindingState): void {
      projects.set(hostProjectId, bindingState);
    },
    projectBinding(hostProjectId: string): ProjectBindingState {
      return projects.get(hostProjectId) ?? "empty";
    },
    sessionState(): SessionState {
      return countActiveSessions() > 0 ? "paired" : "unpaired";
    },
    projection(): HostStatusProjection {
      return {
        sessionState: this.sessionState(),
        processState,
        pluginState,
        projects: [...projects].map(([hostProjectId, bindingState]) => ({ hostProjectId, bindingState })),
      };
    },
  };
}

export type BridgeState = ReturnType<typeof createBridgeState>;
