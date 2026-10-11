import { Laminar, LaminarAttributes } from "@lmnr-ai/lmnr";
import { type Context, ROOT_CONTEXT, type Span, SpanStatusCode, trace } from "@opentelemetry/api";

import { otelSpanIdToUUID } from "../utils";
import {
  type RequestMessage,
  type SystemPart,
  toAiSdkMessages,
  type ToolCall,
  toolContentText,
  toOutputMessages,
} from "./messages";
import type { OpenCodeEvent, SessionContextHook, SessionPromptHook } from "./types";

// Tools that start a child session. V2 calls it `subagent`; `task` is the V1 name.
const SPAWNING_TOOL_NAMES = new Set(["subagent", "task"]);

const SPAN_INPUT = "lmnr.span.input";
const SPAN_OUTPUT = "lmnr.span.output";

interface RequestSnapshot {
  system: SystemPart[];
  messages: RequestMessage[];
  tools: string[];
}

interface StepState {
  span: Span;
  text: Map<number, string>;
  reasoning: Map<number, string>;
  toolCalls: ToolCall[];
}

interface ToolState {
  span: Span;
  name: string;
}

interface SessionState {
  id: string;
  parentID?: string;
  // Root sessions get one `opencode turn` span per execution.
  turn?: Span | undefined;
  lastText?: string | undefined;
  // Child sessions nest under the tool call that spawned them.
  spawn?: { span: Span; toolCallId: string };
  pendingPrompts: Record<string, unknown>[];
  pendingSynthetic?: string | undefined;
  pendingRequest?: RequestSnapshot | undefined;
  pendingCompaction?: RequestSnapshot | undefined;
  externalContext?: string;
  steps: Map<string, StepState>;
  tools: Map<string, ToolState>;
  toolNames: Map<string, string>;
  compaction?: Span | undefined;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T;

const errorMessage = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; data?: { message?: unknown } };
    if (typeof record.message === "string") return record.message;
    if (typeof record.data?.message === "string") return record.data.message;
  }
  return JSON.stringify(error);
};

const joinOrdinals = (parts: Map<number, string>) =>
  [...parts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, text]) => text)
    .join("");

interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

// V2 token buckets are disjoint. OTel's gen_ai.usage.input_tokens includes
// cached tokens and output_tokens includes reasoning, so fold them in here.
const usageAttributes = (tokens: TokenUsage | undefined, cost: number | undefined) => {
  const attributes: Record<string, number> = {};
  if (tokens) {
    const input = tokens.input + tokens.cache.read + tokens.cache.write;
    const output = tokens.output + tokens.reasoning;
    attributes[LaminarAttributes.INPUT_TOKEN_COUNT] = input;
    attributes[LaminarAttributes.OUTPUT_TOKEN_COUNT] = output;
    attributes[LaminarAttributes.TOTAL_TOKEN_COUNT] = input + output;
    attributes["gen_ai.usage.reasoning_tokens"] = tokens.reasoning;
    attributes["gen_ai.usage.cache_read_input_tokens"] = tokens.cache.read;
    attributes["gen_ai.usage.cache_creation_input_tokens"] = tokens.cache.write;
  }
  if (typeof cost === "number") attributes[LaminarAttributes.TOTAL_COST] = cost;
  return attributes;
};

export class SessionTracer {
  private sessions = new Map<string, SessionState>();

  constructor(private readonly onTurnEnd: () => void = () => {}) {}

  private session(id: string): SessionState {
    let state = this.sessions.get(id);
    if (!state) {
      state = {
        id,
        pendingPrompts: [],
        steps: new Map(),
        tools: new Map(),
        toolNames: new Map(),
      };
      this.sessions.set(id, state);
    }
    return state;
  }

  private rootSessionId(state: SessionState): string {
    const seen = new Set<string>();
    let current = state;
    while (current.parentID && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = this.sessions.get(current.parentID);
      if (!parent) return current.parentID;
      current = parent;
    }
    return current.id;
  }

  private parentContext(state: SessionState, seen = new Set<string>()): Context | undefined {
    if (state.turn) return trace.setSpan(ROOT_CONTEXT, state.turn);
    if (state.spawn) return trace.setSpan(ROOT_CONTEXT, state.spawn.span);
    if (state.parentID && !seen.has(state.id)) {
      seen.add(state.id);
      const parent = this.sessions.get(state.parentID);
      if (parent) return this.parentContext(parent, seen);
    }
    return undefined;
  }

