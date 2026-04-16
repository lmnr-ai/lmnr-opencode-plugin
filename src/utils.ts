import { config } from "dotenv";
import * as path from "path";

export const getParentSpanId = (span: any): string | undefined =>
  // Otel v1 and v2 have different ways to get the parent span id.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  span.parentSpanContext?.spanId ?? span.parentSpanId;

export const otelSpanIdToUUID = (spanId: string): string => {
  let id = spanId.toLowerCase();
  if (id.startsWith("0x")) {
    id = id.slice(2);
  }
  return id
    .padStart(32, "0")
    .replace(
      /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/,
      "$1-$2-$3-$4-$5",
    );
};

export const loadEnv = (options?: {
  quiet?: boolean;
  paths?: string[];
}): void => {
  const nodeEnv = process.env.NODE_ENV || "development";
  const envDir = process.cwd();

  // Files to load in order (lowest to highest priority)
  // Later files override earlier ones
  const envFiles = [
    ".env",
    ".env.local",
    `.env.${nodeEnv}`,
    `.env.${nodeEnv}.local`,

    // it's common for a plugin to be in .opencode inside a project,
    // so look one level up too
    "../.env",
    "../.env.local",
    `../.env.${nodeEnv}`,
    `../.env.${nodeEnv}.local`,
  ];

  const logLevel = process.env.LMNR_LOG_LEVEL ?? "info";
  const verbose = ["debug", "trace"].includes(logLevel.trim().toLowerCase());

  const quiet = options?.quiet ?? !verbose;

  config({
    path:
      options?.paths ??
      envFiles.map((envFile) => path.resolve(envDir, envFile)),
    quiet,
  });
};
