import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LocationInfo } from "../src/v2/location";
import {
  createRegistry,
  ownsEvent,
  ownsSession,
  registerInstance,
  releaseSession,
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
  registerInstance(registry, location);

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

  it("does not let an unregistered instance trace anything", () => {
    const registry = createRegistry();
    const self = register(registry, info("/repo"));

    unregisterInstance(registry, self);

    assert.equal(ownsEvent(registry, self, { directory: "/repo" }), false);
  });
});

describe("ownsSession", () => {
  it("elects the closest instance for a located session and keeps it", () => {
    const registry = createRegistry();
    const root = register(registry, info("/repo"));
    const sub = register(registry, info("/repo/src", "/repo"));
    const located = { directory: "/repo/src" };

    assert.equal(ownsSession(registry, root, "ses_1", located, false), false);
    assert.equal(ownsSession(registry, sub, "ses_1", located, false), true);
    // The session is claimed: an event that arrives without a location still
    // belongs to the same tracer instead of being traced again by the root.
    assert.equal(ownsSession(registry, sub, "ses_1", undefined, false), true);
    assert.equal(ownsSession(registry, root, "ses_1", undefined, false), false);
  });

  it("gives a session without a location to the instance that holds it", () => {
    const registry = createRegistry();
    const root = register(registry, info("/repo"));
    const sub = register(registry, info("/repo/src", "/repo"));

    // Only the instance that received the hooks knows the session.
    assert.equal(ownsSession(registry, root, "ses_2", undefined, false), false);
    assert.equal(ownsSession(registry, sub, "ses_2", undefined, true), true);
    assert.equal(ownsSession(registry, root, "ses_2", undefined, true), false);
  });

  it("re-elects once the owner unloads", () => {
    const registry = createRegistry();
    const root = register(registry, info("/repo"));
    const sub = register(registry, info("/repo/src", "/repo"));
    const located = { directory: "/repo/src" };

    assert.equal(ownsSession(registry, sub, "ses_3", located, false), true);
    unregisterInstance(registry, sub);

    assert.equal(ownsSession(registry, sub, "ses_3", undefined, true), false);
    assert.equal(ownsSession(registry, root, "ses_3", located, false), true);
  });

  it("forgets a session that ended", () => {
    const registry = createRegistry();
    const root = register(registry, info("/repo"));

    assert.equal(ownsSession(registry, root, "ses_4", { directory: "/repo" }, false), true);
    releaseSession(registry, "ses_4");
    assert.equal(registry.sessions.has("ses_4"), false);

    const again = register(registry, info("/repo/other", "/repo"));
    assert.equal(ownsSession(registry, again, "ses_4", { directory: "/repo/other" }, false), true);
  });
});
