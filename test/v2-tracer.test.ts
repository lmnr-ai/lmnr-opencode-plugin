import { Laminar, LaminarSpanProcessor } from "@lmnr-ai/lmnr";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import plugin from "../src/index";
import { SessionTracer } from "../src/v2/tracer";
import type { OpenCodeEvent } from "../src/v2/types";

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  Laminar.initialize({
    projectApiKey: "test",
    // The real Laminar processor (it adds span paths), exporting to memory.
    spanProcessor: new LaminarSpanProcessor({
      spanProcessor: new SimpleSpanProcessor(exporter),
    }),
    instrumentModules: {},
  });
});

afterEach(() => exporter.reset());

let clock = 1_700_000_000_000;
const ev = (type: string, data: Record<string, unknown>) =>
  ({ id: `evt_${clock}`, type, created: (clock += 10), data }) as unknown as OpenCodeEvent;

const model = { providerID: "anthropic", id: "claude-sonnet-4-5" };
const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 10 } };

const prompt = (sessionID: string, text: string, metadata?: Record<string, unknown>) =>
  ({
    sessionID,
    messageID: `msg_${sessionID}_${clock}`,
    prompt: { text },
    delivery: "steer",
    ...(metadata ? { metadata } : {}),
  }) as any;

// Prompt hook followed by admission, in the order OpenCode V2 emits them.
const submit = (
  t: SessionTracer,
  sessionID: string,
  text: string,
  metadata?: Record<string, unknown>,
) => {
  const p = prompt(sessionID, text, metadata);
  t.onPrompt(p);
  t.handle(ev("session.inbox.enqueued", { sessionID, inboxID: p.messageID, item: {} }));
  return p.messageID as string;
};

const context = (sessionID: string, text: string) =>
  ({
    sessionID,
    model,
    agent: "build",
    system: [{ type: "text", text: "You are OpenCode." }],
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    options: {},
    tools: { bash: { description: "", input: {} }, subagent: { description: "", input: {} } },
  }) as any;

const step = (
  t: SessionTracer,
  sessionID: string,
  id: string,
  opts: { text?: string; reasoning?: string; tool?: { id: string; name: string; input: unknown } },
) => {
  t.handle(ev("session.step.started", {
    sessionID, assistantMessageID: id, agent: "build", model, started: clock,
  }));
  if (opts.reasoning) {
    t.handle(ev("session.reasoning.ended", {
      sessionID, assistantMessageID: id, ordinal: 0, text: opts.reasoning,
    }));
  }
  if (opts.text) {
    t.handle(ev("session.text.ended", {
      sessionID, assistantMessageID: id, ordinal: 1, text: opts.text,
    }));
  }
  if (opts.tool) {
    t.handle(ev("session.tool.input.started", {
      sessionID, assistantMessageID: id, id: opts.tool.id, name: opts.tool.name,
    }));
    t.handle(ev("session.tool.called", {
      sessionID, assistantMessageID: id, id: opts.tool.id, input: opts.tool.input, executed: true,
    }));
  }
  t.handle(ev("session.step.ended", {
    sessionID, assistantMessageID: id, finish: opts.tool ? "tool-calls" : "stop", cost: 0.0123, tokens,
  }));
};

const toolDone = (t: SessionTracer, sessionID: string, id: string, text: string) =>
  t.handle(ev("session.tool.success", {
    sessionID, assistantMessageID: "x", id, content: [{ type: "text", text }], executed: true,
  }));

const spans = () => exporter.getFinishedSpans();
const byName = (name: string) => spans().filter((s) => s.name === name);
const parentId = (span: ReadableSpan) =>
  (span as any).parentSpanContext?.spanId ?? (span as any).parentSpanId;
const attr = (span: ReadableSpan, key: string) => span.attributes[key];
const SESSION_ID = "lmnr.association.properties.session_id";

describe("default export", () => {
  it("exposes both the V1 server() and the V2 id/setup()", () => {
    expect(plugin.id).toBe("laminar");
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.server).toBe("function");
  });
});

