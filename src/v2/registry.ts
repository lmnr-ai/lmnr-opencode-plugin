import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

import type { LaminarConfig } from "./config";
import { coverage, type LocationInfo, type LocationRef } from "./location";
import { LocationSpanRouter } from "./router";
import type { SessionTracer } from "./tracer";

/**
 * One OpenCode project: its exporter pipeline and the single tracer that builds
 * its spans.
 *
 * Both outlive a plugin reload, and both are shared by every instance of the
 * project, so hooks that arrive at one instance and events that arrive at
 * another still meet in one place.
 */
export interface Pipeline {
  /** The resolved configuration, to notice a change. Holds the key: never log it. */
  config: LaminarConfig;
  processor: SpanProcessor;
  tracer: SessionTracer;
  /** Flushes started by a turn end, awaited by the cleanup of any instance. */
  inFlight: Set<Promise<void>>;
  /** How many live plugin instances forward into this pipeline. */
  instanceCount: number;
  /** Unregisters the processor from the router, if it is still the current one. */
  detach: () => boolean;
}

interface Instance {
  /** The pipeline this instance forwards into. */
  key: string;
  location: LocationInfo;
}

export interface TracingRegistry {
  router: LocationSpanRouter;
  /** True once this process initialized Laminar, as opposed to another plugin. */
  installed: boolean;
  /** One pipeline per project, keyed by the location key. */
  pipelines: Map<string, Pipeline>;
  /**
   * Record a live plugin instance, so ownership can be arbitrated between them.
   * Returns the function that unregisters it.
   */
  addInstance(key: string, location: LocationInfo): () => void;
  /** The pipeline that owns `ref`: the key of the closest live instance. */
  ownerKey(ref: LocationRef): string | undefined;
}

const REGISTRY_KEY = Symbol.for("lmnr.opencode.tracing");

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
    const instances: Instance[] = [];
    registry = {
      router: new LocationSpanRouter(),
      installed: false,
      pipelines: new Map(),
      addInstance(key, location) {
        const instance: Instance = { key, location };
        instances.push(instance);
        return () => {
          const index = instances.indexOf(instance);
          if (index !== -1) instances.splice(index, 1);
        };
      },
      ownerKey(ref) {
        // The closest live instance owns the event. On a tie the newest one
        // wins, so a reload takes over from the instance it replaces; array
        // order is registration order.
        let winner: Instance | undefined;
        let best = Number.NEGATIVE_INFINITY;
        for (const instance of instances) {
          const score = coverage(ref, instance.location);
          if (score === undefined || score < best) continue;
          best = score;
          winner = instance;
        }
        return winner?.key;
      },
    };
    holder[REGISTRY_KEY] = registry;
  }
  return registry;
};

/** Test helper: drop the process registry so the next call starts clean. */
export const resetRegistry = (): void => {
  delete (globalThis as unknown as Record<symbol, TracingRegistry | undefined>)[REGISTRY_KEY];
};
