import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import { readProjectEnv, resolveLaminarConfig } from "../src/v2/config";
import type { PluginContext } from "../src/v2/types";

const roots: string[] = [];

const project = (files: Record<string, string>): string => {
  const root = mkdtempSync(path.join(tmpdir(), "lmnr-config-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(root, name), content);
  }
  return root;
};

const context = (
  root: string,
  options: Record<string, unknown> = {},
  directory = root,
) =>
  ({
    location: {
      directory,
      project: { id: "project", directory: root, canonical: root },
    },
    options,
  }) as unknown as Pick<PluginContext, "location" | "options">;

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("readProjectEnv", () => {
  it("merges env files in override order", () => {
    const root = project({
      ".env": "LMNR_PROJECT_API_KEY=base\nLMNR_BASE_URL=http://base\n",
      ".env.local": "LMNR_BASE_URL=http://local\n",
      ".env.production": "LMNR_GRPC_PORT=9999\n",
      ".env.production.local": "LMNR_BASE_URL=http://production\n",
    });

    const env = readProjectEnv(root, "production");

    assert.equal(env.LMNR_PROJECT_API_KEY, "base");
    assert.equal(env.LMNR_BASE_URL, "http://production");
    assert.equal(env.LMNR_GRPC_PORT, "9999");
  });

  it("does not write to process.env", () => {
    const root = project({ ".env": "LMNR_LOCAL_ONLY_TEST=1\n" });

    readProjectEnv(root, "production");
    resolveLaminarConfig(context(root), {});

    assert.equal(process.env.LMNR_LOCAL_ONLY_TEST, undefined);
  });
});

describe("resolveLaminarConfig", () => {
  it("prefers options, then the project env, then the service env", () => {
    const root = project({
      ".env": "LMNR_PROJECT_API_KEY=project-key\nLMNR_BASE_URL=http://project\n",
    });
    const service = { LMNR_PROJECT_API_KEY: "service-key", LMNR_BASE_URL: "http://service" };

    const resolved = resolveLaminarConfig(context(root), service);

    assert.equal(resolved.projectApiKey, "project-key");
    assert.equal(resolved.baseUrl, "http://project");
    assert.equal(resolved.port, undefined);

    const withOptions = resolveLaminarConfig(
      context(root, { projectApiKey: "option-key", baseUrl: "http://option" }),
      service,
    );
    assert.equal(withOptions.projectApiKey, "option-key");
    assert.equal(withOptions.baseUrl, "http://option");
  });

  it("reads the project env from the project root, not the session directory", () => {
    const root = project({ ".env": "LMNR_PROJECT_API_KEY=root-key\n" });
    mkdirSync(path.join(root, "packages", "app"), { recursive: true });

    const resolved = resolveLaminarConfig(
      context(root, {}, path.join(root, "packages", "app")),
      {},
    );

    assert.equal(resolved.projectApiKey, "root-key");
  });

  it("falls back to Laminar Cloud with its gRPC port", () => {
    const root = project({});

    const resolved = resolveLaminarConfig(context(root), { LMNR_PROJECT_API_KEY: "key" });

    assert.equal(resolved.baseUrl, "https://api.lmnr.ai");
    assert.equal(resolved.port, 8443);
  });

  it("reports a missing project API key", () => {
    const root = project({});

    assert.equal(resolveLaminarConfig(context(root), {}).projectApiKey, undefined);
  });
});
