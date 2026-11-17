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

const turns = (exporter: InMemorySpanExporter) =>
  exporter.getFinishedSpans().filter((span) => span.name === "opencode turn");

const cleanups: Array<() => void | Promise<void>> = [];

after(async () => {
  for (const cleanup of cleanups) await cleanup();
  await tracingRegistry().router.shutdown();
  resetRegistry();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

const start = async (directory: string, root: string) => {
  const target = ctxFor(directory, root);
  const cleanup = await setupV2(target.ctx);
  if (cleanup) cleanups.push(cleanup);
  return target;
};

// The project's spans are routed to an in-memory exporter, whatever pipeline
// its instances created.
const capture = (exporter: InMemorySpanExporter, location: PluginContext["location"]) =>
  tracingRegistry().router.register(
    locationKey(location),
    new LaminarSpanProcessor({ spanProcessor: new SimpleSpanProcessor(exporter) }),
  );

const exporter = new InMemorySpanExporter();

describe("nested locations", () => {
  it("traces a turn once, with the hooks of whichever instance received them", async () => {
    exporter.reset();
    const root = await start("/tmp/lmnr-nested-hooks", "/tmp/lmnr-nested-hooks");
    await start(`${root.ctx.location.directory}/packages/app`, root.ctx.location.directory);
    capture(exporter, root.ctx.location);
    await new Promise((resolve) => setImmediate(resolve));

    // One project, one tracer: the prompt arrives at the root, the events name
    // the nested directory, and the turn still gets its input.
    const sessionID = "ses_split_sources";
    const messageID = "msg_1";
    await root.hooks.get("prompt")!({
      sessionID,
      messageID,
      prompt: { text: "hello from another instance" },
      delivery: "steer",
    });
    emit(ev("session.inbox.enqueued", { sessionID, inboxID: messageID, item: {} }));
    turn(sessionID, `${root.ctx.location.directory}/packages/app`);
    await settle();

    const traced = turns(exporter);
    assert.equal(traced.length, 1);
    assert.equal(
      JSON.parse(traced[0]?.attributes["lmnr.span.input"] as string).text,
      "hello from another instance",
    );
  });

  it("keeps the turn in flight when the location loads during it", async () => {
    exporter.reset();
    const root = await start("/tmp/lmnr-nested-reload", "/tmp/lmnr-nested-reload");
    capture(exporter, root.ctx.location);
    await new Promise((resolve) => setImmediate(resolve));

    // The nested location is not loaded yet, so the root traces the session.
    const sessionID = "ses_reload";
    const nested = `${root.ctx.location.directory}/packages/app`;
    emit(ev("session.execution.started", { sessionID }, nested));
    await settle();
    assert.equal(turns(exporter).length, 0);

    // Loading it hands the events over to the instance that is now closest, but
    // the tracer is the project's, so the same turn is the one that ends.
    await start(nested, root.ctx.location.directory);
    emit(ev("session.execution.succeeded", { sessionID }, nested));
    await settle();

    const traced = turns(exporter);
    assert.equal(traced.length, 1);
    assert.equal(traced[0]?.status.message, undefined);
  });

  it("keeps forwarding to a sibling while another instance is starting", async () => {
    exporter.reset();
    const base = "/tmp/lmnr-nested-setup";
    const root = await start(base, base);
    capture(exporter, root.ctx.location);
    await new Promise((resolve) => setImmediate(resolve));

    const sessionID = "ses_during_setup";
    const nested = `${base}/packages/app`;
    emit(ev("session.execution.started", { sessionID }, nested));
    await settle();

    // The new instance registers only once its hooks are in place, so the turn
    // that ends during its setup is not taken away from the running one.
    const loading = setupV2(ctxFor(nested, base).ctx);
    emit(ev("session.execution.succeeded", { sessionID }, nested));
    await settle();
    const cleanup = await loading;
    if (cleanup) cleanups.push(cleanup);

    assert.equal(turns(exporter).length, 1);
    assert.equal(turns(exporter)[0]?.status.message, undefined);
  });

  it("closes the turn of a project that hands a session to a nested project", async () => {
    exporter.reset();
    const inner = new InMemorySpanExporter();
    const base = "/tmp/lmnr-handoff";
    const outer = await start(base, base);
    capture(exporter, outer.ctx.location);
    await new Promise((resolve) => setImmediate(resolve));

    const nested = `${base}/vendor/lib`;
    const sessionID = "ses_handoff";
    emit(ev("session.execution.started", { sessionID }, nested));
    await settle();

    // The nested project loads: the session is now its business.
    const nestedCtx = ctxFor(nested, nested);
    const cleanup = await setupV2(nestedCtx.ctx);
    if (cleanup) cleanups.push(cleanup);
    capture(inner, nestedCtx.ctx.location);
    emit(ev("session.execution.succeeded", { sessionID }, nested));
    await settle();

    // The outer project closes the turn it can no longer end, and does not
    // reopen it for the events that carry no location of their own.
    turn(sessionID);
    await settle();

    assert.equal(turns(exporter).length, 1);
    assert.equal(turns(exporter)[0]?.status.message, "session moved to another project");
    assert.equal(turns(inner).length, 1);
  });

  it("leaves a nested project's sessions to the nested project", async () => {
    exporter.reset();
    const inner = new InMemorySpanExporter();
    const outer = await start("/tmp/lmnr-outer-project", "/tmp/lmnr-outer-project");
    const nested = await start(
      "/tmp/lmnr-outer-project/vendor/lib",
      "/tmp/lmnr-outer-project/vendor/lib",
    );
    capture(exporter, outer.ctx.location);
    capture(inner, nested.ctx.location);
    await new Promise((resolve) => setImmediate(resolve));

    turn("ses_nested_project", nested.ctx.location.directory);
    await settle();

    assert.equal(turns(inner).length, 1);
    assert.equal(turns(exporter).length, 0);
  });

  it("leaves another project's sessions to that project", async () => {
    exporter.reset();
    const other = new InMemorySpanExporter();
    const first = await start("/tmp/lmnr-project-one", "/tmp/lmnr-project-one");
    const second = await start("/tmp/lmnr-project-two", "/tmp/lmnr-project-two");
    capture(exporter, first.ctx.location);
    capture(other, second.ctx.location);
    await new Promise((resolve) => setImmediate(resolve));

    turn("ses_project_one", first.ctx.location.directory);
    await settle();

    assert.equal(turns(exporter).length, 1);
    assert.equal(turns(other).length, 0);
  });
});
