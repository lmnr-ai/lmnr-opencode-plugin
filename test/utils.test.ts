import type { Attributes } from "@opentelemetry/api";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dropAiSdkWrapperContent } from "../src/utils";

// Attributes as OpenCode V1 emits them, trimmed to what matters here.
const usage = {
  "ai.model.id": "claude-haiku-4-5",
  "ai.telemetry.functionId": "session.llm",
  "ai.usage.inputTokens": 6055,
  "ai.usage.outputTokens": 54,
};
const content = {
  "ai.prompt": JSON.stringify({ system: "sys", messages: [] }),
  "ai.response.text": "hello",
  "ai.response.toolCalls": "[]",
  "ai.response.finishReason": "tool-calls",
  "ai.response.providerMetadata": "{}",
};

describe("dropAiSdkWrapperContent", () => {
  it("drops prompt and response from wrapper spans", () => {
    for (const operationId of ["ai.streamText", "ai.generateText"]) {
      const attributes: Attributes = {
        "ai.operationId": operationId,
        ...usage,
        ...content,
      };
      dropAiSdkWrapperContent(attributes);
      assert.deepEqual(attributes, { "ai.operationId": operationId, ...usage });
    }
  });

  it("keeps content on the provider call spans", () => {
    const attributes: Attributes = {
      "ai.operationId": "ai.streamText.doStream",
      ...usage,
      "ai.prompt.messages": "[]",
      ...content,
    };
    const before = { ...attributes };
    dropAiSdkWrapperContent(attributes);
    assert.deepEqual(attributes, before);
  });

  it("ignores spans that are not from the AI SDK", () => {
    const attributes: Attributes = { "lmnr.span.input": "x", ...content };
    const before = { ...attributes };
    dropAiSdkWrapperContent(attributes);
    assert.deepEqual(attributes, before);
  });
});
