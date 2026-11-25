import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

import { parse } from "dotenv";

import { projectRoot } from "./location";
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
 * Scheme, optional credentials and host of a base URL: everything up to the
 * port and whatever follows it.
 */
const ENDPOINT =
  /^((?:[a-z][a-z0-9+.-]*):\/\/)?((?:[^@/?#]*@)?)(\[[^\]]*\]|[^:/?#]+)(?::(\d{1,5}))?/i;

/**
 * Split a base URL into the endpoint Laminar needs and its gRPC port.
 *
 * The exporter builds its target as `${baseUrl}:${port}`, appending the port
 * itself, so a trailing slash or a path (a reverse proxy prefix, say) must not
 * survive here: it would either swallow the port or end up glued to it. The port
 * is read from the authority, so `http://host:8001/` keeps its 8001.
 */
const splitBaseUrl = (baseUrl: string): { endpoint: string; port?: number } => {
  const trimmed = baseUrl.trim();
  const match = ENDPOINT.exec(trimmed);
  if (!match) return { endpoint: trimmed };
  const [, scheme = "", credentials = "", host = "", port] = match;
  return {
    endpoint: `${scheme}${credentials}${host}`,
    ...(port !== undefined ? { port: Number(port) } : {}),
  };
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
  const { endpoint: baseUrl, port: urlPort } = splitBaseUrl(
    nonEmpty(options?.baseUrl) ?? nonEmpty(env.LMNR_BASE_URL) ?? DEFAULT_BASE_URL,
  );
  const rawPort = nonEmpty(env.LMNR_GRPC_PORT) ?? urlPort;
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
  port === undefined ? baseUrl : `${baseUrl}:${port}`;

/** Whether two resolved configurations describe the same exporter. */
export const sameLaminarConfig = (a: LaminarConfig, b: LaminarConfig): boolean =>
  a.projectApiKey === b.projectApiKey && a.baseUrl === b.baseUrl && a.port === b.port;
