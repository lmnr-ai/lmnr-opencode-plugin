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

type Hook = (payload: any) => void | Promise<void>;

const ctxFor = (directory: string, root: string) => {
  // The host delivers a session's hooks to the Location that owns it.
  const hooks = new Map<string, Hook>();
  const ctx = {
    location: { directory, project: { id: root, directory: root, canonical: root } },
    options: { projectApiKey: "test", baseUrl: "http://127.0.0.1:1" },
    session: {
      hook: async (name: string, handler: Hook) => {
        hooks.set(name, handler);
      },
    },
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
  };
  return { ctx: ctx as unknown as PluginContext, hooks };
};

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
const cleanups: Array<() => void | Promise<void>> = [];

after(async () => {
  for (const cleanup of cleanups) await cleanup();
  await tracingRegistry().router.shutdown();
  resetRegistry();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("nested locations", () => {
  it("traces a session once, through the closest instance", async () => {
    const root = ctxFor("/tmp/lmnr-nested-integration", "/tmp/lmnr-nested-integration");
    const sub = ctxFor(`${root.ctx.location.directory}/packages/app`, root.ctx.location.directory);

    const rootCleanup = await setupV2(root.ctx);
    const subCleanup = await setupV2(sub.ctx);
    if (rootCleanup) cleanups.push(rootCleanup);
    if (subCleanup) cleanups.push(subCleanup);

    // Both instances share the pipeline; route it to an in-memory exporter so
    // the test can count the spans the session produced.
    tracingRegistry().router.register(
      locationKey(root.ctx.location),
      new LaminarSpanProcessor({ spanProcessor: new SimpleSpanProcessor(exporter) }),
    );

    // Let the two subscriptions start before the events arrive.
    await new Promise((resolve) => setImmediate(resolve));

    turn("ses_in_subdirectory", sub.ctx.location.directory);
    await settle();

    const located = turns();
    assert.equal(located.length, 1);
    assert.equal(
      located[0]?.attributes["lmnr.association.properties.session_id"],
      "ses_in_subdirectory",
    );

    // The session is claimed: a later event without a location stays with the
    // same tracer instead of reopening the conversation at the root.
    turn("ses_in_subdirectory");
    await settle();
    assert.equal(turns().length, 2);

    exporter.reset();
    // `location` is optional on the payload. The nested instance is the one
    // that received the session's hooks, so it is the one that must trace the
    // events, with the prompt the hook recorded.
    const sessionID = "ses_without_location";
    const messageID = "msg_1";
    await sub.hooks.get("prompt")!({
      sessionID,
      messageID,
      prompt: { text: "hello from the nested hook" },
      delivery: "steer",
    });
    emit(ev("session.inbox.enqueued", { sessionID, inboxID: messageID, item: {} }));
    turn(sessionID);
    await settle();

    const unlocated = turns();
    assert.equal(unlocated.length, 1);
    assert.equal(
      JSON.parse(unlocated[0]?.attributes["lmnr.span.input"] as string).text,
      "hello from the nested hook",
    );
  });

  it("closes the turn of the instance a reload takes the session from", async () => {
    exporter.reset();
    const directory = "/tmp/lmnr-nested-reload";
    const root = ctxFor(directory, directory);
    const rootCleanup = await setupV2(root.ctx);
    if (rootCleanup) cleanups.push(rootCleanup);

    tracingRegistry().router.register(
      locationKey(root.ctx.location),
      new LaminarSpanProcessor({ spanProcessor: new SimpleSpanProcessor(exporter) }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    // The nested location is not loaded yet, so the root traces the session.
    const sessionID = "ses_reload";
    emit(ev("session.execution.started", { sessionID }, `${directory}/packages/app`));
    await settle();
    assert.equal(turns().length, 0);

    // A reload loads the nested location, which is closer to the session: the
    // root must close the turn it can no longer end, instead of leaking it.
    const sub = ctxFor(`${directory}/packages/app`, directory);
    const subCleanup = await setupV2(sub.ctx);
    if (subCleanup) cleanups.push(subCleanup);
    emit(ev("session.execution.succeeded", { sessionID }, `${directory}/packages/app`));
    await settle();

    const exported = turns();
    assert.equal(exported.length, 1);
    assert.equal(exported[0]?.status.message, "session moved to another instance");
  });
});
