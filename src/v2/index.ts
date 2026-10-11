import { Laminar } from "@lmnr-ai/lmnr";

import { loadEnv } from "../utils";
import { SessionTracer } from "./tracer";
import type { PluginContext } from "./types";

const log = (level: "info" | "warn" | "error", message: string) => {
  console[level === "info" ? "log" : level](`[laminar] ${message}`);
};

// Cap on how long plugin cleanup waits for exports, so a slow or unreachable
// Laminar endpoint can't hold up OpenCode's shutdown.
const SHUTDOWN_FLUSH_TIMEOUT_MS = 5_000;

const stringOption = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

// V2 builds spans from the public event stream and session hooks. The V1
// approach (enabling `experimental.openTelemetry` and re-parenting AI SDK
// spans) does not exist in V2.
export const setupV2 = async (ctx: PluginContext) => {
  loadEnv({ quiet: true, dir: ctx.location.directory });
  const projectApiKey =
    stringOption(ctx.options.projectApiKey) ?? process.env.LMNR_PROJECT_API_KEY;
  if (!projectApiKey) {
    log("info", "LMNR_PROJECT_API_KEY not set, skipping Laminar tracing");
    return;
  }
  const baseUrl =
    stringOption(ctx.options.baseUrl) ?? process.env.LMNR_BASE_URL ?? "https://api.lmnr.ai";
  const grpcPort = process.env.LMNR_GRPC_PORT
    ? Number(process.env.LMNR_GRPC_PORT)
    : baseUrl === "https://api.lmnr.ai"
      ? 8443
      : undefined;

  if (!Laminar.initialized()) {
    Laminar.initialize({
      projectApiKey,
      baseUrl,
      ...(grpcPort ? { grpcPort } : {}),
      // OpenCode V2 calls providers through its own client, so there is
      // nothing to auto-instrument; spans come from the tracer below.
      instrumentModules: {},
    });
  }

  // Turn-end flushes run in the background, but short-lived runs such as
  // `opencode run` unload the plugin right after the last turn, so cleanup
  // waits for any flush still in flight.
  const inFlight = new Set<Promise<void>>();
  const flush = () => {
    const pending: Promise<void> = Laminar.flush()
      .catch((error: unknown) => log("warn", `flush failed: ${String(error)}`))
      .finally(() => inFlight.delete(pending));
    inFlight.add(pending);
  };
  const tracer = new SessionTracer(flush);

  await ctx.session.hook("prompt", (event) => tracer.onPrompt(event));
  await ctx.session.hook("context", (event) => tracer.onContext(event, "primary"));
  await ctx.session.hook("compaction", (event) => tracer.onContext(event, "compaction"));

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          tracer.handle(event);
        } catch (error) {
          log("warn", `failed to trace ${event.type}: ${String(error)}`);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) log("error", `event stream ended: ${String(error)}`);
    }
  })();

  log("info", `tracing initialized → ${baseUrl}`);

  return async () => {
    controller.abort();
    tracer.shutdown();
    flush();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise((done) => (timer = setTimeout(done, SHUTDOWN_FLUSH_TIMEOUT_MS)));
    await Promise.race([Promise.allSettled(inFlight), timeout]);
    clearTimeout(timer);
  };
};
