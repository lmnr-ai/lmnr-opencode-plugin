// LLM spans carry OpenCode V2's own message shape (`@opencode/ai`) as is.
import type { SessionContextHook } from "./types";

export type Message = SessionContextHook["messages"][number];
type Part = Message["content"][number];
export type ToolCall = Extract<Part, { type: "tool-call" }>;

// The system prompt rides as V2's own `system` message.
export const requestMessages = (
  system: SessionContextHook["system"],
  messages: readonly Message[],
): Message[] => [
  ...(system.length > 0 ? [{ role: "system" as const, content: system }] : []),
  ...messages,
];

export const responseMessages = (
  text: string,
  reasoning: string,
  toolCalls: readonly ToolCall[],
): Message[] => {
  const content: Part[] = [
    ...(reasoning.length > 0 ? [{ type: "reasoning" as const, text: reasoning }] : []),
    ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
    ...toolCalls,
  ];
  return content.length > 0 ? [{ role: "assistant", content }] : [];
};
