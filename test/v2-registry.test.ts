import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { locationKey, type LocationInfo } from "../src/v2/location";
import {
  createRegistry,
  ownsEvent,
  registerInstance,
  resetRegistry,
  tracingRegistry,
  unregisterInstance,
} from "../src/v2/registry";

const info = (directory: string, root = directory, id = "project") =>
  ({
    directory,
    project: { id, directory: root, canonical: root },
  }) as LocationInfo;

const register = (registry: ReturnType<typeof createRegistry>, location: LocationInfo) =>
  registerInstance(registry, locationKey(location), location);

describe("tracing registry", () => {
  it("is shared by every copy of the plugin module", async () => {
    resetRegistry();
    const first = tracingRegistry();

    // OpenCode re-evaluates the entrypoint in the same process; a second copy
    // of this module must find the same registry on the global object.
    const copy = await import("../src/v2/registry?copy=2");
    assert.equal(copy.tracingRegistry(), first);

    resetRegistry();
  });

  it("createRegistry returns independent registries", () => {
    const first = createRegistry();
    const second = createRegistry();

    assert.notEqual(first, second);
    assert.notEqual(first.router, second.router);
    assert.notEqual(first.entries, second.entries);
    assert.notEqual(first.instances, second.instances);
  });
});

describe("ownsEvent", () => {
  it("lets the instance whose location is exactly the event's trace it", () => {
    const registry = createRegistry();
    const root = register(registry, info("/repo"));
    const sub = register(registry, info("/repo/src", "/repo"));

    assert.equal(ownsEvent(registry, root, { directory: "/repo" }), true);
    assert.equal(ownsEvent(registry, sub, { directory: "/repo" }), false);
    assert.equal(ownsEvent(registry, sub, { directory: "/repo/src" }), true);
    assert.equal(ownsEvent(registry, root, { directory: "/repo/src" }), false);
  });

  it("lets the deepest enclosing instance win, whatever the load order", () => {
    const registry = createRegistry();
    register(registry, info("/repo/src", "/repo"));
    // The parent loads last, so a tie on coverage would hand it the events.
    const root = register(registry, info("/repo"));
    const sub = register(registry, info("/repo/src", "/repo"));
    const deep = { directory: "/repo/src/packages/app" };

    assert.ok(sub > root);
    assert.equal(ownsEvent(registry, sub, deep), true);
    assert.equal(ownsEvent(registry, root, deep), false);
  });

  it("keeps the enclosing instance for directories no instance was loaded for", () => {
    const registry = createRegistry();
    const root = register(registry, info("/repo"));
    const sub = register(registry, info("/repo/src", "/repo"));

    assert.equal(ownsEvent(registry, root, { directory: "/repo/docs" }), true);
    assert.equal(ownsEvent(registry, sub, { directory: "/repo/docs" }), false);
  });

  it("hands the events back when the nested instance unloads", () => {
    const registry = createRegistry();
    const root = register(registry, info("/repo"));
    const sub = register(registry, info("/repo/src", "/repo"));

    unregisterInstance(registry, sub);

    assert.equal(ownsEvent(registry, root, { directory: "/repo/src" }), true);
  });

  it("hands a reloaded instance the events of the one it replaces", () => {
    const registry = createRegistry();
    const before = register(registry, info("/repo"));
    const after = register(registry, info("/repo"));

    assert.equal(ownsEvent(registry, after, { directory: "/repo" }), true);
    assert.equal(ownsEvent(registry, before, { directory: "/repo" }), false);
  });

  it("lets a project nested in another one trace its own sessions", () => {
    const registry = createRegistry();
    const outer = register(registry, info("/repo"));
    const inner = register(registry, info("/repo/vendor/lib", "/repo/vendor/lib", "inner"));

    assert.equal(ownsEvent(registry, inner, { directory: "/repo/vendor/lib" }), true);
    assert.equal(ownsEvent(registry, outer, { directory: "/repo/vendor/lib" }), false);
    // A subdirectory of the nested project is closer to it than to the root.
    assert.equal(ownsEvent(registry, inner, { directory: "/repo/vendor/lib/src" }), true);
    assert.equal(ownsEvent(registry, outer, { directory: "/repo/vendor/lib/src" }), false);
    assert.equal(ownsEvent(registry, outer, { directory: "/repo" }), true);
  });

  it("ignores events of a project it does not belong to", () => {
    const registry = createRegistry();
    const self = register(registry, info("/repo"));

    assert.equal(ownsEvent(registry, self, { directory: "/other" }), false);
  });

  it("gives a payload without a location to the shallowest instance of the project", () => {
    const registry = createRegistry();
    const root = register(registry, info("/repo"));
    const sub = register(registry, info("/repo/src", "/repo"));

    // `location` is optional: without it a nested instance must not open a
    // second copy of the same spans.
    assert.equal(ownsEvent(registry, root, undefined), true);
    assert.equal(ownsEvent(registry, sub, undefined), false);
  });

  it("leaves a payload without a location to every project", () => {
    const registry = createRegistry();
    const first = register(registry, info("/a"));
    const second = register(registry, info("/b"));

    // Nothing says whose it is, so neither project loses it.
    assert.equal(ownsEvent(registry, first, undefined), true);
    assert.equal(ownsEvent(registry, second, undefined), true);
  });

  it("does not let an unregistered instance trace anything", () => {
    const registry = createRegistry();
    const self = register(registry, info("/repo"));

    unregisterInstance(registry, self);

    assert.equal(ownsEvent(registry, self, { directory: "/repo" }), false);
  });
});
