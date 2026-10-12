import type { Plugin } from "@opencode-ai/plugin";

import { serverV1 } from "./v1";
import { setupV2 } from "./v2";
import type { PluginDefinition } from "./v2/types";

// Type-checks the V2 definition against `@opencode/plugin` without leaking its
// (very large) context types into the published declarations.
const v2 = { id: "laminar", setup: setupV2 } satisfies PluginDefinition;

interface LaminarPlugin {
  id: string;
  setup: (ctx: any) => Promise<(() => Promise<void>) | undefined>;
  server: Plugin;
}

// One default export serves both OpenCode generations: V1 calls `server()`,
// V2 reads `id` and `setup()`. Keep this the only export: older V1 loaders
// call every exported function, so a second export would load the plugin twice.
const plugin: LaminarPlugin = { ...v2, server: serverV1 };

export default plugin;
