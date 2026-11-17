import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { locationKey, type LocationInfo } from "../src/v2/location";
import {
  createRegistry,
  ownerKey,
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

describe("ownerKey", () => {
  it("names the pipeline of the project an event belongs to", () => {
    const registry = createRegistry();
    const root = info("/repo");
    registerInstance(registry, locationKey(root), root);
    // Another project, nested inside the first one's directory.
    const inner = info("/repo/vendor/lib", "/repo/vendor/lib", "inner");
    registerInstance(registry, locationKey(inner), inner);

    assert.equal(ownerKey(registry, { directory: "/repo" }), locationKey(root));
    assert.equal(ownerKey(registry, { directory: "/repo/src" }), locationKey(root));
    assert.equal(ownerKey(registry, { directory: "/repo/vendor/lib/src" }), locationKey(inner));
  });

  it("gives every location of one project the same pipeline", () => {
    const registry = createRegistry();
    const root = info("/repo");
    const sub = info("/repo/src", "/repo");
    registerInstance(registry, locationKey(root), root);
    registerInstance(registry, locationKey(sub), sub);

    assert.equal(locationKey(root), locationKey(sub));
    assert.equal(ownerKey(registry, { directory: "/repo/src" }), locationKey(sub));
  });

  it("hands a nested project's events back when its instance unloads", () => {
    const registry = createRegistry();
    const root = info("/repo");
    registerInstance(registry, locationKey(root), root);
    const inner = info("/repo/vendor/lib", "/repo/vendor/lib", "inner");
    const innerID = registerInstance(registry, locationKey(inner), inner);

    assert.equal(ownerKey(registry, { directory: "/repo/vendor/lib" }), locationKey(inner));

    unregisterInstance(registry, innerID);

    assert.equal(ownerKey(registry, { directory: "/repo/vendor/lib" }), locationKey(root));
  });

  it("has no pipeline for a location no live instance covers", () => {
    const registry = createRegistry();
    registerInstance(registry, locationKey(info("/repo")), info("/repo"));

    assert.equal(ownerKey(registry, { directory: "/other" }), undefined);
  });
});
