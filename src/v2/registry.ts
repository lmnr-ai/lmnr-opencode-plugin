import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

import { coverage, type LocationInfo, type LocationRef } from "./location";
import { LocationSpanRouter } from "./router";

export interface ProcessorEntry {
  signature: string;
  processor: SpanProcessor;
}

export interface InstanceRecord {
  location: LocationInfo;
  /** Registration order: a newer instance wins a tie, so a reload takes over. */
  sequence: number;
}

export interface SessionClaim {
  /** The instance that traces the session. */
  owner: number;
  /** The location the session was last seen at, to elect a new owner. */
  location?: LocationRef | undefined;
}

export interface TracingRegistry {
  router: LocationSpanRouter;
  /** True once this process initialized Laminar, as opposed to another plugin. */
  installed: boolean;
  /** One pipeline per project, keyed by the location key. */
  entries: Map<string, ProcessorEntry>;
  /** The live plugin instances, by id, in registration order. */
  instances: Map<number, InstanceRecord>;
  /** The instance that traces each session, by session id. */
  sessions: Map<string, SessionClaim>;
  sequence: number;
}

const REGISTRY_KEY = Symbol.for("lmnr.opencode.tracing");

export const createRegistry = (): TracingRegistry => ({
  router: new LocationSpanRouter(),
  installed: false,
  entries: new Map(),
  instances: new Map(),
  sessions: new Map(),
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
export const registerInstance = (registry: TracingRegistry, location: LocationInfo): number => {
  const id = ++registry.sequence;
  registry.instances.set(id, { location, sequence: id });
  return id;
};

export const unregisterInstance = (registry: TracingRegistry, id: number): void => {
  registry.instances.delete(id);
};

/**
 * The instance that traces `ref`: the closest live one, the newest on a tie.
 *
 * OpenCode loads the plugin once per location, and the locations of one project
 * nest: the project root and a directory inside it both receive every event of
 * the shared server. The pipeline is keyed by the project, so they share an
 * exporter; this picks the single instance closest to the event, so the session
 * is neither traced twice nor split between two tracers.
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

/** Whether `id` is the instance that traces `ref`. */
export const ownsEvent = (registry: TracingRegistry, id: number, ref: LocationRef): boolean =>
  registry.instances.has(id) && closestOwner(registry, ref) === id;

/**
 * Whether `id` traces the events of `sessionID`.
 *
 * A session belongs to one live instance until it goes away: otherwise a reload
 * of a nested location, or the hooks of a session arriving at one instance and
 * its events at another, would split the conversation between two tracers. The
 * first event decides, by its location when it has one and by the tracer that
 * already holds the session (through its hooks) when it does not, and every
 * later event of the session follows that owner. When the owner unloads, the
 * location the session was last seen at elects the next one, even for an event
 * that carries no location of its own.
 */
export const ownsSession = (
  registry: TracingRegistry,
  id: number,
  sessionID: string,
  location: LocationRef | undefined,
  knowsSession: boolean,
): boolean => {
  if (!registry.instances.has(id)) return false;
  const claim = registry.sessions.get(sessionID);
  if (claim !== undefined && registry.instances.has(claim.owner)) {
    if (location !== undefined) claim.location = location;
    return claim.owner === id;
  }

  // The session has no live owner: the closest instance to its location takes
  // it, and a session never seen anywhere belongs to the tracer that already
  // holds it.
  const known = location ?? claim?.location;
  const elected =
    known !== undefined ? closestOwner(registry, known) : knowsSession ? id : undefined;
  if (elected === undefined) return false;
  registry.sessions.set(sessionID, {
    owner: elected,
    ...(known !== undefined ? { location: known } : {}),
  });
  return elected === id;
};

/** Forget a session that ended, so claims do not accumulate. */
export const releaseSession = (registry: TracingRegistry, sessionID: string): void => {
  registry.sessions.delete(sessionID);
};
