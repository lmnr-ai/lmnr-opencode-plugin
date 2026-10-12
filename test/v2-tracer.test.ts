import { Laminar, LaminarSpanProcessor } from "@lmnr-ai/lmnr";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";

import plugin from "../src/index";
import { SessionTracer } from "../src/v2/tracer";
import type { OpenCodeEvent } from "../src/v2/types";

const exporter = new InMemorySpanExporter();

before(() => {
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
const outputText = (span: ReadableSpan) =>
  JSON.parse((attr(span, "lmnr.span.output") as string) ?? "[]")[0]?.content
    .find((part: { type: string }) => part.type === "text")?.text;
const inputText = (span: ReadableSpan) =>
  JSON.parse(attr(span, "lmnr.span.input") as string).text;
const SESSION_ID = "lmnr.association.properties.session_id";

describe("default export", () => {
  it("exposes both the V1 server() and the V2 id/setup()", () => {
    assert.equal(plugin.id, "laminar");
    assert.equal(typeof plugin.setup, "function");
    assert.equal(typeof plugin.server, "function");
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
    assert.equal(byName("opencode turn").length, 1);
    assert.ok(turn);
    assert.equal(parentId(turn!), undefined);
    assert.equal(attr(turn!, SESSION_ID), "ses_root");
    assert.equal(inputText(turn!), "list the files and summarize");
    assert.equal(attr(turn!, "lmnr.span.output"), "Two entries; README describes the plugin.");

    // Everything is in the turn's trace.
    const traceId = turn!.spanContext().traceId;
    assert.deepEqual(new Set(spans().map((s) => s.spanContext().traceId)), new Set([traceId]));

    // Root LLM spans and tools hang off the turn.
    const llms = byName("ai.llm anthropic:claude-sonnet-4-5");
    assert.equal(llms.length, 4);
    const turnId = turn!.spanContext().spanId;
    const [bash] = byName("bash");
    const [sub] = byName("subagent");
    assert.equal(parentId(bash!), turnId);
    assert.equal(parentId(sub!), turnId);

    const first = llms.find((s) => outputText(s) === "Running ls.")!;
    assert.equal(parentId(first), turnId);
    assert.equal(attr(first, "lmnr.span.type"), "LLM");
    assert.deepEqual(JSON.parse(attr(first, "lmnr.span.input") as string), [
      { role: "system", content: [{ type: "text", text: "You are OpenCode." }] },
      { role: "user", content: [{ type: "text", text: "list the files and summarize" }] },
    ]);
    assert.deepEqual(JSON.parse(attr(first, "lmnr.span.output") as string), [{
      role: "assistant",
      content: [
        { type: "reasoning", text: "Need to run ls" },
        { type: "text", text: "Running ls." },
        { type: "tool-call", id: "call_bash", name: "bash", input: { command: "ls" } },
      ],
    }]);
    assert.equal(attr(first, "gen_ai.usage.input_tokens"), 160);
    assert.equal(attr(first, "gen_ai.usage.output_tokens"), 25);
    assert.equal(attr(first, "gen_ai.usage.cache_read.input_tokens"), 50);
    assert.deepEqual(attr(first, "gen_ai.response.finish_reasons"), ["tool-calls"]);
    assert.equal(attr(first, "gen_ai.usage.cost"), 0.0123);
    assert.equal(attr(first, "gen_ai.system"), "anthropic");
    assert.equal(attr(first, "gen_ai.request.model"), "claude-sonnet-4-5");
    assert.deepEqual(JSON.parse(attr(first, "gen_ai.tool.definitions") as string), [
      { type: "function", name: "bash", description: "", parameters: {} },
      { type: "function", name: "subagent", description: "", parameters: {} },
    ]);

    assert.equal(attr(bash!, "lmnr.span.type"), "TOOL");
    assert.deepEqual(JSON.parse(attr(bash!, "lmnr.span.input") as string), { command: "ls" });
    assert.deepEqual(JSON.parse(attr(bash!, "lmnr.span.output") as string), [
      { type: "text", text: "README.md\nsrc" },
    ]);

    // The subagent's LLM span nests under the subagent tool call.
    const child = llms.find((s) => outputText(s) === "README describes the plugin.")!;
    assert.equal(parentId(child), sub!.spanContext().spanId);
    assert.equal(attr(child, SESSION_ID), "ses_root");
    assert.equal(attr(child, "lmnr.spawning_subagent.tool_use_id"), "call_sub");

    // Laminar span paths follow the tree, which is what the UI nests by.
    assert.deepEqual(attr(child, "lmnr.span.path"), ["opencode turn", "subagent", child.name]);
    assert.deepEqual(attr(bash!, "lmnr.span.path"), ["opencode turn", "bash"]);

    assert.ok(spans().every((s) => s.ended));
    assert.equal(flushes, 1);
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
    assert.equal(turns.length, 2);
    assert.notEqual(turns[0]!.spanContext().traceId, turns[1]!.spanContext().traceId);
    assert.deepEqual(turns.map((s) => attr(s, SESSION_ID)), ["ses_multi", "ses_multi"]);
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
    assert.equal(turn!.spanContext().traceId, outer.spanContext().traceId);
    assert.equal(parentId(turn!), outer.spanContext().spanId);
  });

  it("ends the LLM span when the response finishes streaming, not when its tools settle", () => {
    const t = new SessionTracer();
    submit(t, "ses_stream", "run it");
    t.handle(ev("session.execution.started", { sessionID: "ses_stream" }));
    const ids = { sessionID: "ses_stream", assistantMessageID: "msg_s" };
    t.handle(ev("session.step.started", { ...ids, agent: "build", model, started: clock }));
    const streamed = ev("session.step.streamed", ids);
    t.handle(streamed);
    t.handle(ev("session.tool.input.started", { ...ids, id: "call_s", name: "bash" }));
    t.handle(ev("session.tool.called", { ...ids, id: "call_s", input: {}, executed: true }));
    toolDone(t, "ses_stream", "call_s", "done");
    t.handle(ev("session.step.ended", { ...ids, finish: "tool-calls", cost: 0, tokens }));
    const [llm] = byName("ai.llm anthropic:claude-sonnet-4-5");
    assert.equal(llm!.endTime[0] * 1e3 + llm!.endTime[1] / 1e6, streamed.created);
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
    assert.equal(spans().length, 2);
    assert.ok(spans().every((s) => s.ended && s.status.code === 2));
    // Laminar marks a span as failed only when it carries an exception event.
    assert.ok(spans().every((s) => s.events.some((e) => e.name === "exception")));
    assert.equal(byName("opencode turn")[0]!.status.message, "rate limited");
  });

  it("traces spans that arrive without a prompt (plugin loaded mid-execution)", () => {
    const t = new SessionTracer();
    step(t, "ses_late", "msg_l", { text: "late" });
    t.handle(ev("session.execution.succeeded", { sessionID: "ses_late" }));
    const [turn] = byName("opencode turn");
    const [llm] = byName("ai.llm anthropic:claude-sonnet-4-5");
    assert.equal(parentId(llm!), turn!.spanContext().spanId);
    assert.ok(turn!.ended);
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
    assert.equal(inputText(turn!), "the real prompt");
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
    assert.equal(inputText(first!), "first");
    assert.deepEqual(
      first!.events.map((e) => JSON.parse(e.attributes!["lmnr.span.input"] as string).text),
      ["steer into first"],
    );
    assert.equal(inputText(second!), "queued for second");
    assert.equal(second!.events.length, 0);
  });

  it("keeps inline media in the captured request", () => {
    const t = new SessionTracer();
    const big = "x".repeat(100_000);
    t.onContext({
      ...context("ses_media", "look"),
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "media",
            media: { mediaType: "image/png", source: { type: "base64", data: big } },
            filename: "a.png",
          },
        ],
      }],
    }, "primary");
    step(t, "ses_media", "msg_m", { text: "ok" });
    const [llm] = byName("ai.llm anthropic:claude-sonnet-4-5");
    const input = attr(llm!, "lmnr.span.input") as string;
    assert.deepEqual(JSON.parse(input)[1].content[1], {
      type: "media",
      media: { mediaType: "image/png", source: { type: "base64", data: big } },
      filename: "a.png",
    });
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
    assert.equal(inputText(second!), "second");
    const llm = byName("ai.llm anthropic:claude-sonnet-4-5").find(
      (s) => outputText(s) === "two",
    )!;
    assert.deepEqual(JSON.parse(attr(llm, "lmnr.span.input") as string).at(-1), {
      role: "user",
      content: [{ type: "text", text: "second" }],
    });
  });
  it("ignores subagent progress that would make a session its own ancestor", () => {
    const t = new SessionTracer();
    t.handle(ev("session.execution.started", { sessionID: "ses_loop" }));
    step(t, "ses_loop", "msg_l1", {
      tool: { id: "call_self", name: "subagent", input: {} },
    });
    t.handle(ev("session.tool.progress", {
      sessionID: "ses_loop", assistantMessageID: "msg_l1", id: "call_self",
      metadata: { sessionID: "ses_loop" },
    }));
    step(t, "ses_loop", "msg_l2", { text: "still tracing" });
    t.handle(ev("session.execution.succeeded", { sessionID: "ses_loop" }));
    assert.equal(byName("opencode turn").length, 1);
  });
});
