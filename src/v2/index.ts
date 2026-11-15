import { Laminar, LaminarSpanProcessor } from "@lmnr-ai/lmnr";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

import { debug } from "../debug";
import { endpointLabel, resolveLaminarConfig } from "./config";
import { locationKey } from "./location";
import {
  ownsEvent,
  registerInstance,
  type TracingRegistry,
  tracingRegistry,
  unregisterInstance,
} from "./registry";
import type { LocationSpanRouter } from "./router";
import { eventSession, SessionTracer } from "./tracer";
import type { PluginContext } from "./types";

const log = (level: "info" | "warn" | "error", message: string) => {
  console[level === "info" ? "log" : level](`[laminar] ${message}`);
};

// Cap on how long plugin cleanup waits for exports, so a slow or unreachable
// Laminar endpoint can't hold up OpenCode's shutdown.
const SHUTDOWN_FLUSH_TIMEOUT_MS = 5_000;

// A pipeline that is replaced keeps exporting the spans that started under it.
// The grace period is longer than a model turn is likely to stay open.
const PROCESSOR_RETIRE_MS = 30_000;

// `Laminar.initialize` validates the key even when it is given a span
// processor, so the router needs a placeholder. It never reaches an endpoint:
// every span is exported by the Location's own processor.
const ROUTER_API_KEY = "opencode-location-router";

/**
 * Install the process-wide router once.
 *
 * OpenCode re-evaluates the plugin in the same server process, so this must be
 * idempotent: only the first evaluation initializes Laminar, and the rest reuse
 * the router kept on the global object. The tracer provider is global by
 * design; the exporters are not.
 */
const installRouter = (
  registry: TracingRegistry,
  baseUrl: string,
): LocationSpanRouter | undefined => {
  if (!Laminar.initialized()) {
    Laminar.initialize({
      projectApiKey: ROUTER_API_KEY,
      baseUrl,
      spanProcessor: registry.router,
      instrumentModules: {},
    });
    registry.installed = true;
    debug(`router installed (${baseUrl})`);
    return registry.router;
  }
  if (!registry.installed) {
    log(
      "error",
      "Laminar was initialized outside this plugin; per-project tracing is unavailable",
    );
    debug("router unavailable: foreign Laminar initializer");
    return undefined;
  }
  debug("router reused");
  return registry.router;
};

const retireProcessor = (processor: SpanProcessor): void => {
  const timer = setTimeout(() => {
    void (async () => {
      try {
        await processor.forceFlush?.();
        await processor.shutdown();
      } catch (error) {
        log("warn", `retired pipeline shutdown failed: ${String(error)}`);
      }
    })();
  }, PROCESSOR_RETIRE_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
};

/**
 * One pipeline per Location, reused across plugin reloads.
 *
 * Reloading the plugin must not create a new exporter: the one in flight still
 * holds the open spans of the current turn. It is replaced only when the
 * resolved configuration actually changes.
 */
const acquireProcessor = (
  registry: TracingRegistry,
  key: string,
  signature: string,
  create: () => SpanProcessor,
): SpanProcessor => {
  const existing = registry.entries.get(key);
  if (existing && existing.signature === signature) {
    debug(`pipeline reused ${key}`);
    return existing.processor;
  }

  const processor = create();
  registry.router.register(key, processor);
  registry.entries.set(key, { signature, processor });
  // The signature contains the project API key: never put it in a log.
  debug(`pipeline created ${key}`);
  if (existing) retireProcessor(existing.processor);
  return processor;
};

// V2 builds spans from the public event stream and session hooks. The V1
// approach (enabling `experimental.openTelemetry` and re-parenting AI SDK
// spans) does not exist in V2.
export const setupV2 = async (ctx: PluginContext) => {
  const config = resolveLaminarConfig(ctx);
  debug(`setup ${ctx.location.directory} endpoint=${endpointLabel(config)}`);
  if (!config.projectApiKey) {
    log("info", "LMNR_PROJECT_API_KEY not set, skipping Laminar tracing");
    debug(`setup skipped ${ctx.location.directory}: no project API key`);
    return;
  }

  const registry = tracingRegistry();
  const router = installRouter(registry, config.baseUrl);
  if (!router) return;

  const key = locationKey(ctx.location);
  const processor = acquireProcessor(registry, key, JSON.stringify(config), () =>
    new LaminarSpanProcessor({
      apiKey: config.projectApiKey,
      baseUrl: config.baseUrl,
      ...(config.port !== undefined ? { port: config.port } : {}),
    }));

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

  // Several instances of one project can be live at once: OpenCode loads the
  // plugin per location, and locations nest. They share the pipeline, and the
  // registry picks which of them traces each event. Registered last, so a
  // failed setup leaves no instance behind to swallow the events.
  const instance = registerInstance(registry, ctx.location);
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        // The shared server may deliver events from other projects, and every
        // nested instance of this one: only the closest instance traces them.
        // `location` is optional, and an event without one can only be traced
        // by the instance that already holds the session, usually through the
        // hooks it was the only one to receive.
        const session = eventSession(event);
        const owned =
          event.location !== undefined
            ? ownsEvent(registry, instance, event.location)
            : session !== undefined && tracer.knows(session);
        if (!owned) continue;
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

  log("info", `tracing initialized → ${endpointLabel(config)} (${ctx.location.directory})`);
  debug(`tracing ready ${key} ${endpointLabel(config)}`);

  return async () => {
    controller.abort();
    unregisterInstance(registry, instance);
    tracer.shutdown();
    flush();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise((done) => (timer = setTimeout(done, SHUTDOWN_FLUSH_TIMEOUT_MS)));
    await Promise.race([Promise.allSettled(inFlight), timeout]);
    clearTimeout(timer);
    // The pipeline stays registered: this unload may be a config reload in the
    // same process, and the next setup for this Location reuses it.
    debug(`cleanup ${key}`);
  };
};
