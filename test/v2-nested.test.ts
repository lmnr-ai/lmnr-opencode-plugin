import { LaminarSpanProcessor } from "@lmnr-ai/lmnr";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { setupV2 } from "../src/v2";
import { locationKey } from "../src/v2/location";
import { resetRegistry, tracingRegistry } from "../src/v2/registry";
import type { OpenCodeEvent, PluginContext } from "../src/v2/types";

// Every instance subscribes to the same broadcast stream, as in the shared
// OpenCode server.
const subscribers = new Set<(event: OpenCodeEvent) => void>();

const emit = (event: OpenCodeEvent) => {
  for (const push of subscribers) push(event);
};

const ctxFor = (directory: string, root: string) =>
  ({
    location: { directory, project: { id: root, directory: root, canonical: root } },
    options: { projectApiKey: "test", baseUrl: "http://127.0.0.1:1" },
    session: { hook: async () => {} },
    event: {
      subscribe: (opts: { signal?: AbortSignal } = {}) => {
        const queue: OpenCodeEvent[] = [];
        let wake: (() => void) | undefined;
        const push = (event: OpenCodeEvent) => {
          queue.push(event);
          wake?.();
        };
        subscribers.add(push);
        opts.signal?.addEventListener(
          "abort",
          () => {
            subscribers.delete(push);
            wake?.();
          },
          { once: true },
        );
        return (async function* () {
          while (!opts.signal?.aborted) {
            for (let next = queue.shift(); next; next = queue.shift()) yield next;
            await new Promise<void>((resolve) => (wake = resolve));
            wake = undefined;
          }
        })();
      },
    },
  }) as unknown as PluginContext;

let clock = 1_700_000_000_000;
const ev = (type: string, data: Record<string, unknown>, directory?: string) =>
  ({
    id: `evt_${clock}`,
    type,
    created: (clock += 10),
    data,
    ...(directory !== undefined ? { location: { directory } } : {}),
  }) as unknown as OpenCodeEvent;

const turn = (sessionID: string, directory?: string) => {
  emit(ev("session.execution.started", { sessionID }, directory));
  emit(ev("session.execution.succeeded", { sessionID }, directory));
};

const turns = () => exporter.getFinishedSpans().filter((span) => span.name === "opencode turn");

const exporter = new InMemorySpanExporter();

after(async () => {
  for (const cleanup of cleanups) await cleanup();
  await tracingRegistry().router.shutdown();
  resetRegistry();
});

const cleanups: Array<() => Promise<void>> = [];

describe("nested locations", () => {
  it("traces a session once, through the closest instance", async () => {
    const root = ctxFor("/tmp/lmnr-nested-integration", "/tmp/lmnr-nested-integration");
    const sub = ctxFor(`${root.location.directory}/packages/app`, root.location.directory);

    const rootCleanup = await setupV2(root);
    const subCleanup = await setupV2(sub);
    if (rootCleanup) cleanups.push(rootCleanup);
    if (subCleanup) cleanups.push(subCleanup);

    // Both instances share the pipeline; route it to an in-memory exporter so
    // the test can count the spans the session produced.
    tracingRegistry().router.register(
      locationKey(root.location),
      new LaminarSpanProcessor({ spanProcessor: new SimpleSpanProcessor(exporter) }),
    );

    // Let the two subscriptions start before the events arrive.
    await new Promise((resolve) => setImmediate(resolve));

    turn("ses_in_subdirectory", sub.location.directory);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const located = turns();
    assert.equal(located.length, 1);
    assert.equal(
      located[0]?.attributes["lmnr.association.properties.session_id"],
      "ses_in_subdirectory",
    );

    exporter.reset();
    // `location` is optional on the payload: a nested instance must not trace
    // the same legacy event again.
    turn("ses_without_location");
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(turns().length, 1);
  });
});
