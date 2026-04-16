import { LaminarSpanProcessor } from "@lmnr-ai/lmnr";
import { Context, type Span, trace } from "@opentelemetry/api";
import { type ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { sessionCurrentTurnSpan } from "./state";
import { getParentSpanId, otelSpanIdToUUID } from "./utils";

const SPAWNING_TOOL_NAMES = ["task"];

export class OpenCodeLaminarSpanProcessor extends LaminarSpanProcessor {
  log: (level: "debug" | "info" | "warn" | "error", message: string) => void =
    console.log;
  spawningSpanIdtoToolUseId: Record<string, string> = {};
  constructor({
    apiKey,
    baseUrl,
    port,
    log,
  }: {
    baseUrl: string;
    apiKey?: string;
    port?: number | undefined;
    log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  }) {
    super({
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(port ? { port } : {}),
    });
    if (log) {
      this.log = log;
    }
  }

  override onStart(span: Span, context: Context): void {
    const readableSpan = span as unknown as ReadableSpan;
    if (readableSpan.attributes === undefined) {
      this.log(
        "warn",
        "Span is created with otel SDK (attributes are not readable at creation)." +
          "Laminar setup may not work as expected",
      );
    }
    const sessionId = readableSpan.attributes?.[
      "ai.telemetry.metadata.sessionId"
    ] as string | undefined;
    const toolCallId = readableSpan.attributes?.["ai.toolCall.id"] as
      | string
      | undefined;
    let ctx = context;
    if (sessionId && typeof sessionId === "string") {
      const parentSpanContext =
        sessionCurrentTurnSpan[sessionId]?.spanContext();
      const parentSpanId = getParentSpanId(span);
      if (parentSpanContext && !parentSpanId) {
        ctx = trace.setSpan(ctx, trace.wrapSpanContext(parentSpanContext));
        // Otel SDK v1
        Object.assign(span, {
          parentSpanContext,
        });
        // Otel SDK v2
        Object.assign(span, {
          parentSpanId,
        });

        const spanContext = span.spanContext();
        Object.assign(spanContext, {
          ...spanContext,
          traceId: parentSpanContext.traceId,
        });
        Object.assign(spanContext, {
          _spanContext: spanContext,
        });
      }
    }
    if (toolCallId && typeof toolCallId === "string") {
      const toolCallNameAttr = readableSpan.attributes?.["ai.toolCall.name"] as
        | string
        | undefined;
      if (
        SPAWNING_TOOL_NAMES.includes(readableSpan.name) ||
        (readableSpan.name === "ai.toolCall" &&
          toolCallNameAttr &&
          SPAWNING_TOOL_NAMES.includes(toolCallNameAttr))
      ) {
        const spanIdUuid = otelSpanIdToUUID(span.spanContext().spanId);
        this.spawningSpanIdtoToolUseId[spanIdUuid] = toolCallId;
      }
    }
    super.onStart(span, ctx);

    const spanIdsPath = (span as unknown as ReadableSpan).attributes?.[
      "lmnr.span.ids_path"
    ] as Array<string> | undefined;

    if (spanIdsPath && spanIdsPath.length > 0) {
      // reimplementing findLast for older JS versions
      let spawningToolCallSpanId: string | undefined;
      for (let i = spanIdsPath.length - 1; i >= 0; i--) {
        if (this.spawningSpanIdtoToolUseId[spanIdsPath[i]!] !== undefined) {
          spawningToolCallSpanId = spanIdsPath[i];
          break;
        }
      }
      if (spawningToolCallSpanId) {
        const spawningToolCallId =
          this.spawningSpanIdtoToolUseId[spawningToolCallSpanId];
        span.setAttributes({
          "lmnr.spawning_subagent.span_id": spawningToolCallSpanId,
          ...(spawningToolCallId
            ? { "lmnr.spawning_subagent.tool_use_id": spawningToolCallId }
            : {}),
        });
      }
    }
  }

  override onEnd(span: ReadableSpan) {
    const spanId = span.spanContext().spanId;
    delete this.spawningSpanIdtoToolUseId[spanId];
    super.onEnd(span);
  }
}
