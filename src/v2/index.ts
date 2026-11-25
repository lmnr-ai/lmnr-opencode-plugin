import { Laminar, LaminarSpanProcessor } from "@lmnr-ai/lmnr";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

import { debug } from "../debug";
import {
  endpointLabel,
  type LaminarConfig,
  resolveLaminarConfig,
  sameLaminarConfig,
} from "./config";
import { locationKey } from "./location";
import { type Pipeline, type TracingRegistry, tracingRegistry } from "./registry";
import type { LocationSpanRouter } from "./router";
import { eventSession, SessionTracer } from "./tracer";
import type { PluginContext } from "./types";

const log = (level: "info" | "warn" | "error", message: string) => {
  console[level === "info" ? "log" : level](`[laminar] ${message}`);
};

// Cap on how long plugin cleanup waits for exports, so a slow or unreachable
// Laminar endpoint can't hold up OpenCode's shutdown.
const SHUTDOWN_FLUSH_TIMEOUT_MS = 5_000;

// A pipeline whose last instance unloaded is kept for a reload, so the tracer
// keeps the turn in flight instead of starting a second one. This is not a
// deadline for spans: it only decides when an idle pipeline is closed.
const DEFAULT_PIPELINE_RETIRE_MS = 60_000;

const pipelineRetireMs = (): number => {
  const raw = process.env.LMNR_PIPELINE_RETIRE_MS;
  const value = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PIPELINE_RETIRE_MS;
};

const PIPELINE_RETIRE_MS = pipelineRetireMs();

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

/** Flush a pipeline's exporter, keeping the promise for the next cleanup. */
const flush = (pipeline: Pipeline, processor: SpanProcessor = pipeline.processor): void => {
  const pending: Promise<void> = processor
    .forceFlush()
    .catch((error: unknown) => log("warn", `flush failed: ${String(error)}`))
    .finally(() => pipeline.inFlight.delete(pending));
  pipeline.inFlight.add(pending);
};

const delay = (task: () => Promise<void>): void => {
  const timer = setTimeout(() => void task(), PIPELINE_RETIRE_MS);
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
  pipeline: Pipeline,
  reason: string,
  cancelled: () => boolean = () => false,
): void => {
  delay(async () => {
    if (cancelled()) {
      debug(`pipeline kept ${key}`);
      return;
    }
    try {
      pipeline.tracer.shutdown(reason);
      await pipeline.processor.forceFlush?.();
      await pipeline.processor.shutdown();
    } catch (error) {
      log("warn", `retired pipeline shutdown failed: ${String(error)}`);
    } finally {
      pipeline.detach();
      if (registry.pipelines.get(key) === pipeline) registry.pipelines.delete(key);
    }
  });
};

/** The project's pipeline, once the last instance of it unloads. */
const releasePipeline = (
  registry: TracingRegistry,
  key: string,
  pipeline: Pipeline,
): void => {
  pipeline.instanceCount -= 1;
  if (pipeline.instanceCount > 0) return;
  retirePipeline(
    registry,
    key,
    pipeline,
    "plugin unloaded",
    () => pipeline.instanceCount > 0 || registry.pipelines.get(key) !== pipeline,
  );
};

/**
 * Flush and close an exporter that a new configuration replaced.
 *
 * The router resolves the pipeline when a span ends, so a span already in
 * flight finishes on the new exporter; the old one only has buffered spans
 * left, and shutting it down flushes them.
 */
const closeProcessor = (pipeline: Pipeline, processor: SpanProcessor, key: string): void => {
  const pending: Promise<void> = (async () => {
    try {
      await processor.forceFlush?.();
      await processor.shutdown();
    } catch (error) {
      log("warn", `retired exporter shutdown failed: ${String(error)}`);
    }
    debug(`exporter retired ${key}`);
  })();
  pipeline.inFlight.add(pending);
  void pending.finally(() => pipeline.inFlight.delete(pending));
};

/**
 * One pipeline per project, reused across plugin reloads.
 *
 * Reloading the plugin must not create a new exporter or a new tracer: the ones
 * in flight still hold the open spans and the session state of the current turn.
 * A configuration change swaps the exporter inside the same pipeline, so every
 * instance of the project keeps forwarding into the tracer it already has; the
 * router keeps the spans that started under the old exporter on it, so they are
 * exported where they belong.
 */
const acquirePipeline = (
  registry: TracingRegistry,
  key: string,
  config: LaminarConfig,
  createProcessor: () => SpanProcessor,
): Pipeline => {
  const existing = registry.pipelines.get(key);
  if (existing) {
    if (!sameLaminarConfig(existing.config, config)) {
      const previous = existing.processor;
      existing.processor = createProcessor();
      existing.config = config;
      existing.detach();
      existing.detach = registry.router.register(key, existing.processor);
      closeProcessor(existing, previous, key);
      debug(`exporter replaced ${key}`);
    }
    existing.instanceCount += 1;
    debug(`pipeline reused ${key}`);
    return existing;
  }

  const processor = createProcessor();
  const pipeline: Pipeline = {
    config,
    processor,
    inFlight: new Set(),
    instanceCount: 1,
    detach: registry.router.register(key, processor),
    // The callback only runs once a turn ends, long after `pipeline` exists.
    tracer: new SessionTracer(() => flush(pipeline), key),
  };
  registry.pipelines.set(key, pipeline);
  // The config contains the project API key: never put it in a log.
  debug(`pipeline created ${key}`);
  return pipeline;
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
  const pipeline = acquirePipeline(registry, key, config, () =>
    new LaminarSpanProcessor({
      apiKey: config.projectApiKey,
      baseUrl: config.baseUrl,
      ...(config.port !== undefined ? { port: config.port } : {}),
    }));
  // Every instance of the project forwards into the same tracer, so a hook that
  // arrives here and an event that arrives at a sibling still meet in one state.
  const tracer = pipeline.tracer;

  // Several instances of one project can be live at once: OpenCode loads the
  // plugin per location, and locations nest. They share the pipeline and the
  // tracer, so forwarding the same event twice is harmless; the closest
  // instance is the one that owns the project a payload names.
  const removeInstance = registry.addInstance(key, ctx.location);
  const controller = new AbortController();

  let stopped = false;
  const stop = async () => {
    // Cleanup may be called more than once; the project's reference count must
    // only drop once.
    if (stopped) return;
    stopped = true;
    controller.abort();
    removeInstance();
    // Turn-end flushes run in the background, but short-lived runs such as
    // `opencode run` unload the plugin right after the last turn, so cleanup
    // waits for any flush still in flight.
    flush(pipeline);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise((done) => (timer = setTimeout(done, SHUTDOWN_FLUSH_TIMEOUT_MS)));
    await Promise.race([Promise.allSettled(pipeline.inFlight), timeout]);
    clearTimeout(timer);
    // The pipeline stays registered: this unload may be a config reload in the
    // same process, and the next setup for this Location reuses it. Only when
    // the last instance of the project goes away is it flushed and closed.
    releasePipeline(registry, key, pipeline);
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
            ? registry.ownerKey(location) === key
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
