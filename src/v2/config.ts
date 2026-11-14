import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

import { parse } from "dotenv";

import type { LocationInfo } from "./location";
import type { PluginContext } from "./types";

export interface LaminarConfig {
  projectApiKey?: string | undefined;
  baseUrl: string;
  port?: number | undefined;
}

const DEFAULT_BASE_URL = "https://api.lmnr.ai";
const DEFAULT_GRPC_PORT = 8443;

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * The project root, not the session directory: a session may be opened in a
 * subdirectory while its `.env` lives at the root of the repository.
 */
export const projectRoot = (location: LocationInfo): string =>
  location.project?.directory ?? location.project?.canonical ?? location.directory;

const envFiles = (nodeEnv: string): string[] => [
  ".env",
  ".env.local",
  `.env.${nodeEnv}`,
  `.env.${nodeEnv}.local`,
];

/**
 * Read the project's `.env` files into a plain object.
 *
 * `dotenv.config()` would write them to `process.env`, which the shared
 * OpenCode server also uses for other projects: the first project loaded would
 * win for the lifetime of the process. Parsing locally keeps each Location's
 * configuration its own.
 */
export const readProjectEnv = (
  dir: string,
  nodeEnv = process.env.NODE_ENV ?? "development",
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of envFiles(nodeEnv)) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    Object.assign(env, parse(readFileSync(file)));
  }
  return env;
};

/**
 * Resolve the tracing configuration of one Location.
 *
 * Precedence: plugin options > project `.env` > the service environment.
 */
export const resolveLaminarConfig = (
  ctx: Pick<PluginContext, "location" | "options">,
  processEnv: NodeJS.ProcessEnv = process.env,
): LaminarConfig => {
  const projectEnv = readProjectEnv(projectRoot(ctx.location));
  const env: NodeJS.ProcessEnv = { ...processEnv, ...projectEnv };
  const options = ctx.options as { projectApiKey?: unknown; baseUrl?: unknown };

  const projectApiKey =
    nonEmpty(options?.projectApiKey) ?? nonEmpty(env.LMNR_PROJECT_API_KEY);
  const baseUrl =
    nonEmpty(options?.baseUrl) ?? nonEmpty(env.LMNR_BASE_URL) ?? DEFAULT_BASE_URL;
  const rawPort = nonEmpty(env.LMNR_GRPC_PORT) ?? nonEmpty(baseUrl.match(/:(\d{1,5})$/)?.[1]);
  const port = rawPort !== undefined ? Number(rawPort) : undefined;
  const grpcPort =
    port !== undefined && Number.isFinite(port)
      ? port
      : baseUrl === DEFAULT_BASE_URL
        ? DEFAULT_GRPC_PORT
        : undefined;

  return {
    ...(projectApiKey !== undefined ? { projectApiKey } : {}),
    baseUrl,
    ...(grpcPort !== undefined ? { port: grpcPort } : {}),
  };
};

/** The endpoint an exporter actually talks to, port included. */
export const endpointLabel = ({ baseUrl, port }: LaminarConfig): string =>
  port === undefined ? baseUrl : `${baseUrl.replace(/:\d{1,5}$/, "")}:${port}`;
