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

  it("ranks a payload without a location by the instance's own depth", () => {
    assert.equal(coverage(undefined, info("/repo")), 0.5);
    assert.equal(coverage(undefined, nested("/repo/src", "/repo")), 1 / 3);
    assert.ok(
      (coverage(undefined, info("/repo")) as number) >
        (coverage(undefined, nested("/repo/src", "/repo")) as number),
    );
  });

  it("ranks an exact location above an enclosing one", () => {
    const root = nested("/repo", "/repo");
    const sub = nested("/repo/src", "/repo");

    assert.equal(rank(sub, "/repo/src"), 3);
    assert.equal(rank(root, "/repo/src"), 1.5);
    assert.ok(rank(sub, "/repo/src") > rank(root, "/repo/src"));
  });

  it("ranks a nested location above the root that also encloses the session", () => {
    const root = nested("/repo", "/repo");
    const sub = nested("/repo/src", "/repo");
    const deep = "/repo/src/deep/nested";

    assert.ok(rank(sub, deep) > rank(root, deep));
    assert.ok(rank(root, deep) > 1);
  });

  it("accepts a directory of the same project, at a lower rank", () => {
    assert.equal(coverage({ directory: "/repo/docs" }, nested("/repo/src", "/repo")), 1);
    assert.equal(coverage({ directory: "/repo" }, nested("/repo/src", "/repo")), 1);
  });

  it("accepts the project directory and its subdirectories", () => {
    assert.equal(rank(info("/repo"), "/repo"), 3);
    assert.equal(rank(info("/repo"), "/repo/src"), 1.5);
  });

  it("rejects another project", () => {
    assert.equal(coverage({ directory: "/other" }, info("/repo")), undefined);
    assert.equal(coverage({ directory: "/repo-old" }, info("/repo")), undefined);
  });

  it("compares worktrees by workspace", () => {
    assert.equal(coverage({ directory: "/worktrees/a", workspaceID: "ws_1" }, info("/repo", "ws_1")), 1);
    assert.equal(coverage({ directory: "/worktrees/b", workspaceID: "ws_2" }, info("/repo", "ws_1")), undefined);
  });
});
