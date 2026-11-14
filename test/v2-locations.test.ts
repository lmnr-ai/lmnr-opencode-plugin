import { Laminar, LaminarSpanProcessor } from "@lmnr-ai/lmnr";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";

import { locationRouter } from "../src/v2/router";
import { SessionTracer } from "../src/v2/tracer";
import type { OpenCodeEvent } from "../src/v2/types";

const exporters = {
  a: new InMemorySpanExporter(),
  b: new InMemorySpanExporter(),
};

before(() => {
  Laminar.initialize({
    projectApiKey: "test",
    spanProcessor: locationRouter,
    instrumentModules: {},
  });
  for (const [key, exporter] of Object.entries(exporters)) {
    locationRouter.register(
      key,
      new LaminarSpanProcessor({
        spanProcessor: new SimpleSpanProcessor(exporter),
      }),
    );
  }
});

afterEach(() => {
  for (const exporter of Object.values(exporters)) exporter.reset();
});

let clock = 1_700_000_000_000;
const ev = (type: string, data: Record<string, unknown>) =>
  ({ id: `evt_${clock}`, type, created: (clock += 10), data }) as unknown as OpenCodeEvent;

const turn = (tracer: SessionTracer, sessionID: string) => {
  tracer.handle(ev("session.execution.started", { sessionID }));
  tracer.handle(ev("session.execution.succeeded", { sessionID }));
};

describe("per-project exporters", () => {
  it("sends each session to the pipeline of its own Location", () => {
    turn(new SessionTracer(() => {}, "a"), "ses_a");
    turn(new SessionTracer(() => {}, "b"), "ses_b");
    turn(new SessionTracer(() => {}, "a"), "ses_a2");

    const names = (exporter: InMemorySpanExporter) =>
      exporter.getFinishedSpans().map((s) => s.name);
    const sessions = (exporter: InMemorySpanExporter) =>
      exporter
        .getFinishedSpans()
        .map((s) => s.attributes["lmnr.association.properties.session_id"]);

    assert.deepEqual(names(exporters.a), ["opencode turn", "opencode turn"]);
    assert.deepEqual(names(exporters.b), ["opencode turn"]);
    assert.deepEqual(sessions(exporters.a), ["ses_a", "ses_a2"]);
    assert.deepEqual(sessions(exporters.b), ["ses_b"]);
  });
});
