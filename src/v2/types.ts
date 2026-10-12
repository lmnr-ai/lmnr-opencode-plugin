// Type-only imports: the V2 host resolves `@opencode/plugin` itself, and V1
// hosts must not need it at runtime.
import type { Plugin } from "@opencode/plugin" with { "resolution-mode": "import" };
import type {
  SessionContext,
  SessionPrompt,
} from "@opencode/plugin/promise/session" with { "resolution-mode": "import" };

export type PluginContext = Plugin.Context;
export type PluginDefinition = Plugin.Plugin;

export type OpenCodeEvent =
  PluginContext["event"]["subscribe"] extends (...args: any[]) => AsyncIterable<infer E>
    ? E
    : never;

export type SessionPromptHook = SessionPrompt;
export type SessionContextHook = SessionContext;
