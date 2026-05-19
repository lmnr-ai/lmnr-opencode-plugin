import { Laminar } from "@lmnr-ai/lmnr";
import { type Plugin } from "@opencode-ai/plugin";
import { NodeSDK } from "@opentelemetry/sdk-node";

import { OpenCodeLaminarSpanProcessor } from "./processor";
import {
  sessionCurrentTurnSpan,
  sessionExternalContexts,
  subagentSessionIds,
} from "./state";
import { loadEnv } from "./utils";

// eslint-disable-next-line @typescript-eslint/require-await
export const LaminarPlugin: Plugin = async ({ client }) => {
  loadEnv({
    quiet: true,
  });
  const projectApiKey = process.env.LMNR_PROJECT_API_KEY;
  const baseUrl = process.env.LMNR_BASE_URL ?? "https://api.lmnr.ai";
  const port = process.env.LMNR_GRPC_PORT
    ? Number(process.env.LMNR_GRPC_PORT)
    : baseUrl === "https://api.lmnr.ai"
      ? 8443
      : undefined;

  const log = (level: "debug" | "info" | "warn" | "error", message: string) => {
    client.app
      .log({
        body: { service: "laminar", level, message },
      })
      .catch(() => console.log("Failed to call opencode log"));
  };

  if (!projectApiKey) {
    log(
      "info",
      "Laminar plugin enabled, but LMNR_PROJECT_API_KEY not set, skipping plugin initialization",
    );
    return {};
  }

  const processor = new OpenCodeLaminarSpanProcessor({
    apiKey: projectApiKey,
    baseUrl,
    port,
  });

  const sdk = new NodeSDK({
    spanProcessors: [processor],
  });
  sdk.start();

  log("info", `Laminar tracing initialized → ${baseUrl}`);

  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    config: async (config) => {
      if (!config.experimental?.openTelemetry) {
        if (config.experimental) {
          config.experimental.openTelemetry = true;
        } else {
          config.experimental = { openTelemetry: true };
        }
        log(
          "warn",
          "OpenTelemetry experimental feature is disabled in Opencode config, enabling it...",
        );
      }
    },
    event: async ({ event }) => {
      switch (event.type) {
        case "session.idle": {
          const sessionId = event.properties.sessionID;
          if (sessionCurrentTurnSpan[sessionId]) {
            sessionCurrentTurnSpan[sessionId].end();
            delete sessionCurrentTurnSpan[sessionId];
          }
          log("info", "Flushing OTEL spans before idle");
          await processor.forceFlush();
          break;
        }
        case "server.instance.disposed":
          await processor.shutdown();
          break;
        case "session.created":
        case "session.updated":
          // For now, assume that any subsession is a subagent, don't create turn spans for it.
          if (event.properties.info.parentID) {
            const parentId = event.properties.info.parentID;
            if (!subagentSessionIds[parentId]) {
              subagentSessionIds[parentId] = new Set();
            }
            subagentSessionIds[parentId].add(event.properties.info.id);
          }
          break;
        case "session.deleted": {
          const sessionID = event.properties.info.id;
          if (sessionCurrentTurnSpan[sessionID]) {
            sessionCurrentTurnSpan[sessionID].end();
            delete sessionCurrentTurnSpan[sessionID];
          }
          if (subagentSessionIds[sessionID]) {
            delete subagentSessionIds[sessionID];
          }
          Object.values(subagentSessionIds).forEach((childSessions) =>
            childSessions.delete(sessionID),
          );
          delete sessionExternalContexts[sessionID];
          log("info", "Flushing OTEL spans before session deletion");
          await processor.forceFlush();
          break;
        }
      }
      await processor.forceFlush();
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    "chat.message": async (
      { sessionID, agent, model, messageID, variant },
      output,
    ) => {
      // Always strip the synthetic Laminar context part from the outgoing
      // message and capture the most recent context for this session, even
      // if we are about to skip span creation. Otherwise the LLM would see
      // the synthetic part on its prompt and the new context would never
      // overwrite a stale one carried over from a previous turn.
      const newParts = output.parts.filter((part) => {
        if (
          part.type === "text" &&
          part.text === "" &&
          part.metadata?.lmnrSpanContext &&
          part.synthetic === true &&
          part.ignored === true
        ) {
          sessionExternalContexts[sessionID] = part.metadata
            ?.lmnrSpanContext as string;
          return false;
        }
        return true;
      });
      output.parts = newParts;

      if (
        Object.values(subagentSessionIds).some((childSessions) =>
          childSessions.has(sessionID),
        ) ||
        sessionCurrentTurnSpan[sessionID]
      ) {
        // Subagent messages (first prompt) also emit this event, so we skip
        // span creation for them. Same for sessions that already have an
        // open turn span — the AI SDK spans will re-parent under it.
        return;
      }

      const externalContext = sessionExternalContexts[sessionID];
      const span = Laminar.startSpan({
        name: "opencode turn",
        input: {
          sessionID,
          agent,
          model,
          messageID,
          variant,
          message: output.message,
          parts: output.parts,
          externalContext,
        },
        sessionId: sessionID,
        ...(externalContext ? { parentSpanContext: externalContext } : {}),
      });
      sessionCurrentTurnSpan[sessionID] = span;
    },
  };
};

export default LaminarPlugin;
