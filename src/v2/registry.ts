import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

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
export interface PipelineEntry {
  /** The resolved configuration, to notice a change. Holds the key: never log it. */
  signature: string;
  processor: SpanProcessor;
  tracer: SessionTracer;
  /** Flushes started by a turn end, awaited by the cleanup of any instance. */
  inFlight: Set<Promise<void>>;
  /** How many live plugin instances forward into this pipeline. */
  instances: number;
  /** Unregisters the processor from the router, if it is still the current one. */
  detach: () => boolean;
}

export interface InstanceRecord {
  /** The pipeline this instance forwards into. */
  key: string;
  location: LocationInfo;
  /** Registration order: a newer instance wins a tie, so a reload takes over. */
  sequence: number;
}

export interface TracingRegistry {
  router: LocationSpanRouter;
  /** True once this process initialized Laminar, as opposed to another plugin. */
  installed: boolean;
  /** One pipeline per project, keyed by the location key. */
  entries: Map<string, PipelineEntry>;
  /** The live plugin instances, by id, in registration order. */
  instances: Map<number, InstanceRecord>;
  sequence: number;
}

const REGISTRY_KEY = Symbol.for("lmnr.opencode.tracing");

export const createRegistry = (): TracingRegistry => ({
  router: new LocationSpanRouter(),
  installed: false,
  entries: new Map(),
  instances: new Map(),
  sequence: 0,
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

/** Record a live plugin instance, so ownership can be arbitrated between them. */
export const registerInstance = (
  registry: TracingRegistry,
  key: string,
  location: LocationInfo,
): number => {
  const id = ++registry.sequence;
  registry.instances.set(id, { key, location, sequence: id });
  return id;
};

export const unregisterInstance = (registry: TracingRegistry, id: number): void => {
  registry.instances.delete(id);
};

/**
 * The instance that owns `ref`: the closest live one, the newest on a tie.
 *
 * OpenCode loads the plugin once per location, and the locations of one project
 * nest: the project root and a directory inside it both receive every event of
 * the shared server. Instances of one project share a pipeline, so handling an
 * event twice is harmless, but the payload still has to reach the right
 * project's pipeline; the closest instance is the one that forwards it.
 *
 * Comparison is not limited to one key: a project nested inside another one wins
 * its own sessions over the enclosing project's instance.
 */
export const closestOwner = (
  registry: TracingRegistry,
  ref: LocationRef,
): number | undefined => {
  let winner: number | undefined;
  let best = Number.NEGATIVE_INFINITY;
  let bestSequence = Number.NEGATIVE_INFINITY;
  for (const [id, record] of registry.instances) {
    const score = coverage(ref, record.location);
    if (score === undefined) continue;
    // On a tie the newest instance wins, so the one that survives a reload
    // takes the events over from the one being unloaded.
    if (score > best || (score === best && record.sequence > bestSequence)) {
      best = score;
      bestSequence = record.sequence;
      winner = id;
    }
  }
  return winner;
};

/**
 * The pipeline that owns `ref`: the key of the closest live instance.
 *
 * Every instance of that pipeline forwards the event, which is harmless because
 * they share one tracer, and an instance that has just been loaded but is not
 * listening yet cannot take events away from the ones already running.
 */
export const ownerKey = (registry: TracingRegistry, ref: LocationRef): string | undefined => {
  const owner = closestOwner(registry, ref);
  return owner === undefined ? undefined : registry.instances.get(owner)?.key;
};
