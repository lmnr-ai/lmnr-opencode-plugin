import { Laminar, LaminarSpanProcessor } from "@lmnr-ai/lmnr";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

import { debug } from "../debug";
import { endpointLabel, resolveLaminarConfig } from "./config";
import { locationKey } from "./location";
import {
  ownerKey,
  type PipelineEntry,
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
// The same grace period covers a project whose last instance unloaded, so a
// reload keeps the turn in flight while an abandoned one is finally closed.
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

/** Flush the project's exporter, keeping the promise for the next cleanup. */
const flush = (entry: PipelineEntry): void => {
  const pending: Promise<void> = entry.processor
    .forceFlush()
    .catch((error: unknown) => log("warn", `flush failed: ${String(error)}`))
    .finally(() => entry.inFlight.delete(pending));
  entry.inFlight.add(pending);
};

const later = (task: () => Promise<void>): void => {
  const timer = setTimeout(() => void task(), PROCESSOR_RETIRE_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
};

/**
 * Flush and close a pipeline that nothing uses any more.
 *
 * `cancelled` is checked when the grace period ends: a reload that was already
 * under way may have taken the pipeline over again in the meantime.
 */
const retirePipeline = (
  registry: TracingRegistry,
  key: string,
  entry: PipelineEntry,
  reason: string,
  cancelled: () => boolean = () => false,
): void => {
  later(async () => {
    if (cancelled()) {
      debug(`pipeline kept ${key}`);
      return;
    }
    try {
      entry.tracer.shutdown(reason);
      await entry.processor.forceFlush?.();
      await entry.processor.shutdown();
    } catch (error) {
      log("warn", `retired pipeline shutdown failed: ${String(error)}`);
    } finally {
      entry.detach();
      if (registry.entries.get(key) === entry) registry.entries.delete(key);
    }
  });
};

/** The project's pipeline, once the last instance of it unloads. */
const releasePipeline = (
  registry: TracingRegistry,
  key: string,
  entry: PipelineEntry,
): void => {
  entry.instances -= 1;
  if (entry.instances > 0) return;
  retirePipeline(
    registry,
    key,
    entry,
    "plugin unloaded",
    () => entry.instances > 0 || registry.entries.get(key) !== entry,
  );
};

/** Flush and close an exporter that a new configuration replaced. */
const retireProcessor = (processor: SpanProcessor, key: string): void => {
  later(async () => {
    try {
      await processor.forceFlush?.();
      await processor.shutdown();
    } catch (error) {
      log("warn", `retired exporter shutdown failed: ${String(error)}`);
    }
    debug(`exporter retired ${key}`);
  });
};

/**
 * One pipeline per project, reused across plugin reloads.
 *
 * Reloading the plugin must not create a new exporter or a new tracer: the ones
 * in flight still hold the open spans and the session state of the current turn.
 * A configuration change swaps the exporter inside the same entry, so every
 * instance of the project keeps forwarding into the tracer it already has; the
 * router keeps the spans that started under the old exporter on it, so they are
 * exported where they belong.
 */
const acquirePipeline = (
  registry: TracingRegistry,
  key: string,
  signature: string,
  createProcessor: () => SpanProcessor,
): PipelineEntry => {
  const existing = registry.entries.get(key);
  if (existing) {
    if (existing.signature !== signature) {
      const previous = existing.processor;
      existing.processor = createProcessor();
      existing.signature = signature;
      existing.detach();
      existing.detach = registry.router.register(key, existing.processor);
      debug(`exporter replaced ${key}`);
      retireProcessor(previous, key);
    }
    existing.instances += 1;
    debug(`pipeline reused ${key}`);
    return existing;
  }

  const processor = createProcessor();
  const entry: PipelineEntry = {
    signature,
    processor,
    inFlight: new Set(),
    instances: 1,
    detach: registry.router.register(key, processor),
    // The callback only runs once a turn ends, long after `entry` exists.
    tracer: new SessionTracer(() => flush(entry), key),
  };
  registry.entries.set(key, entry);
  // The signature contains the project API key: never put it in a log.
  debug(`pipeline created ${key}`);
  return entry;
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
  const entry = acquirePipeline(registry, key, JSON.stringify(config), () =>
    new LaminarSpanProcessor({
      apiKey: config.projectApiKey,
      baseUrl: config.baseUrl,
      ...(config.port !== undefined ? { port: config.port } : {}),
    }));
  // Every instance of the project forwards into the same tracer, so a hook that
  // arrives here and an event that arrives at a sibling still meet in one state.
  const tracer = entry.tracer;

  // Several instances of one project can be live at once: OpenCode loads the
  // plugin per location, and locations nest. They share the pipeline and the
  // tracer, so forwarding the same event twice is harmless; the closest
  // instance is the one that owns the project a payload names.
  const instance = registerInstance(registry, key, ctx.location);
  const controller = new AbortController();

  let stopped = false;
  const stop = async () => {
    // Cleanup may be called more than once; the project's reference count must
    // only drop once.
    if (stopped) return;
    stopped = true;
    controller.abort();
    unregisterInstance(registry, instance);
    // Turn-end flushes run in the background, but short-lived runs such as
    // `opencode run` unload the plugin right after the last turn, so cleanup
    // waits for any flush still in flight.
    flush(entry);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise((done) => (timer = setTimeout(done, SHUTDOWN_FLUSH_TIMEOUT_MS)));
    await Promise.race([Promise.allSettled(entry.inFlight), timeout]);
    clearTimeout(timer);
    // The pipeline stays registered: this unload may be a config reload in the
    // same process, and the next setup for this Location reuses it. Only when
    // the last instance of the project goes away is it flushed and closed.
    releasePipeline(registry, key, entry);
    debug(`cleanup ${key}`);
  };

  try {
    await ctx.session.hook("prompt", (event) => tracer.onPrompt(event));
    await ctx.session.hook("context", (event) => tracer.onContext(event, "primary"));
    await ctx.session.hook("compaction", (event) => tracer.onContext(event, "compaction"));
  } catch (error) {
    // A setup that fails must not keep the project's pipeline alive, nor an
    // instance that would win events it cannot trace.
    await stop();
    throw error;
  }

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const session = eventSession(event);
        // The shared server delivers every project's events to every instance.
        // The pipeline of the closest instance owns the project an event names;
        // every instance of that pipeline forwards it, which is harmless
        // because they share a tracer. A payload without a location uses the
        // location its session was last seen at, or is traced only when this
        // project already holds the session.
        const location =
          event.location ?? (session !== undefined ? tracer.locationOf(session) : undefined);
        const forwarded =
          location !== undefined
            ? ownerKey(registry, location) === key
            : session !== undefined && tracer.knows(session);
        if (!forwarded) {
          // Another project owns the session now: close what was opened here,
          // or those spans would never see their end events.
          if (session !== undefined && location !== undefined) tracer.abandon(session);
          continue;
        }
        // Two instances of one project forward the same event: trace it once.
        if (!tracer.accept(event)) continue;
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

  return stop;
};
