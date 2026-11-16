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
 * A session belongs to the closest live instance to its own location, which is
 * also the instance the host delivers its hooks to, so the input and the events
 * meet in one tracer. The location is the one the session was first seen at and
 * is remembered, because an event without a location carries none of its own.
 *
 * Deriving the owner instead of pinning it to whoever happened to take the
 * session over means a reload cannot misfile it: while a nested instance is
 * unloaded the root traces the session, and as soon as the nested instance is
 * back it owns the session again, with the hooks that came back with it.
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

  // The session's own location, remembered from its first event, decides.
  const known = claim?.location ?? location;
  if (known !== undefined) {
    const elected = closestOwner(registry, known);
    if (elected === undefined) return false;
    registry.sessions.set(sessionID, { owner: elected, location: known });
    return elected === id;
  }

  // A session never seen at any location belongs to the instance that holds it.
  const owner =
    claim !== undefined && registry.instances.has(claim.owner)
      ? claim.owner
      : knowsSession
        ? id
        : undefined;
  if (owner === undefined) return false;
  registry.sessions.set(sessionID, { owner });
  return owner === id;
};

/** Forget a session that ended, so claims do not accumulate. */
export const releaseSession = (registry: TracingRegistry, sessionID: string): void => {
  registry.sessions.delete(sessionID);
};
