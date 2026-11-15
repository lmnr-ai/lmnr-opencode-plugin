import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

import { coverage, type LocationInfo, type LocationRef } from "./location";
import { LocationSpanRouter } from "./router";

export interface ProcessorEntry {
  signature: string;
  processor: SpanProcessor;
}

export interface InstanceRecord {
  /** The Location key: instances sharing it also share one pipeline. */
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
  entries: Map<string, ProcessorEntry>;
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
 * Whether `id` is the instance that traces `ref`.
 *
 * OpenCode loads the plugin once per location, and the locations of one project
 * nest: the project root and a directory inside it both receive every event of
 * the shared server. The pipeline is keyed by the project, so they share an
 * exporter; this picks the single instance closest to the event, so the session
 * is neither traced twice nor split between two tracers.
 *
 * Comparison is not limited to one key: a project nested inside another one wins
 * its own sessions over the enclosing project's instance. A payload without a
 * location is compared within one pipeline only, since nothing says which
 * project it belongs to.
 */
export const ownsEvent = (
  registry: TracingRegistry,
  id: number,
  ref: LocationRef | undefined,
): boolean => {
  const self = registry.instances.get(id);
  if (!self) return false;
  // A payload without a location names no session and no project: the instances
  // of one pipeline still arbitrate, but nothing says the payload is ours, so
  // another project's instance keeps its own copy instead of losing it.
  const group = ref === undefined ? self.key : undefined;
  const own = coverage(ref, self.location);
  if (own === undefined) return false;

  let best = own;
  let winner = self.sequence;
  for (const [other, record] of registry.instances) {
    if (other === id) continue;
    if (group !== undefined && record.key !== group) continue;
    const score = coverage(ref, record.location);
    if (score === undefined) continue;
    // On a tie the newest instance wins, so the one that survives a reload
    // takes the events over from the one being unloaded.
    if (score > best || (score === best && record.sequence > winner)) {
      best = score;
      winner = record.sequence;
    }
  }
  return winner === self.sequence;
};
