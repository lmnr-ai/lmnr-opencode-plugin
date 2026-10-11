// Converts OpenCode V2 model requests (`@opencode/ai` messages) into the AI SDK
// message shape that Laminar already renders for its own AI SDK integration.
// The input types are kept structural and loose on purpose: the V2 schema is
// still moving, and an unknown part should degrade to a readable placeholder
// rather than break tracing.

type Part = { type: string; [key: string]: unknown };

export interface RequestMessage {
  role: string;
  content: readonly Part[];
}

export interface SystemPart {
  type: string;
  text: string;
}

export type AiSdkPart = Record<string, unknown> & { type: string };

export interface AiSdkMessage {
  role: string;
  content: string | AiSdkPart[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

const mediaPart = (part: Part): AiSdkPart => {
  const media = (part.media ?? {}) as Record<string, unknown>;
  return {
    type: "file",
    mediaType: media.mime ?? media.mediaType ?? "application/octet-stream",
    ...(typeof part.filename === "string" ? { filename: part.filename } : {}),
    // Inline media can be megabytes of base64; keep a placeholder instead.
    data: "[omitted]",
  };
};

const toolResultOutput = (result: unknown): AiSdkPart => {
  const value = (result ?? {}) as { type?: string; value?: unknown };
  switch (value.type) {
    case "text":
      return { type: "text", value: String(value.value) };
    case "error":
      return {
        type: "error-text",
        value: typeof value.value === "string" ? value.value : JSON.stringify(value.value),
      };
    case "content":
      return { type: "content", value: value.value };
    default:
      return { type: "json", value: value.value };
  }
};

const convertPart = (part: Part): AiSdkPart | undefined => {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "reasoning":
      return { type: "reasoning", text: part.text };
    case "media":
      return mediaPart(part);
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: part.id,
        toolName: part.name,
        input: part.input,
      };
    case "tool-result":
      return {
        type: "tool-result",
        toolCallId: part.id,
        toolName: part.name,
        output: toolResultOutput(part.result),
      };
    case "compaction":
      return typeof part.text === "string"
        ? { type: "text", text: `[compaction summary]\n${part.text}` }
        : undefined;
    // Effort markers and other bookkeeping parts carry no conversation content.
    default:
      return undefined;
  }
};

export const toAiSdkMessages = (
  system: readonly SystemPart[],
  messages: readonly RequestMessage[],
): AiSdkMessage[] => {
  const result: AiSdkMessage[] = [];
  const systemText = system.map((part) => part.text).join("\n\n");
  if (systemText.length > 0) {
    result.push({ role: "system", content: systemText });
  }
  for (const message of messages) {
    const content = message.content
      .map(convertPart)
      .filter((part): part is AiSdkPart => part !== undefined);
    if (content.length === 0) continue;
    if (message.role === "system") {
      result.push({
        role: "system",
        content: content.map((part) => (typeof part.text === "string" ? part.text : "")).join(""),
      });
      continue;
    }
    result.push({ role: message.role, content });
  }
  return result;
};

// Mirrors the `gen_ai.output.messages` shape the Laminar SDK writes for AI SDK
// LLM spans, so V2 spans render the same way as V1 ones.
export const toOutputMessages = (
  text: string,
  reasoning: string,
  toolCalls: readonly ToolCall[],
) => {
  const parts: Record<string, unknown>[] = [];
  if (reasoning.length > 0) parts.push({ type: "thinking", content: reasoning });
  if (text.length > 0) parts.push({ type: "text", content: text });
  for (const call of toolCalls) {
    parts.push({ type: "tool_call", id: call.id, name: call.name, arguments: call.input });
  }
  return parts.length > 0 ? [{ role: "assistant", parts }] : [];
};

export const toolContentText = (content: readonly Part[]): string | Part[] =>
  content.every((part) => part.type === "text")
    ? content.map((part) => String(part.text)).join("")
    : [...content];
