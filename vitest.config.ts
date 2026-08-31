import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
// Workspace aliases resolve to src so tests execute (and coverage measures) the
// TypeScript sources instead of the compiled dist output.
const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));
export default defineConfig({ resolve: { alias: { "@writing-mcp/core": src("core"), "@writing-mcp/adapter-generic": src("adapter-generic"), "@writing-mcp/adapter-inkos": src("adapter-inkos"), "@writing-mcp/host-bridge-protocol": src("host-bridge-protocol"), "@writing-mcp/host-plugin-storyforge": src("host-plugin-storyforge"), "@writing-mcp/host-bridge": src("host-bridge") } }, test: { include: ["tests/**/*.test.ts"], testTimeout: 30000, coverage: { provider: "v8", include: ["packages/*/src/**/*.ts"], reporter: ["text", "json-summary"], thresholds: { lines: 90, statements: 87, functions: 85, branches: 73 } } } });
