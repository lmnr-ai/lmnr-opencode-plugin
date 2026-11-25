import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { coverage, locationKey, type LocationInfo } from "../src/v2/location";

const info = (directory: string, workspaceID?: string, id = "project") =>
  ({
    directory,
    ...(workspaceID !== undefined ? { workspaceID } : {}),
    project: { id, directory, canonical: directory },
  }) as LocationInfo;

const nested = (directory: string, root: string, id = "project") =>
  ({
    directory,
    project: { id, directory: root, canonical: root },
  }) as LocationInfo;

describe("locationKey", () => {
  it("is shared by sessions of the same project and workspace", () => {
    assert.equal(locationKey(info("/repo")), locationKey(info("/repo")));
  });

  it("is shared by every location nested in one project", () => {
    assert.equal(locationKey(nested("/repo", "/repo")), locationKey(nested("/repo/src", "/repo")));
    assert.equal(locationKey(nested("/repo/", "/repo")), locationKey(nested("/repo", "/repo")));
  });

  it("separates projects and worktrees", () => {
    assert.notEqual(locationKey(info("/a")), locationKey(info("/b")));
    assert.notEqual(locationKey(nested("/a", "/a")), locationKey(nested("/b", "/b")));
    assert.notEqual(locationKey(info("/repo", "ws_1")), locationKey(info("/repo", "ws_2")));
    assert.notEqual(locationKey(info("/repo", "ws_1")), locationKey(info("/repo")));
  });
});

describe("coverage", () => {
  const rank = (self: LocationInfo, directory: string): number =>
    coverage({ directory }, self) as number;

  it("ranks a nested project above the project that encloses it", () => {
    const outer = nested("/repo", "/repo");
    const inner = nested("/repo/vendor/lib", "/repo/vendor/lib", "inner");
    const deep = "/repo/vendor/lib/src";

    assert.ok(rank(inner, deep) > rank(outer, deep));
  });

  it("covers the project root and its subdirectories from any location of the project", () => {
    const root = nested("/repo", "/repo");
    const sub = nested("/repo/src", "/repo");

    assert.equal(rank(root, "/repo/src"), rank(root, "/repo"));
    assert.equal(rank(sub, "/repo/src"), rank(root, "/repo/src"));
    assert.equal(coverage({ directory: "/repo/docs" }, sub), rank(root, "/repo"));
  });

  it("rejects another project", () => {
    assert.equal(coverage({ directory: "/other" }, info("/repo")), undefined);
    assert.equal(coverage({ directory: "/repo-old" }, info("/repo")), undefined);
  });

  it("compares worktrees by workspace", () => {
    assert.equal(
      coverage({ directory: "/worktrees/a", workspaceID: "ws_1" }, info("/repo", "ws_1")),
      0,
    );
    assert.equal(
      coverage({ directory: "/worktrees/b", workspaceID: "ws_2" }, info("/repo", "ws_1")),
      undefined,
    );
  });
});
