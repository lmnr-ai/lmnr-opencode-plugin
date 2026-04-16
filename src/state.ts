import { Span } from "@opentelemetry/api";

export const sessionCurrentTurnSpan: Record<string, Span> = {};
// parent -> set of child sessions
export const subagentSessionIds: Record<string, Set<string>> = {};
export const sessionExternalContexts: Record<string, string> = {};
