import type { Context, Span } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";

export const LOCATION_METADATA_KEY = "opencodeLocation";

/**
 * `Laminar.startSpan` turns `metadata` into span attributes before the span is
 * created, so the router can pick the exporter in `onStart`.
 */
export const LOCATION_ATTRIBUTE =
  `lmnr.association.properties.metadata.${LOCATION_METADATA_KEY}`;

/**
 * One global dispatcher, one exporter pipeline per Location.
 *
 * OpenCode keeps a single server alive for every project: a process-wide
 * `Laminar.initialize()` would let the first project decide the endpoint for
 * all of them. The router stays global because the tracer provider must be, but
 * it owns no configuration: each Location registers its own `LaminarSpanProcessor`
 * built from its own options and `.env`.
 */
export class LocationSpanRouter implements SpanProcessor {
  private readonly processors = new Map<string, SpanProcessor>();
  private readonly spanProcessors = new Map<string, SpanProcessor>();

  /**
   * Route the spans tagged with `key` to `processor`.
   *
   * The returned function unregisters this processor only if it is still the
   * current one, so a reload's cleanup cannot remove its replacement.
   */
  register(key: string, processor: SpanProcessor): () => boolean {
    this.processors.set(key, processor);
    return () => {
      if (this.processors.get(key) !== processor) return false;
      this.processors.delete(key);
      return true;
    };
  }

  onStart(span: Span, parentContext: Context): void {
    const attributes = (span as unknown as ReadableSpan).attributes;
    const key = attributes?.[LOCATION_ATTRIBUTE];
    if (typeof key !== "string") return;
    const processor = this.processors.get(key);
    if (!processor) return;
    this.spanProcessors.set(span.spanContext().spanId, processor);
    processor.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    const spanId = span.spanContext().spanId;
    const processor = this.spanProcessors.get(spanId);
    if (!processor) return;
    try {
      processor.onEnd(span);
    } finally {
      this.spanProcessors.delete(spanId);
    }
  }

  async forceFlush(): Promise<void> {
    await Promise.all([...new Set(this.processors.values())].map((p) => p.forceFlush()));
  }

  async shutdown(): Promise<void> {
    const processors = [...new Set(this.processors.values())];
    this.processors.clear();
    this.spanProcessors.clear();
    await Promise.all(processors.map((p) => p.shutdown()));
  }
}

/** Process-wide router, used by the plugin and by the tests. */
export const locationRouter = new LocationSpanRouter();
