import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { locationKey, ownsLocation, type LocationInfo } from "../src/v2/location";

const info = (directory: string, workspaceID?: string, id = "project") =>
  ({
    directory,
    ...(workspaceID !== undefined ? { workspaceID } : {}),
    project: { id, directory, canonical: directory },
  }) as LocationInfo;

describe("locationKey", () => {
  it("is shared by sessions of the same project and workspace", () => {
    assert.equal(locationKey(info("/repo")), locationKey(info("/repo")));
  });

  it("separates projects and worktrees", () => {
    assert.notEqual(locationKey(info("/a")), locationKey(info("/b")));
    assert.notEqual(
      locationKey(info("/repo", "ws_1")),
      locationKey(info("/repo", "ws_2")),
    );
    assert.notEqual(locationKey(info("/repo", "ws_1")), locationKey(info("/repo")));
  });
});

describe("ownsLocation", () => {
  it("accepts payloads without a location", () => {
    assert.equal(ownsLocation(undefined, info("/repo")), true);
  });

  it("accepts the project directory and its subdirectories", () => {
    assert.equal(ownsLocation({ directory: "/repo" }, info("/repo")), true);
    assert.equal(ownsLocation({ directory: "/repo/src" }, info("/repo")), true);
  });

  it("rejects another project", () => {
    assert.equal(ownsLocation({ directory: "/other" }, info("/repo")), false);
  });

  it("compares worktrees by workspace", () => {
    assert.equal(
      ownsLocation({ directory: "/worktrees/a", workspaceID: "ws_1" }, info("/repo", "ws_1")),
      true,
    );
    assert.equal(
      ownsLocation({ directory: "/worktrees/b", workspaceID: "ws_2" }, info("/repo", "ws_1")),
      false,
    );
    assert.equal(
      ownsLocation({ directory: "/repo" }, info("/repo", "ws_1")),
      false,
    );
  });
});