describe("SessionTracer", () => {
  it("builds one trace per turn with LLM, tool and subagent spans", () => {
    let flushes = 0;
    const t = new SessionTracer(() => flushes++);

    submit(t, "ses_root", "list the files and summarize");
    t.handle(ev("session.execution.started", { sessionID: "ses_root" }));

    t.onContext(context("ses_root", "list the files and summarize"), "primary");
    step(t, "ses_root", "msg_a1", {
      reasoning: "Need to run ls",
      text: "Running ls.",
      tool: { id: "call_bash", name: "bash", input: { command: "ls" } },
    });
    toolDone(t, "ses_root", "call_bash", "README.md\nsrc");

    t.onContext(context("ses_root", "…"), "primary");
    step(t, "ses_root", "msg_a2", {
      tool: { id: "call_sub", name: "subagent", input: { prompt: "summarize README" } },
    });
    t.handle(ev("session.created", { sessionID: "ses_child", parentID: "ses_root" }));
    t.handle(ev("session.tool.progress", {
      sessionID: "ses_root", assistantMessageID: "msg_a2", id: "call_sub",
      metadata: { sessionID: "ses_child", status: "running" },
    }));

    submit(t, "ses_child", "summarize README");
    t.handle(ev("session.execution.started", { sessionID: "ses_child" }));
    t.onContext(context("ses_child", "summarize README"), "primary");
    step(t, "ses_child", "msg_b1", { text: "README describes the plugin." });
    t.handle(ev("session.execution.succeeded", { sessionID: "ses_child" }));
    toolDone(t, "ses_root", "call_sub", "README describes the plugin.");

    t.onContext(context("ses_root", "…"), "primary");
    step(t, "ses_root", "msg_a3", { text: "Two entries; README describes the plugin." });
    t.handle(ev("session.execution.succeeded", { sessionID: "ses_root" }));

    // One turn span; subagent executions do not get their own turn.
    const [turn] = byName("opencode turn");
    expect(byName("opencode turn")).toHaveLength(1);
    expect(turn).toBeDefined();
    expect(parentId(turn!)).toBeUndefined();
    expect(attr(turn!, SESSION_ID)).toBe("ses_root");
    expect(JSON.parse(attr(turn!, "lmnr.span.input") as string)).toMatchObject({
      text: "list the files and summarize",
    });
    expect(attr(turn!, "lmnr.span.output")).toBe("Two entries; README describes the plugin.");

    // Everything is in the turn's trace.
    const traceId = turn!.spanContext().traceId;
    expect(new Set(spans().map((s) => s.spanContext().traceId))).toEqual(new Set([traceId]));

    // Root LLM spans and tools hang off the turn.
    const llms = byName("ai.llm anthropic:claude-sonnet-4-5");
    expect(llms).toHaveLength(4);
    const turnId = turn!.spanContext().spanId;
    const [bash] = byName("bash");
    const [sub] = byName("subagent");
    expect(parentId(bash!)).toBe(turnId);
    expect(parentId(sub!)).toBe(turnId);

    const first = llms.find((s) => attr(s, "lmnr.span.output") === "Running ls.")!;
    expect(parentId(first)).toBe(turnId);
    expect(attr(first, "lmnr.span.type")).toBe("LLM");
    expect(JSON.parse(attr(first, "lmnr.span.input") as string)).toEqual([
      { role: "system", content: "You are OpenCode." },
      { role: "user", content: [{ type: "text", text: "list the files and summarize" }] },
    ]);
    expect(JSON.parse(attr(first, "gen_ai.output.messages") as string)).toEqual([{
      role: "assistant",
      parts: [
        { type: "thinking", content: "Need to run ls" },
        { type: "text", content: "Running ls." },
        { type: "tool_call", id: "call_bash", name: "bash", arguments: { command: "ls" } },
      ],
    }]);
    expect(attr(first, "gen_ai.usage.input_tokens")).toBe(160);
    expect(attr(first, "gen_ai.usage.output_tokens")).toBe(25);
    expect(attr(first, "gen_ai.usage.cache_read_input_tokens")).toBe(50);
    expect(attr(first, "gen_ai.usage.cost")).toBe(0.0123);
    expect(attr(first, "gen_ai.system")).toBe("anthropic");
    expect(attr(first, "gen_ai.request.model")).toBe("claude-sonnet-4-5");

    expect(attr(bash!, "lmnr.span.type")).toBe("TOOL");
    expect(JSON.parse(attr(bash!, "lmnr.span.input") as string)).toEqual({ command: "ls" });
    expect(JSON.parse(attr(bash!, "lmnr.span.output") as string)).toBe("README.md\nsrc");

    // The subagent's LLM span nests under the subagent tool call.
    const child = llms.find((s) => attr(s, "lmnr.span.output") === "README describes the plugin.")!;
    expect(parentId(child)).toBe(sub!.spanContext().spanId);
    expect(attr(child, SESSION_ID)).toBe("ses_root");
    expect(attr(child, "lmnr.spawning_subagent.tool_use_id")).toBe("call_sub");

    // Laminar span paths follow the tree, which is what the UI nests by.
    expect(attr(child, "lmnr.span.path")).toEqual(["opencode turn", "subagent", child.name]);
    expect(attr(bash!, "lmnr.span.path")).toEqual(["opencode turn", "bash"]);

    expect(spans().every((s) => s.ended)).toBe(true);
    expect(flushes).toBe(1);
  });

  it("starts a new trace for each turn of the same session", () => {
    const t = new SessionTracer();
    for (const text of ["first", "second"]) {
      submit(t, "ses_multi", text);
      t.handle(ev("session.execution.started", { sessionID: "ses_multi" }));
      step(t, "ses_multi", `msg_${text}`, { text: `answer ${text}` });
      t.handle(ev("session.execution.succeeded", { sessionID: "ses_multi" }));
    }
    const turns = byName("opencode turn");
    expect(turns).toHaveLength(2);
    expect(turns[0]!.spanContext().traceId).not.toBe(turns[1]!.spanContext().traceId);
    expect(turns.map((s) => attr(s, SESSION_ID))).toEqual(["ses_multi", "ses_multi"]);
  });

  it("parents the turn under an external span context from prompt metadata", () => {
    const outer = Laminar.startSpan({ name: "caller" });
    const serialized = Laminar.serializeLaminarSpanContext(outer)!;
    const t = new SessionTracer();
    submit(t, "ses_ext", "hi", { lmnrSpanContext: serialized });
    t.handle(ev("session.execution.started", { sessionID: "ses_ext" }));
    t.handle(ev("session.execution.succeeded", { sessionID: "ses_ext" }));
    outer.end();
    const [turn] = byName("opencode turn");
    expect(turn!.spanContext().traceId).toBe(outer.spanContext().traceId);
    expect(parentId(turn!)).toBe(outer.spanContext().spanId);
  });

  it("closes open spans with an error when the execution fails", () => {
    const t = new SessionTracer();
    submit(t, "ses_fail", "do it");
    t.handle(ev("session.execution.started", { sessionID: "ses_fail" }));
    t.handle(ev("session.step.started", {
      sessionID: "ses_fail", assistantMessageID: "msg_f", agent: "build", model, started: clock,
    }));
    t.handle(ev("session.execution.failed", {
      sessionID: "ses_fail", error: { type: "provider", message: "rate limited" },
    }));
    expect(spans()).toHaveLength(2);
    expect(spans().every((s) => s.ended && s.status.code === 2)).toBe(true);
    expect(byName("opencode turn")[0]!.status.message).toBe("rate limited");
  });

  it("traces spans that arrive without a prompt (plugin loaded mid-execution)", () => {
    const t = new SessionTracer();
    step(t, "ses_late", "msg_l", { text: "late" });
    t.handle(ev("session.execution.succeeded", { sessionID: "ses_late" }));
    const [turn] = byName("opencode turn");
    const [llm] = byName("ai.llm anthropic:claude-sonnet-4-5");
    expect(parentId(llm!)).toBe(turn!.spanContext().spanId);
    expect(turn!.ended).toBe(true);
  });
  it("ignores prompts that were never admitted or were cancelled", () => {
    const t = new SessionTracer();
    t.onPrompt(prompt("ses_adm", "rejected by admission"));
    const cancelled = submit(t, "ses_adm", "cancelled before delivery");
    t.handle(ev("session.inbox.cancelled", { sessionID: "ses_adm", inboxID: cancelled }));
    submit(t, "ses_adm", "the real prompt");
    t.handle(ev("session.execution.started", { sessionID: "ses_adm" }));
    t.handle(ev("session.execution.succeeded", { sessionID: "ses_adm" }));
    const [turn] = byName("opencode turn");
    expect(JSON.parse(attr(turn!, "lmnr.span.input") as string)).toMatchObject({
      text: "the real prompt",
    });
  });

  it("attaches steering prompts to the running turn and queued ones to the next", () => {
    const t = new SessionTracer();
    submit(t, "ses_q", "first");
    t.handle(ev("session.execution.started", { sessionID: "ses_q" }));
    const steer = submit(t, "ses_q", "steer into first");
    t.handle(ev("session.inbox.delivered", { sessionID: "ses_q", inboxID: steer }));
    const queued = submit(t, "ses_q", "queued for second");
    t.handle(ev("session.execution.succeeded", { sessionID: "ses_q" }));
    t.handle(ev("session.execution.started", { sessionID: "ses_q" }));
    t.handle(ev("session.inbox.delivered", { sessionID: "ses_q", inboxID: queued }));
    t.handle(ev("session.execution.succeeded", { sessionID: "ses_q" }));

    const [first, second] = byName("opencode turn");
    expect(JSON.parse(attr(first!, "lmnr.span.input") as string)).toMatchObject({ text: "first" });
    expect(first!.events.map((e) => JSON.parse(e.attributes!["lmnr.span.input"] as string).text))
      .toEqual(["steer into first"]);
    expect(JSON.parse(attr(second!, "lmnr.span.input") as string)).toMatchObject({
      text: "queued for second",
    });
    expect(second!.events).toHaveLength(0);
  });

  it("strips inline media from the captured request", () => {
    const t = new SessionTracer();
    const big = "x".repeat(100_000);
    t.onContext({
      ...context("ses_media", "look"),
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "media", media: { mime: "image/png", data: big }, filename: "a.png" },
        ],
      }],
    }, "primary");
    step(t, "ses_media", "msg_m", { text: "ok" });
    const [llm] = byName("ai.llm anthropic:claude-sonnet-4-5");
    const input = attr(llm!, "lmnr.span.input") as string;
    expect(input).not.toContain(big.slice(0, 1000));
    expect(input).toContain("a.png");
  });
  it("keeps next-turn state that arrives before the previous turn's end event", () => {
    const t = new SessionTracer();
    submit(t, "ses_race", "first");
    t.handle(ev("session.execution.started", { sessionID: "ses_race" }));
    step(t, "ses_race", "msg_r1", { text: "one" });
    // The next prompt's hook and the next step's context hook run before the
    // stream delivers the end of the first turn.
    const p = prompt("ses_race", "second");
    t.onPrompt(p);
    t.onContext(context("ses_race", "second"), "primary");
    t.handle(ev("session.execution.succeeded", { sessionID: "ses_race" }));
    t.handle(ev("session.inbox.enqueued", { sessionID: "ses_race", inboxID: p.messageID, item: {} }));
    t.handle(ev("session.execution.started", { sessionID: "ses_race" }));
    step(t, "ses_race", "msg_r2", { text: "two" });
    t.handle(ev("session.execution.succeeded", { sessionID: "ses_race" }));

    const [, second] = byName("opencode turn");
    expect(JSON.parse(attr(second!, "lmnr.span.input") as string)).toMatchObject({ text: "second" });
    const llm = byName("ai.llm anthropic:claude-sonnet-4-5").find(
      (s) => attr(s, "lmnr.span.output") === "two",
    )!;
    expect(JSON.parse(attr(llm, "lmnr.span.input") as string)).toContainEqual({
      role: "user",
      content: [{ type: "text", text: "second" }],
    });
  });
});
