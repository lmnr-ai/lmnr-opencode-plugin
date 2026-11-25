import { appendFileSync } from "node:fs";

/**
 * Opt-in diagnostics for the background server, whose stdout is /dev/null.
 * Enable with `LMNR_DEBUG_LOG=/path/to/lmnr.log`; tracing never depends on it.
 */
export const debug = (message: string): void => {
  const file = process.env.LMNR_DEBUG_LOG;
  if (!file) return;
  try {
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // A broken log path must not break tracing.
  }
};
