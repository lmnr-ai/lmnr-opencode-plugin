import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

import { LocationSpanRouter } from "./router";

export interface ProcessorEntry {
  signature: string;
  processor: SpanProcessor;
}

export interface TracingRegistry {
  router: LocationSpanRouter;
  /** True once this process initialized Laminar, as opposed to another plugin. */
  installed: boolean;
  /** One pipeline per Location, keyed by the Location key. */
  entries: Map<string, ProcessorEntry>;
}

const REGISTRY_KEY = Symbol.for("lmnr.opencode.tracing");

export const createRegistry = (): TracingRegistry => ({
  router: new LocationSpanRouter(),
  installed: false,
  entries: new Map(),
});

/**
 * The registry lives on the global object, not in a module.
 *
 * OpenCode loads a plugin more than once in the same server process (a config
 * reload and every new app build re-evaluate the entrypoint). Only the global
 * object survives that: `@lmnr-ai/lmnr` keeps its own process-wide state, so a
 * module-level flag would try to initialize it twice and give up, leaving every
 * later Location without an exporter.
 */
export const tracingRegistry = (): TracingRegistry => {
  const holder = globalThis as unknown as Record<symbol, TracingRegistry | undefined>;
  let registry = holder[REGISTRY_KEY];
  if (!registry) {
    registry = createRegistry();
    holder[REGISTRY_KEY] = registry;
  }
  return registry;
};

/** Test helper: drop the process registry so the next call starts clean. */
export const resetRegistry = (): void => {
  delete (globalThis as unknown as Record<symbol, TracingRegistry | undefined>)[REGISTRY_KEY];
};
