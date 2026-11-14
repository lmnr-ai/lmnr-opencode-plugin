import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRegistry, resetRegistry, tracingRegistry } from "../src/v2/registry";

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
  });
});
