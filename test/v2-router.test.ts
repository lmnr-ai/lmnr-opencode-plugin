import { LaminarSpanProcessor } from "@lmnr-ai/lmnr";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LOCATION_ATTRIBUTE, LocationSpanRouter } from "../src/v2/router";

const exporterFor = () => {
  const exporter = new InMemorySpanExporter();
  const processor = new LaminarSpanProcessor({
    spanProcessor: new SimpleSpanProcessor(exporter),
  });
  return { exporter, processor };
};

const providerFor = (router: LocationSpanRouter) => {
  const provider = new BasicTracerProvider({ spanProcessors: [router] });
  return { provider, tracer: provider.getTracer("router-test") };
};

const emit = (tracer: { startSpan: (name: string, options?: any) => any }, name: string, key: string) => {
  const span = tracer.startSpan(name, { attributes: { [LOCATION_ATTRIBUTE]: key } });
  span.end();
};

describe("LocationSpanRouter", () => {
  it("exports each Location to its own pipeline", () => {
    const router = new LocationSpanRouter();
    const a = exporterFor();
    const b = exporterFor();
    router.register("A", a.processor);
    router.register("B", b.processor);
    const { tracer } = providerFor(router);

    emit(tracer, "a.work", "A");
    emit(tracer, "b.work", "B");

    assert.deepEqual(a.exporter.getFinishedSpans().map((s) => s.name), ["a.work"]);
    assert.deepEqual(b.exporter.getFinishedSpans().map((s) => s.name), ["b.work"]);
  });

  it("drops spans for a Location without a pipeline", () => {
    const router = new LocationSpanRouter();
    const a = exporterFor();
    router.register("A", a.processor);
    const { tracer } = providerFor(router);

    emit(tracer, "unknown.work", "missing");

    assert.equal(a.exporter.getFinishedSpans().length, 0);
  });

  it("replaces a Location's pipeline on reload without touching the old one", () => {
    const router = new LocationSpanRouter();
    const first = exporterFor();
    const second = exporterFor();
    const unregisterFirst = router.register("A", first.processor);
    const { tracer } = providerFor(router);

    emit(tracer, "before.reload", "A");
    router.register("A", second.processor);
    assert.equal(unregisterFirst(), false);
    emit(tracer, "after.reload", "A");

    assert.deepEqual(first.exporter.getFinishedSpans().map((s) => s.name), ["before.reload"]);
    assert.deepEqual(second.exporter.getFinishedSpans().map((s) => s.name), ["after.reload"]);
  });

  it("unregisters only the current pipeline", () => {
    const router = new LocationSpanRouter();
    const processor = exporterFor().processor;
    const unregister = router.register("A", processor);

    assert.equal(unregister(), true);
    assert.equal(unregister(), false);
  });

  it("flushes and shuts down every pipeline once", async () => {
    const router = new LocationSpanRouter();
    const a = exporterFor();
    const b = exporterFor();
    router.register("A", a.processor);
    router.register("A", a.processor);
    router.register("B", b.processor);
    const { tracer } = providerFor(router);

    emit(tracer, "before.shutdown", "A");
    await router.forceFlush();
    assert.deepEqual(a.exporter.getFinishedSpans().map((s) => s.name), ["before.shutdown"]);

    await router.shutdown();
    emit(tracer, "after.shutdown", "A");

    // shutdown() stops the pipeline: the span after it is dropped, not queued.
    assert.equal(a.exporter.getFinishedSpans().length, 0);
    assert.equal(b.exporter.getFinishedSpans().length, 0);
  });
});
