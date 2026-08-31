import { z } from "zod";
import { snapshotCategorySchema } from "@writing-mcp/host-bridge-protocol";

export const PLUGIN_ID = "storyforge";
export const PLUGIN_API_VERSION = 1;

export const MINIMUM_PERMISSIONS = ["export:snapshot", "invoke:tools", "delete:derived"] as const;

export const minimumPermissionSchema = z.enum(MINIMUM_PERMISSIONS);

export const hostPluginManifestSchema = z.strictObject({
  id: z.literal(PLUGIN_ID),
  apiVersion: z.literal(PLUGIN_API_VERSION),
  hostCompatibility: z.strictObject({ bridgeProtocol: z.literal("^1") }),
  minimumPermissions: z.array(minimumPermissionSchema).min(1),
  exportCategories: z.array(snapshotCategorySchema).min(1),
  license: z.string().min(1),
  testMatrix: z.strictObject({
    node: z.array(z.string()).optional(),
    browsers: z.array(z.string()).optional(),
    platforms: z.array(z.string()).optional(),
  }),
});

export type HostPluginManifest = z.infer<typeof hostPluginManifestSchema>;
