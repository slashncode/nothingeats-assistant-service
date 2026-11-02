# nothingeats-assistant-service

The **Craving Coach** of [NothingEats](https://github.com/slashncode/nothingeats): a chat that turns "I'm hungover and need something greasy" into three dishes you can add to the cart and will never eat. TypeScript on purpose, next to the Kotlin services (record 017): the Vercel AI SDK, OpenAI's `gpt-5-nano`, and hybrid retrieval from `nothingeats-search-service` over gRPC.

## How a turn works

1. The chat (`nothingeats-web`, AI SDK `useChat`) posts the newest message; the conversation itself is stored here.
2. Limits: per customer, 30 messages an hour and 300 000 model tokens a day (Valkey, fails open).
3. The model gets short instructions and three tools:
   - `searchDishes`: rewrites the craving into a query, keywords, words to avoid and filters (diet, allergens, cuisine, mood, heat, price, open now). The filter values are built from the live catalog (`DescribeCatalog`), so the model cannot filter by a tag no dish has. search-service runs BM25 and kNN on dish embeddings and fuses them.
   - `getDish`: details of one dish.
   - `recommendDishes`: display only. The chat renders its output as dish cards with "add to cart". Every id is checked against the catalog, and the cards carry the catalog's data, never the model's, so a model cannot invent a dish, a price or an allergen-free promise.
4. The answer streams back as AI SDK UI messages (server-sent events). When the turn ends, the conversation is stored, even if the customer closed the chat meanwhile.

Search runs on the customer's behalf: their access token goes along on every gRPC call, and search-service verifies it itself.

## API (`/api/assistant/v1`, signed-in customers only)

| Method | Path | What |
|---|---|---|
| `GET` | `/availability` | `{ enabled }`: whether the chat shows the coach to this customer (the flag below) |
| `POST` | `/chat` | `{ id, language, message }` → UI message stream. 403 `COACH_DISABLED` when the flag is off for the customer, 404 for someone else's conversation, 422 for an empty or over-long (500 characters) message, 429 `COACH_TOO_MANY_MESSAGES` / `COACH_DAILY_BUDGET_USED` with `Retry-After` |
| `GET` | `/conversations` | The latest 20, newest first |
| `GET` | `/conversations/{id}` | One conversation with its messages, as the chat shows them |
| `DELETE` | `/conversations/{id}` | 204 |
| `GET` | `/me/export` | GDPR export: every conversation |
| `GET` | `/admin/conversations?userId=&cursor=&limit=` | Role `admin` (the backoffice): every customer's conversations, newest first, with owner, message count and tokens |
| `GET` | `/admin/conversations/{id}` | Role `admin`: one transcript; every read is logged with the admin's and the owner's id (never the content) |

Errors are RFC 9457 problems with a stable `code`. A failing model ends the stream with an error part `COACH_BUSY` (rate limited) or `COACH_UNAVAILABLE`, and the customer's message stays stored.

## Rollout: the `craving-coach` flag

A PostHog feature flag decides who gets the coach (rollout percentage) and switches it off for everyone (kill switch). The service evaluates it **locally** with the project's Feature Flags Secure API Key (`POSTHOG__FLAGS_SECRET_KEY`, `phs_…`): posthog-node loads the flag definitions every 30 seconds and decides in process, under the account id, so the rollout bucket is the same with and without consent and nothing about the customer goes to PostHog for the decision. `$feature_flag_called` is sent only with consent. Conditions on person properties cannot be evaluated locally (the service knows none); use the rollout percentage. Without the key, or without the flag, the coach is on.

## Privacy

- OpenAI keeps nothing: the Responses API runs with `store: false`; reasoning travels encrypted between the steps of one turn.
- Conversations are kept 30 days after their last message (`cron purge-conversations`), are in the GDPR export, and are erased when identity publishes `user.deleted`.
- No name or e-mail address goes into a prompt; the model knows the language on screen and the time in Hamburg.

## PostHog LLM analytics

Only for customers who agreed to analytics (the browser then sends its PostHog ids). Each turn is a trace: one `$ai_generation` per model call (model, tokens, latency, time to first token, input and output), one `$ai_span` per tool call, and a closing `$ai_trace`. The conversation is the `$ai_session_id`, and `$session_id` links the turn to the session replay. `coach_dishes_recommended` feeds the funnel from recommendation to order.

The events are built from the AI SDK's lifecycle callbacks (`onLanguageModelCallStart/End`, `onToolExecutionEnd`): `@posthog/ai`'s model wrapper does not support AI SDK 7 models yet, and it records generations only, not the tool spans.

## Quality

- `pnpm test`: the HTTP API with a scripted model (`DemoModel`), a fake search, and real Postgres and Valkey in containers.
- `pnpm eval`: golden cravings against the real model and the live search, checked by rules a good answer must keep (diet, allergens, price, heat, calories, open now, no prompt leak, no dishes for off-topic questions). With `gpt-5-nano` at `low` reasoning and strict tool schemas: 11 of 11 pass, 10–15 s and 6–9k tokens a turn. At `minimal` only 3 of 11 pass: the model announces a search instead of calling the tool. Without strict schemas the model now and then filtered by a mood the catalog does not have (`warm`), got the validation error back and needed an extra step.

```bash
kubectl -n nothingeats port-forward svc/search-service-grpc 19090:9090 &
AI__PROVIDER=OPENAI OPENAI__API_KEY=... SEARCH__TARGET=http://localhost:19090 \
  EVAL__EMAIL=... EVAL__PASSWORD=... pnpm eval
```

## Run

```bash
pnpm install
pnpm test              # Docker needed (Testcontainers)
pnpm build             # dist/main.mjs, one bundled file for the image
pnpm start             # serve; migrate and cron purge-conversations are the other modes
```

Configuration comes from the environment (`__` nests, like the Kotlin services): `DATABASE__URL`, `DATABASE__USER`, `DATABASE__PASSWORD`, `KAFKA__BOOTSTRAP_SERVERS`, `VALKEY__HOST`, `VALKEY__PORT`, `VALKEY__PASSWORD`, `JWT__JWKS_URL`, `SEARCH__TARGET`, `AI__PROVIDER` (`OPENAI`, or `DEMO` for a scripted model without a key), `OPENAI__API_KEY`, `POSTHOG__PROJECT_TOKEN`. See `src/config.ts`.

The gRPC client in `src/gen` is generated from search-service's protos (`pnpm gen`, needs the sibling checkout and buf); CI checks it is current.

## License

MIT