  // Spans inside a subagent carry the spawning tool call, like the V1 plugin.
  private spawnAttributes(state: SessionState, seen = new Set<string>()): Record<string, string> {
    if (state.spawn) {
      return {
        "lmnr.spawning_subagent.span_id": otelSpanIdToUUID(state.spawn.span.spanContext().spanId),
        "lmnr.spawning_subagent.tool_use_id": state.spawn.toolCallId,
      };
    }
    if (state.parentID && !seen.has(state.id)) {
      seen.add(state.id);
      const parent = this.sessions.get(state.parentID);
      if (parent) return this.spawnAttributes(parent, seen);
    }
    return {};
  }

  private isChild(state: SessionState) {
    return state.parentID !== undefined || state.spawn !== undefined;
  }

  private startSpan(
    state: SessionState,
    name: string,
    options: {
      spanType?: "DEFAULT" | "LLM" | "TOOL";
      input?: unknown;
      startTime?: number;
      attributes?: Record<string, string | number | boolean>;
    },
  ): Span {
    // Root sessions without an open turn (e.g. the plugin loaded mid-execution)
    // still get a turn, so spans never land as unrelated root traces.
    if (!this.isChild(state) && !state.turn) {
      this.startTurn(state, options.startTime);
    }
    const span = Laminar.startSpan({
      name,
      ...(options.spanType ? { spanType: options.spanType } : {}),
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.startTime !== undefined ? { startTime: options.startTime } : {}),
      sessionId: this.rootSessionId(state),
      context: this.parentContext(state) ?? ROOT_CONTEXT,
    });
    span.setAttributes({ ...this.spawnAttributes(state), ...options.attributes });
    return span;
  }

  private startTurn(state: SessionState, startTime?: number) {
    const prompts = state.pendingPrompts;
    state.pendingPrompts = [];
    const input =
      prompts.length === 1
        ? prompts[0]
        : prompts.length > 1
          ? prompts
          : { sessionID: state.id, synthetic: state.pendingSynthetic };
    state.pendingSynthetic = undefined;
    state.lastText = undefined;
    state.turn = Laminar.startSpan({
      name: "opencode turn",
      input,
      sessionId: state.id,
      ...(startTime !== undefined ? { startTime } : {}),
      ...(state.externalContext
        ? { parentSpanContext: state.externalContext }
        : { context: ROOT_CONTEXT }),
    });
  }

  private endTurn(state: SessionState, endTime: number, error?: string) {
    this.endOpenSpans(state, endTime, error ?? "turn ended before span completed");
    if (!state.turn) return;
    if (state.lastText !== undefined) {
      state.turn.setAttribute(SPAN_OUTPUT, state.lastText);
    }
    if (error) state.turn.setStatus({ code: SpanStatusCode.ERROR, message: error });
    state.turn.end(endTime);
    state.turn = undefined;
    this.onTurnEnd();
  }

  private endOpenSpans(state: SessionState, endTime: number, reason: string) {
    for (const step of state.steps.values()) {
      step.span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
      step.span.end(endTime);
    }
    state.steps.clear();
    for (const tool of state.tools.values()) {
      tool.span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
      tool.span.end(endTime);
    }
    state.tools.clear();
    if (state.compaction) {
      state.compaction.setStatus({ code: SpanStatusCode.ERROR, message: reason });
      state.compaction.end(endTime);
      state.compaction = undefined;
    }
  }

  // ---- hooks ----

  onPrompt(event: SessionPromptHook) {
    const state = this.session(event.sessionID);
    const external = event.metadata?.lmnrSpanContext;
    if (typeof external === "string" && external.length > 0) {
      state.externalContext = external;
    }
    const prompt = {
      sessionID: event.sessionID,
      messageID: event.messageID,
      ...clone(event.prompt),
      ...(event.metadata ? { metadata: clone(event.metadata) } : {}),
    };
    if (state.turn) {
      // Steering prompt delivered into a running execution.
      state.turn.addEvent("prompt", { [SPAN_INPUT]: JSON.stringify(prompt) });
      return;
    }
    state.pendingPrompts.push(prompt);
  }

  onContext(event: SessionContextHook, kind: "primary" | "compaction") {
    const state = this.session(event.sessionID);
    const snapshot: RequestSnapshot = {
      system: clone(event.system),
      messages: clone(event.messages),
      tools: Object.keys(event.tools ?? {}),
    };
    if (kind === "primary") state.pendingRequest = snapshot;
    else state.pendingCompaction = snapshot;
  }

  // ---- events ----

  handle(event: OpenCodeEvent) {
    switch (event.type) {
      case "session.created": {
        const state = this.session(event.data.sessionID);
        if (event.data.parentID) state.parentID = event.data.parentID;
        break;
      }
      case "session.synthetic": {
        this.session(event.data.sessionID).pendingSynthetic = event.data.text;
        break;
      }
      case "session.execution.started": {
        const state = this.session(event.data.sessionID);
        if (!this.isChild(state) && !state.turn) this.startTurn(state, event.created);
        break;
      }
      case "session.execution.succeeded":
        this.endTurn(this.session(event.data.sessionID), event.created);
        break;
      case "session.execution.failed":
        this.endTurn(
          this.session(event.data.sessionID),
          event.created,
          errorMessage(event.data.error),
        );
        break;
      case "session.execution.interrupted":
        this.endTurn(
          this.session(event.data.sessionID),
          event.created,
          `interrupted: ${event.data.reason}`,
        );
        break;
      case "session.idle": {
        const state = this.sessions.get(event.data.sessionID);
        if (state?.turn) this.endTurn(state, event.created);
        break;
      }
      case "session.step.started": {
        const state = this.session(event.data.sessionID);
        const previous = state.steps.get(event.data.assistantMessageID);
        if (previous) {
          previous.span.setStatus({ code: SpanStatusCode.ERROR, message: "step restarted" });
          previous.span.end(event.created);
        }
        const request = state.pendingRequest;
        state.pendingRequest = undefined;
        const { model } = event.data;
        const span = this.startSpan(state, `ai.llm ${model.providerID}:${model.id}`, {
          spanType: "LLM",
          startTime: event.data.started,
          ...(request ? { input: toAiSdkMessages(request.system, request.messages) } : {}),
          attributes: {
            [LaminarAttributes.PROVIDER]: model.providerID,
            [LaminarAttributes.REQUEST_MODEL]: model.id,
            [LaminarAttributes.RESPONSE_MODEL]: model.id,
            "opencode.agent": event.data.agent,
            ...(model.variant ? { "opencode.model.variant": model.variant } : {}),
            ...(request?.tools.length ? { "opencode.tools": JSON.stringify(request.tools) } : {}),
          },
        });
        state.steps.set(event.data.assistantMessageID, {
          span,
          text: new Map(),
          reasoning: new Map(),
          toolCalls: [],
        });
        break;
      }
      case "session.text.ended": {
        const step = this.sessions
          .get(event.data.sessionID)
          ?.steps.get(event.data.assistantMessageID);
        step?.text.set(event.data.ordinal, event.data.text);
        break;
      }
      case "session.reasoning.ended": {
        const step = this.sessions
          .get(event.data.sessionID)
          ?.steps.get(event.data.assistantMessageID);
        step?.reasoning.set(event.data.ordinal, event.data.text);
        break;
      }
      case "session.step.ended":
      case "session.step.failed": {
        const state = this.sessions.get(event.data.sessionID);
        const step = state?.steps.get(event.data.assistantMessageID);
        if (!state || !step) break;
        state.steps.delete(event.data.assistantMessageID);
        const text = joinOrdinals(step.text);
        const reasoning = joinOrdinals(step.reasoning);
        if (text.length > 0) {
          step.span.setAttribute(SPAN_OUTPUT, text);
          state.lastText = text;
        } else if (step.toolCalls.length > 0) {
          step.span.setAttribute(SPAN_OUTPUT, JSON.stringify(step.toolCalls));
        }
        const output = toOutputMessages(text, reasoning, step.toolCalls);
        if (output.length > 0) {
          step.span.setAttribute("gen_ai.output.messages", JSON.stringify(output));
        }
        step.span.setAttributes(usageAttributes(event.data.tokens, event.data.cost));
        if (event.data.finish) {
          step.span.setAttribute("gen_ai.response.finish_reason", event.data.finish);
        }
        if (event.type === "session.step.failed") {
          step.span.setStatus({
            code: SpanStatusCode.ERROR,
            message: errorMessage(event.data.error),
          });
        }
        step.span.end(event.created);
        break;
      }
      case "session.tool.input.started": {
        this.session(event.data.sessionID).toolNames.set(event.data.id, event.data.name);
        break;
      }
      case "session.tool.called": {
        const state = this.session(event.data.sessionID);
        const name = state.toolNames.get(event.data.id) ?? "tool";
        state.steps
          .get(event.data.assistantMessageID)
          ?.toolCalls.push({ id: event.data.id, name, input: event.data.input });
        const span = this.startSpan(state, name, {
          spanType: "TOOL",
          input: event.data.input,
          startTime: event.created,
          attributes: {
            "ai.toolCall.id": event.data.id,
            "ai.toolCall.name": name,
            "opencode.tool.executed": event.data.executed,
          },
        });
        state.tools.set(event.data.id, { span, name });
        break;
      }
      case "session.tool.progress": {
        const state = this.sessions.get(event.data.sessionID);
        const tool = state?.tools.get(event.data.id);
        const childID = event.data.metadata?.sessionID;
        if (!tool || !SPAWNING_TOOL_NAMES.has(tool.name) || typeof childID !== "string") break;
        const child = this.session(childID);
        child.parentID ??= event.data.sessionID;
        child.spawn = { span: tool.span, toolCallId: event.data.id };
        break;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const state = this.sessions.get(event.data.sessionID);
        const tool = state?.tools.get(event.data.id);
        if (!state || !tool) break;
        state.tools.delete(event.data.id);
        state.toolNames.delete(event.data.id);
        if (event.data.content) {
          tool.span.setAttribute(SPAN_OUTPUT, JSON.stringify(toolContentText(event.data.content)));
        }
        if (event.type === "session.tool.failed") {
          tool.span.setStatus({
            code: SpanStatusCode.ERROR,
            message: errorMessage(event.data.error),
          });
        }
        tool.span.end(event.created);
        break;
      }
      case "session.compaction.started": {
        const state = this.session(event.data.sessionID);
        const request = state.pendingCompaction;
        state.pendingCompaction = undefined;
        state.compaction = this.startSpan(state, "opencode compaction", {
          spanType: "LLM",
          startTime: event.created,
          ...(request ? { input: toAiSdkMessages(request.system, request.messages) } : {}),
          attributes: { "opencode.compaction.reason": event.data.reason },
        });
        break;
      }
      case "session.compaction.ended":
      case "session.compaction.failed": {
        const state = this.sessions.get(event.data.sessionID);
        const span = state?.compaction;
        if (!state || !span) break;
        state.compaction = undefined;
        span.setAttributes(usageAttributes(event.data.tokens, event.data.cost));
        if (event.type === "session.compaction.ended") {
          span.setAttribute(SPAN_OUTPUT, event.data.text);
          const { model } = event.data;
          if (model) {
            span.setAttribute(LaminarAttributes.PROVIDER, model.providerID);
            span.setAttribute(LaminarAttributes.REQUEST_MODEL, model.id);
            span.setAttribute(LaminarAttributes.RESPONSE_MODEL, model.id);
          }
        } else {
          span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(event.data.error) });
        }
        span.end(event.created);
        break;
      }
      case "session.deleted": {
        const state = this.sessions.get(event.data.sessionID);
        if (!state) break;
        this.endTurn(state, event.created, state.turn ? "session deleted" : undefined);
        this.sessions.delete(event.data.sessionID);
        break;
      }
    }
  }

  // Ends everything still open, e.g. when the plugin unloads.
  shutdown(reason = "plugin unloaded") {
    const now = Date.now();
    for (const state of this.sessions.values()) {
      this.endOpenSpans(state, now, reason);
      if (state.turn) {
        state.turn.setStatus({ code: SpanStatusCode.ERROR, message: reason });
        state.turn.end(now);
        state.turn = undefined;
      }
    }
    this.sessions.clear();
  }
}
