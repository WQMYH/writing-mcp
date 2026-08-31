import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { MINIMUM_PERMISSIONS, PLUGIN_API_VERSION, PLUGIN_ID, hostPluginManifestSchema } from "../packages/host-plugin-storyforge/src/index.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/host-bridge-protocol/${name}`, import.meta.url), "utf8"));

describe("storyforge host plugin manifest (HB-M0)", () => {
  test("canonical manifest fixture parses with exactly the seven frozen fields", () => {
    const manifest = fixture("manifest-storyforge.json");
    const parsed = hostPluginManifestSchema.parse(manifest);
    expect(Object.keys(parsed).sort()).toEqual(["apiVersion", "exportCategories", "hostCompatibility", "id", "license", "minimumPermissions", "testMatrix"]);
    expect(parsed.id).toBe(PLUGIN_ID);
    expect(parsed.apiVersion).toBe(PLUGIN_API_VERSION);
  });

  test("manifest rejects unknown fields, wrong identity, and bad enums", () => {
    const manifest = fixture("manifest-storyforge.json");
    expect(hostPluginManifestSchema.safeParse({ ...manifest, extra: 1 }).success).toBe(false);
    expect(hostPluginManifestSchema.safeParse({ ...manifest, id: "inkos" }).success).toBe(false);
    expect(hostPluginManifestSchema.safeParse({ ...manifest, apiVersion: 2 }).success).toBe(false);
    expect(hostPluginManifestSchema.safeParse({ ...manifest, hostCompatibility: { bridgeProtocol: "^2" } }).success).toBe(false);
    expect(hostPluginManifestSchema.safeParse({ ...manifest, minimumPermissions: [] }).success).toBe(false);
    expect(hostPluginManifestSchema.safeParse({ ...manifest, minimumPermissions: ["admin:all"] }).success).toBe(false);
    expect(hostPluginManifestSchema.safeParse({ ...manifest, exportCategories: ["politics"] }).success).toBe(false);
    expect(hostPluginManifestSchema.safeParse({ ...manifest, exportCategories: [] }).success).toBe(false);
    expect(hostPluginManifestSchema.safeParse({ ...manifest, license: "" }).success).toBe(false);
    const incomplete: Record<string, unknown> = { ...manifest };
    delete incomplete.testMatrix;
    expect(hostPluginManifestSchema.safeParse(incomplete).success).toBe(false);
  });

  test("minimum permission vocabulary is frozen and covered by the fixture", () => {
    expect([...MINIMUM_PERMISSIONS]).toEqual(["export:snapshot", "invoke:tools", "delete:derived"]);
    const manifest = fixture("manifest-storyforge.json");
    expect(new Set(manifest.minimumPermissions)).toEqual(new Set(MINIMUM_PERMISSIONS));
  });
});
