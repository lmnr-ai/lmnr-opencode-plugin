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

/**
 * How closely `self` covers an event's location: `undefined` when the event is
 * not its business, otherwise a larger score the more specific the owner.
 *
 * Instances of one project share a pipeline, so the directory they were loaded
 * from is irrelevant: only the project boundary decides. A project nested
 * inside another one has a deeper root and wins the events below it, and a
 * workspace matches by id because its worktrees are different directories.
 */
export const coverage = (ref: LocationRef, self: LocationInfo): number | undefined => {
  // Worktrees are different directories of one workspace: when either side
  // names a workspace, it decides, not the directory.
  const inWorkspace = ref.workspaceID !== undefined || self.workspaceID !== undefined;
  if (inWorkspace && ref.workspaceID !== self.workspaceID) return undefined;

  const root = projectRoot(self);
  const eventDirectory = path.resolve(ref.directory);
  if (isWithin(root, eventDirectory)) {
    // A deeper project root is a more specific owner than an enclosing one.
    return root.split(path.sep).length;
  }
  // Another directory of the same workspace: a closer instance may exist, but
  // this one is still a valid owner.
  return inWorkspace ? 0 : undefined;
};
