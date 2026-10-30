# CLAUDE.md

Assistant service of NothingEats: the Craving Coach chat (TypeScript, Vercel AI SDK 7, OpenAI). The cross-repo plan and session rules live in `../CLAUDE.md` (workspace root), if present — read it first.

## Commands

- `pnpm test` — Vitest; Docker needed (Postgres and Valkey via Testcontainers)
- `pnpm lint` / `pnpm typecheck`
- `pnpm build` — esbuild bundle `dist/main.mjs` (+ `native.wasm` for the Kafka client)
- `pnpm gen` — regenerate `src/gen` from `../nothingeats-search-service/grpc-api/src/main/proto` (buf)
- `pnpm db:generate --name <what>` — a new Drizzle migration from `src/store/schema.ts`
- `pnpm eval` — golden cravings against the real model and live search (see README)

## Rules

- Node runs the TypeScript sources directly (type stripping): only erasable syntax, no enums or constructor parameter properties, imports with `.ts`.
- The coach recommends only through `recommendDishes`; its cards carry catalog data. Never let model text become dish data.
- Every search call forwards the customer's token; there is no service identity towards search.
- Tool input schemas are strict (OpenAI structured outputs): "not given" is `.nullable()`, never `.optional()`.
- PostHog only with consent (`Consent` from the browser's PostHog headers). LLM analytics events are built in `CoachTrace`.
- Prompt or model changes are judged by `pnpm eval`, not by feel. Add a golden craving for every complaint.
- Migrations in `drizzle/` are generated and never edited after they ran somewhere.
- `user.deleted` erases every conversation of that customer; the export holds everything stored.
