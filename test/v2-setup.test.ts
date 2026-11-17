import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { setupV2 } from "../src/v2";
import { locationKey } from "../src/v2/location";
import { resetRegistry, tracingRegistry } from "../src/v2/registry";
import type { PluginContext } from "../src/v2/types";

const ctxFor = (dir: string, options: Record<string, unknown>, root = dir) =>
  ({
    location: {
      directory: dir,
      project: { id: root, directory: root, canonical: root },
    },
    options,
    session: { hook: async () => {} },
    event: {
      subscribe: (opts: { signal?: AbortSignal } = {}) =>
        (async function* () {
          await new Promise<void>((resolve) => {
            if (opts.signal?.aborted) return resolve();
            opts.signal?.addEventListener("abort", () => resolve(), { once: true });
            return undefined;
          });
        })(),
    },
  }) as unknown as PluginContext;

const base = { projectApiKey: "test", baseUrl: "http://127.0.0.1:1" };

const keyOf = (dir: string) => locationKey(ctxFor(dir, base).location);

after(async () => {
  await tracingRegistry().router.shutdown();
  resetRegistry();
});

describe("setupV2 reloads", () => {
  it("reuses the Location's pipeline when the configuration is unchanged", async () => {
    const dir = "/tmp/lmnr-setup-reuse";
    const key = keyOf(dir);

    await (await setupV2(ctxFor(dir, base)))?.();
    const processor = tracingRegistry().entries.get(key)?.processor;
    assert.ok(processor);

    await (await setupV2(ctxFor(dir, base)))?.();

    assert.equal(tracingRegistry().entries.get(key)?.processor, processor);
    assert.equal(tracingRegistry().installed, true);
  });

  it("keeps the pipeline registered after cleanup", async () => {
    const dir = "/tmp/lmnr-setup-cleanup";
    const key = keyOf(dir);

    const cleanup = await setupV2(ctxFor(dir, base));
    await cleanup?.();

    assert.ok(tracingRegistry().entries.has(key));
  });

  it("replaces the pipeline when the configuration changes", async () => {
    const dir = "/tmp/lmnr-setup-replace";
    const key = keyOf(dir);

    await (await setupV2(ctxFor(dir, base)))?.();
    const first = tracingRegistry().entries.get(key)?.processor;

    await (await setupV2(ctxFor(dir, { ...base, baseUrl: "http://127.0.0.1:2" })))?.();
    const second = tracingRegistry().entries.get(key)?.processor;

    assert.ok(first);
    assert.ok(second);
    assert.notEqual(second, first);
  });
});

describe("setupV2 nested locations", () => {
  it("gives the whole project one pipeline", async () => {
    const root = "/tmp/lmnr-setup-nested";
    const sub = `${root}/packages/app`;

    // Both instances stay loaded, as in a server with two nested locations.
    await setupV2(ctxFor(root, base, root));
    const key = locationKey(ctxFor(root, base, root).location);
    const pipeline = tracingRegistry().entries.get(key);
    const pipelines = tracingRegistry().entries.size;

    await setupV2(ctxFor(sub, base, root));

    assert.equal(locationKey(ctxFor(sub, base, root).location), key);
    // One exporter and one tracer for the project: hooks and events of its
    // locations meet in the same state.
    assert.equal(tracingRegistry().entries.get(key)?.processor, pipeline?.processor);
    assert.equal(tracingRegistry().entries.get(key)?.tracer, pipeline?.tracer);
    assert.equal(tracingRegistry().entries.get(key)?.instances, 2);
    assert.equal(tracingRegistry().entries.size, pipelines);
  });
});
