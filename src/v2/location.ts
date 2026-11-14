import * as path from "node:path";

import type { PluginContext } from "./types";

export type LocationInfo = PluginContext["location"];

/** The subset of a Location that travels on events (`Event.Payload.location`). */
export interface LocationRef {
  directory: string;
  workspaceID?: string | undefined;
}

/**
 * Identifies one exporter pipeline. Two sessions in the same project and
 * workspace share it; a second project, or a worktree, gets its own.
 */
export const locationKey = (location: LocationInfo): string =>
  `${location.project.id}|${location.workspaceID ?? location.directory}`;

/**
 * Whether an event belongs to this plugin instance's Location. Events may reach
 * every instance in the shared server, and tracing another project's sessions
 * would attribute them to the wrong endpoint.
 *
 * A missing location means an older payload: keep processing it.
 */
export const ownsLocation = (ref: LocationRef | undefined, self: LocationInfo): boolean => {
  if (!ref) return true;
  if (ref.workspaceID !== undefined || self.workspaceID !== undefined) {
    return ref.workspaceID === self.workspaceID;
  }
  // Sessions opened in a subdirectory of the project still belong to it.
  const root = self.project?.directory ?? self.directory;
  const relative = path.relative(root, ref.directory);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
