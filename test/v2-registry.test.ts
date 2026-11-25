import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { locationKey, type LocationInfo } from "../src/v2/location";
import { resetRegistry, tracingRegistry } from "../src/v2/registry";

beforeEach(resetRegistry);

const info = (directory: string, root = directory, id = "project") =>
  ({
    directory,
    project: { id, directory: root, canonical: root },
  }) as LocationInfo;

const register = (registry: ReturnType<typeof tracingRegistry>, location: LocationInfo) =>
  registry.addInstance(locationKey(location), location);

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
});

describe("ownerKey", () => {
  it("names the pipeline of the project an event belongs to", () => {
    const registry = tracingRegistry();
    const root = info("/repo");
    register(registry, root);
    // Another project, nested inside the first one's directory.
    const inner = info("/repo/vendor/lib", "/repo/vendor/lib", "inner");
    register(registry, inner);

    assert.equal(registry.ownerKey({ directory: "/repo" }), locationKey(root));
    assert.equal(registry.ownerKey({ directory: "/repo/src" }), locationKey(root));
    assert.equal(registry.ownerKey({ directory: "/repo/vendor/lib/src" }), locationKey(inner));
  });

  it("gives every location of one project the same pipeline", () => {
    const registry = tracingRegistry();
    const root = info("/repo");
    const sub = info("/repo/src", "/repo");
    register(registry, root);
    register(registry, sub);

    assert.equal(locationKey(root), locationKey(sub));
    assert.equal(registry.ownerKey({ directory: "/repo/src" }), locationKey(sub));
  });

  it("hands a nested project's events back when its instance unloads", () => {
    const registry = tracingRegistry();
    const root = info("/repo");
    register(registry, root);
    const inner = info("/repo/vendor/lib", "/repo/vendor/lib", "inner");
    const removeInner = register(registry, inner);

    assert.equal(registry.ownerKey({ directory: "/repo/vendor/lib" }), locationKey(inner));

    removeInner();

    assert.equal(registry.ownerKey({ directory: "/repo/vendor/lib" }), locationKey(root));
  });

  it("has no pipeline for a location no live instance covers", () => {
    const registry = tracingRegistry();
    register(registry, info("/repo"));

    assert.equal(registry.ownerKey({ directory: "/other" }), undefined);
  });
});
