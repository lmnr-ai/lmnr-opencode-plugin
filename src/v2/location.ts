import * as path from "node:path";

import type { PluginContext } from "./types";

export type LocationInfo = PluginContext["location"];

/** The subset of a Location that travels on events (`Event.Payload.location`). */
export interface LocationRef {
  directory: string;
  workspaceID?: string | undefined;
}

/**
 * The directory whose configuration a Location belongs to, not the session
 * directory: a session may be opened in a subdirectory while its `.env` lives at
 * the root of the repository.
 */
export const projectRoot = (location: LocationInfo): string =>
  path.resolve(location.project?.directory ?? location.project?.canonical ?? location.directory);

/**
 * Identifies one exporter pipeline. Every Location of the same project resolves
 * to the same key, including the ones OpenCode loads for directories nested in
 * it, so they share a pipeline instead of exporting the same session twice. A
 * second project, or a worktree, gets its own.
 */
export const locationKey = (location: LocationInfo): string =>
  `${location.project.id}|${
    location.workspaceID !== undefined
      ? `ws:${location.workspaceID}`
      : `dir:${projectRoot(location)}`
  }`;

/** Whether `child` is `parent` or a directory inside it. */
const isWithin = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

/** How many directories separate `child` from `parent`, or undefined if neither. */
const depth = (parent: string, child: string): number | undefined => {
  if (!isWithin(parent, child)) return undefined;
  const relative = path.relative(parent, child);
  return relative === "" ? 0 : relative.split(path.sep).length;
};

/**
 * How closely `self` covers an event's location: `undefined` when the event is
 * not its business, otherwise a larger number the closer the two are.
 *
 * The granularity matters when the plugin is loaded more than once for the same
 * project. An exact location (3) beats one that encloses the event, which beats
 * a sibling directory of the same project or workspace (1). Between enclosing
 * instances the score decreases with their distance: a closed fraction of the
 * segment count, so a location nested in the project always wins the sessions
 * below it over the project root that also contains them.
 */
export const coverage = (ref: LocationRef | undefined, self: LocationInfo): number | undefined => {
  // A missing location means an older payload: it belongs to everyone, so it
  // cannot be arbitrated.
  if (!ref) return 0;
  // Worktrees are different directories of one workspace: when either side
  // names a workspace, it decides, not the directory.
  const inWorkspace = ref.workspaceID !== undefined || self.workspaceID !== undefined;
  if (inWorkspace && ref.workspaceID !== self.workspaceID) return undefined;

  const selfDirectory = path.resolve(self.directory);
  const eventDirectory = path.resolve(ref.directory);
  if (eventDirectory === selfDirectory) return 3;
  // Sessions opened in a subdirectory of the instance still belong to it, the
  // closest of its ancestors winning when several of them are loaded.
  const segments = depth(selfDirectory, eventDirectory);
  if (segments !== undefined) return 2 - segments / (segments + 1);
  // Another directory of the same project, or another worktree of the same
  // workspace: a closer instance may exist, but this one is still a valid owner.
  if (inWorkspace) return 1;
  return isWithin(projectRoot(self), eventDirectory) ? 1 : undefined;
};
