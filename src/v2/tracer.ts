import { Laminar, LaminarAttributes } from "@lmnr-ai/lmnr";
import { type Context, ROOT_CONTEXT, type Span, SpanStatusCode, trace } from "@opentelemetry/api";

import { otelSpanIdToUUID } from "../utils";
import { requestMessages, responseMessages, type ToolCall } from "./messages";
import type { OpenCodeEvent, SessionContextHook, SessionPromptHook } from "./types";

// Tools that start a child session. V2 calls it `subagent`; `task` is the V1 name.
const SPAWNING_TOOL_NAMES = new Set(["subagent", "task"]);

const SPAN_INPUT = "lmnr.span.input";
const SPAN_OUTPUT = "lmnr.span.output";

interface StepState {
  span: Span;
  text: Map<number, string>;
  reasoning: Map<number, string>;
  toolCalls: ToolCall[];
  // When the response finished streaming; the step itself ends only after
  // its tool calls settle, which would stretch the LLM span over them.
  streamed?: number;
}

interface ToolState {
  span: Span;
  name: string;
}

interface PromptRecord {
  messageID: string;
  input: Record<string, unknown>;
  externalContext?: string | undefined;
}

interface SessionState {
  id: string;
  parentID?: string;
  // Root sessions get one `opencode turn` span per execution.
  turn?: Span | undefined;
  lastText?: string | undefined;
  // Child sessions nest under the tool call that spawned them.
  spawn?: { span: Span; toolCallId: string };
  // Prompts seen by the `prompt` hook, keyed by message ID. A draft becomes
  // pending only once OpenCode admits it (`session.inbox.enqueued`), so
  // prompts that fail admission never show up as turn input.
  promptDrafts: Map<string, PromptRecord>;
  pendingPrompts: PromptRecord[];
  pendingSynthetic?: string | undefined;
  pendingRequest?: string | undefined;
  pendingTools?: string | undefined;
  pendingCompaction?: string | undefined;
  externalContext?: string;
  steps: Map<string, StepState>;
  tools: Map<string, ToolState>;
  toolNames: Map<string, string>;
  compaction?: Span | undefined;
}

