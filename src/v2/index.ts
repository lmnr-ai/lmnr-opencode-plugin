import { Laminar, LaminarSpanProcessor } from "@lmnr-ai/lmnr";

import { resolveLaminarConfig } from "./config";
import { locationKey, ownsLocation } from "./location";
import { locationRouter, type LocationSpanRouter } from "./router";
import { SessionTracer } from "./tracer";
import type { PluginContext } from "./types";

const log = (level: "info" | "warn" | "error", message: string) => {
  console[level === "info" ? "log" : level](`[laminar] ${message}`);
};

// Cap on how long plugin cleanup waits for exports, so a slow or unreachable
// Laminar endpoint can't hold up OpenCode's shutdown.
const SHUTDOWN_FLUSH_TIMEOUT_MS = 5_000;

// `Laminar.initialize` validates the key even when it is given a span
// processor, so the router needs a placeholder. It never reaches an endpoint:
// every span is exported by the Location's own processor.
const ROUTER_API_KEY = "opencode-location-router";

let routerInstalled = false;

/**
 * Install the process-wide router once. The tracer provider is global by
 * design; the exporters are not. The base URL only satisfies the SDK's global
 * bookkeeping: no exporter is created here, because every span is delegated to
 * a Location's own processor.
 */
const ensureRouter = (baseUrl: string): LocationSpanRouter | undefined => {
  if (routerInstalled) return locationRouter;
  if (Laminar.initialized()) {
    log(
      "error",
      "Laminar is already initialized by another plugin; per-project tracing is unavailable",
    );
    return undefined;
  }
  Laminar.initialize({
    projectApiKey: ROUTER_API_KEY,
    baseUrl,
    spanProcessor: locationRouter,
    instrumentModules: {},
  });
  routerInstalled = true;
  return locationRouter;
};

// V2 builds spans from the public event stream and session hooks. The V1
// approach (enabling `experimental.openTelemetry` and re-parenting AI SDK
// spans) does not exist in V2.
export const setupV2 = async (ctx: PluginContext) => {
  const config = resolveLaminarConfig(ctx);
  if (!config.projectApiKey) {
    log("info", "LMNR_PROJECT_API_KEY not set, skipping Laminar tracing");
    return;
  }

  const router = ensureRouter(config.baseUrl);
  if (!router) return;

  // One pipeline per Location: a config or `.env` change on reload builds a new
  // processor instead of being ignored by a process-wide singleton.
  const key = locationKey(ctx.location);
  const processor = new LaminarSpanProcessor({
    apiKey: config.projectApiKey,
    baseUrl: config.baseUrl,
    ...(config.port !== undefined ? { port: config.port } : {}),
  });
  const unregister = router.register(key, processor);

  // Turn-end flushes run in the background, but short-lived runs such as
  // `opencode run` unload the plugin right after the last turn, so cleanup
  // waits for any flush still in flight.
  const inFlight = new Set<Promise<void>>();
  const flush = () => {
    const pending: Promise<void> = processor
      .forceFlush()
      .catch((error: unknown) => log("warn", `flush failed: ${String(error)}`))
      .finally(() => inFlight.delete(pending));
    inFlight.add(pending);
  };
  const tracer = new SessionTracer(flush, key);

  await ctx.session.hook("prompt", (event) => tracer.onPrompt(event));
  await ctx.session.hook("context", (event) => tracer.onContext(event, "primary"));
  await ctx.session.hook("compaction", (event) => tracer.onContext(event, "compaction"));

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        // The shared server may deliver events from other projects.
        if (!ownsLocation(event.location, ctx.location)) continue;
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

  log("info", `tracing initialized → ${config.baseUrl} (${ctx.location.directory})`);

  return async () => {
    controller.abort();
    tracer.shutdown();
    unregister();
    flush();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise((done) => (timer = setTimeout(done, SHUTDOWN_FLUSH_TIMEOUT_MS)));
    await Promise.race([Promise.allSettled(inFlight), timeout]);
    clearTimeout(timer);
    await processor
      .shutdown()
      .catch((error: unknown) => log("warn", `shutdown failed: ${String(error)}`));
  };
};
