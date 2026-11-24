# AGENTS.md

`@lmnr-ai/opencode-plugin` traces OpenCode sessions in [Laminar](https://laminar.sh). See `README.md` for user-facing behavior and configuration.

## Commands

Package manager is **pnpm**.

```bash
pnpm install
pnpm build      # tsdown -> dist/ (cjs + mjs + d.ts); also runs on `prepare`
pnpm lint       # eslint (pnpm lint:fix to autofix)
pnpm test       # node --test via tsx, test/*.test.ts
```

CI runs build, lint and tests (`.github/workflows/`). Run all three before pushing.

## Layout

- `src/index.ts` — the single default export. Serves both OpenCode generations: V2 reads `id` + `setup()`, V1 calls `server()`.
- `src/v1.ts`, `src/processor.ts` — OpenCode V1 (>= 1.4): enables OpenCode's experimental OpenTelemetry flag and adds a Laminar span processor.
- `src/v2/` — OpenCode V2: `tracer.ts` subscribes to the event stream and builds spans itself (one per model step, one per tool call); `messages.ts` converts to OpenCode's message format; `index.ts` is `setupV2`.
- `src/state.ts`, `src/utils.ts` — shared helpers.
- `test/` — tests (currently the V2 tracer).

## Conventions and gotchas

- **Keep `src/index.ts` a single default export.** Older V1 loaders call every exported function, so a second export loads the plugin twice.
- Keep both CJS and ESM outputs; `package.json` `exports` depends on both.
- V2 types come from `@opencode/plugin` (dev dependency only). Don't leak its large context types into the published declarations; use `satisfies` as in `index.ts`.
- Span names: each turn is an `opencode turn` span. Don't rename without checking Laminar-side consumers.
- Without `LMNR_PROJECT_API_KEY` the plugin must be a no-op, never throw.
- Style is enforced by eslint (stylistic, simple-import-sort, unused-imports). Use `pnpm lint:fix` rather than hand-formatting.
- Changes should work on both V1 and V2 unless explicitly scoped to one.

## Releases

Publishing happens from a GitHub release via `publish-to-npm.yml`, with provenance. It verifies the tag points to a commit on `main` whose `package.json` version matches the tag, so bump `version` before tagging. Third-party actions and the npm CLI are pinned; keep them pinned when editing workflows.