// Laminar treats a span as failed only when it has an exception event.
const fail = (span: Span, message: string) => {
  span.setStatus({ code: SpanStatusCode.ERROR, message });
  span.recordException({ name: "Error", message });
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
    attributes["gen_ai.usage.cache_read.input_tokens"] = tokens.cache.read;
    attributes["gen_ai.usage.cache_creation.input_tokens"] = tokens.cache.write;
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
        promptDrafts: new Map(),
        pendingPrompts: [],
        steps: new Map(),
        tools: new Map(),
        toolNames: new Map(),
      };
      this.sessions.set(id, state);
    }
    return state;
  }

  // The session followed by its known ancestors.
  private *lineage(state: SessionState) {
    for (
      let current: SessionState | undefined = state;
      current;
      current = current.parentID ? this.sessions.get(current.parentID) : undefined
    ) {
      yield current;
    }
  }

  private rootSessionId(state: SessionState): string {
    let root = state;
    for (const current of this.lineage(state)) root = current;
    return root.parentID ?? root.id;
  }

  // Spans attach to the nearest open turn or spawning tool call up the chain.
  private parentContext(state: SessionState): Context {
    for (const current of this.lineage(state)) {
      const span = current.turn ?? current.spawn?.span;
      if (span) return trace.setSpan(ROOT_CONTEXT, span);
    }
    return ROOT_CONTEXT;
  }

  // Spans inside a subagent carry the spawning tool call, like the V1 plugin.
  private spawnAttributes(state: SessionState): Record<string, string> {
    for (const { spawn } of this.lineage(state)) {
      if (!spawn) continue;
      return {
        "lmnr.spawning_subagent.span_id": otelSpanIdToUUID(spawn.span.spanContext().spanId),
        "lmnr.spawning_subagent.tool_use_id": spawn.toolCallId,
      };
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
      context: this.parentContext(state),
    });
    span.setAttributes({ ...this.spawnAttributes(state), ...options.attributes });
    return span;
  }

  private startTurn(state: SessionState, startTime?: number) {
    const prompts = state.pendingPrompts;
    state.pendingPrompts = [];
    const external = prompts.findLast((prompt) => prompt.externalContext)?.externalContext;
    if (external) state.externalContext = external;
    const input =
      prompts.length === 1
        ? prompts[0]!.input
        : prompts.length > 1
          ? prompts.map((prompt) => prompt.input)
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
    // Pending prompts, drafts and request snapshots are left alone: hooks reach
    // the plugin directly while events are streamed, so state for the next
    // turn can arrive before this turn's end event.
    this.endOpenSpans(state, endTime, error ?? "turn ended before span completed");
    if (!state.turn) return;
    if (state.lastText !== undefined) {
      state.turn.setAttribute(SPAN_OUTPUT, state.lastText);
    }
    if (error) fail(state.turn, error);
    state.turn.end(endTime);
    state.turn = undefined;
    this.onTurnEnd();
  }

  private endOpenSpans(state: SessionState, endTime: number, reason: string) {
    for (const step of state.steps.values()) {
      fail(step.span, reason);
      step.span.end(endTime);
    }
    state.steps.clear();
    for (const tool of state.tools.values()) {
      fail(tool.span, reason);
      tool.span.end(endTime);
    }
    state.tools.clear();
    if (state.compaction) {
      fail(state.compaction, reason);
      state.compaction.end(endTime);
      state.compaction = undefined;
    }
  }

  // ---- hooks ----

  onPrompt(event: SessionPromptHook) {
    const external = event.metadata?.lmnrSpanContext;
    this.session(event.sessionID).promptDrafts.set(event.messageID, {
      messageID: event.messageID,
      input: {
        sessionID: event.sessionID,
        messageID: event.messageID,
        ...event.prompt,
        ...(event.metadata ? { metadata: event.metadata } : {}),
      },
      ...(typeof external === "string" && external.length > 0
        ? { externalContext: external }
        : {}),
    });
  }

  onContext(event: SessionContextHook, kind: "primary" | "compaction") {
    const state = this.session(event.sessionID);
    // Serialize now: OpenCode passes the same draft through every plugin's
    // hook, and the span that records it starts later.
    const snapshot = JSON.stringify(requestMessages(event.system, event.messages));
    if (kind === "compaction") {
      state.pendingCompaction = snapshot;
      return;
    }
    state.pendingRequest = snapshot;
    // Laminar reads tool definitions from `gen_ai.tool.definitions`.
    state.pendingTools = JSON.stringify(
      Object.entries(event.tools).map(([name, tool]) => ({
        type: "function",
        name,
        description: tool.description,
        parameters: tool.input,
      })),
    );
  }

  // ---- events ----

  handle(event: OpenCodeEvent) {
    switch (event.type) {
      case "session.created": {
        const state = this.session(event.data.sessionID);
        if (event.data.parentID) state.parentID = event.data.parentID;
        break;
      }
      case "session.inbox.enqueued": {
        const state = this.session(event.data.sessionID);
        const draft = state.promptDrafts.get(event.data.inboxID);
        if (!draft) break;
        state.promptDrafts.delete(event.data.inboxID);
        state.pendingPrompts.push(draft);
        break;
      }
      case "session.inbox.cancelled": {
        const state = this.sessions.get(event.data.sessionID);
        if (!state) break;
        state.promptDrafts.delete(event.data.inboxID);
        state.pendingPrompts = state.pendingPrompts.filter(
          (prompt) => prompt.messageID !== event.data.inboxID,
        );
        break;
      }
      case "session.inbox.delivered": {
        // Still pending while a turn is open: a steering prompt delivered into
        // the running execution rather than input for the next turn.
        const state = this.sessions.get(event.data.sessionID);
        const { inboxID } = event.data;
        const index =
          state?.pendingPrompts.findIndex((prompt) => prompt.messageID === inboxID) ?? -1;
        if (!state?.turn || index < 0) break;
        const [prompt] = state.pendingPrompts.splice(index, 1);
        state.turn.addEvent("prompt", { [SPAN_INPUT]: JSON.stringify(prompt!.input) });
        break;
      }
      case "session.synthetic": {
        this.session(event.data.sessionID).pendingSynthetic = event.data.text;
        break;
      }
      case "session.execution.started": {
        const state = this.session(event.data.sessionID);
        if (this.isChild(state)) state.pendingPrompts = [];
        else if (!state.turn) this.startTurn(state, event.created);
        break;
      }
      case "session.execution.succeeded":
        this.endTurn(this.session(event.data.sessionID), event.created);
        break;
      case "session.execution.failed":
        this.endTurn(
          this.session(event.data.sessionID),
          event.created,
          event.data.error.message,
        );
        break;
      case "session.execution.interrupted":
        this.endTurn(
          this.session(event.data.sessionID),
          event.created,
          `interrupted: ${event.data.reason}`,
        );
        break;
      case "session.step.started": {
        const state = this.session(event.data.sessionID);
        state.steps.get(event.data.assistantMessageID)?.span.end(event.created);
        const { pendingRequest: request, pendingTools: tools } = state;
        state.pendingRequest = undefined;
        state.pendingTools = undefined;
        const { model } = event.data;
        const span = this.startSpan(state, `ai.llm ${model.providerID}:${model.id}`, {
          spanType: "LLM",
          startTime: event.data.started,
          ...(request ? { input: request } : {}),
          attributes: {
            [LaminarAttributes.PROVIDER]: model.providerID,
            [LaminarAttributes.REQUEST_MODEL]: model.id,
            [LaminarAttributes.RESPONSE_MODEL]: model.id,
            "opencode.agent": event.data.agent,
            ...(tools ? { "gen_ai.tool.definitions": tools } : {}),
            ...(model.variant ? { "opencode.model.variant": model.variant } : {}),
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
      case "session.step.streamed": {
        const step = this.sessions
          .get(event.data.sessionID)
          ?.steps.get(event.data.assistantMessageID);
        if (step) step.streamed = event.created;
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
        if (text.length > 0) state.lastText = text;
        const output = responseMessages(text, reasoning, step.toolCalls);
        if (output.length > 0) step.span.setAttribute(SPAN_OUTPUT, JSON.stringify(output));
        step.span.setAttributes(usageAttributes(event.data.tokens, event.data.cost));
        if (event.data.finish) {
          step.span.setAttribute("gen_ai.response.finish_reasons", [event.data.finish]);
        }
        if (event.type === "session.step.failed") {
          fail(step.span, event.data.error.message);
        }
        step.span.end(step.streamed ?? event.created);
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
          ?.toolCalls.push({ type: "tool-call", id: event.data.id, name, input: event.data.input });
        const span = this.startSpan(state, name, {
          spanType: "TOOL",
          input: event.data.input,
          startTime: event.created,
          attributes: { "ai.toolCall.id": event.data.id },
        });
        state.tools.set(event.data.id, { span, name });
        break;
      }
      case "session.tool.progress": {
        const state = this.sessions.get(event.data.sessionID);
        const tool = state?.tools.get(event.data.id);
        const childID = event.data.metadata?.sessionID;
        if (!tool || !SPAWNING_TOOL_NAMES.has(tool.name) || typeof childID !== "string") break;
        // The child comes from event metadata; never let it close a parent cycle.
        if ([...this.lineage(state!)].some((session) => session.id === childID)) break;
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
          tool.span.setAttribute(SPAN_OUTPUT, JSON.stringify(event.data.content));
        }
        if (event.type === "session.tool.failed") {
          fail(tool.span, event.data.error.message);
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
          ...(request ? { input: request } : {}),
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
          fail(span, event.data.error.message);
        }
        span.end(event.created);
        break;
      }
      case "session.deleted": {
        const state = this.sessions.get(event.data.sessionID);
        if (!state) break;
        this.endTurn(state, event.created, "session deleted");
        this.sessions.delete(event.data.sessionID);
        break;
      }
    }
  }

  // Ends everything still open, e.g. when the plugin unloads.
  shutdown(reason = "plugin unloaded") {
    for (const state of this.sessions.values()) this.endTurn(state, Date.now(), reason);
    this.sessions.clear();
  }
}
