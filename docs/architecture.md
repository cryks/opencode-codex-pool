# Architecture

Understand how `codex-pool` preserves normal Codex behavior while adding multi-account routing.

---

## Start with the goal

`codex-pool` is an external opencode plugin for people who want to use multiple ChatGPT Codex OAuth accounts through one `openai` provider.

The design goal is simple: keep the primary account behaving exactly like normal Codex, then add a quota-aware routing layer on top.

---

## Understand the integration

The plugin hooks `provider: "openai"` through `auth.loader`.

The built-in Codex plugin still runs first, then `codex-pool` layers in a dummy OAuth `apiKey` and a replacement `fetch` implementation.

This is what keeps built-in Codex behavior such as model shaping, zeroed costs, and Codex-specific request handling intact.

---

## Distinguish the account roles

- **primary**: the default `openai` account in opencode
- **pool**: every extra non-primary account stored by the plugin

The primary account is mirrored back into core auth so opencode still sees `auth.type = "oauth"` on the `openai` provider.

That is the key compatibility requirement for staying in Codex mode.

---

## Track where state lives

The plugin uses two local files:

- config: `~/.config/opencode/codex-pool.json`
- database: `~/.local/share/opencode/codex-pool.db`

SQLite is the runtime source of truth for:

- account tokens and metadata
- primary and priority state
- cooldowns after rate limits
- shared quota cache
- dormant-touch suppression
- refresh and usage locks across processes

The database runs in WAL mode so multiple opencode processes can coordinate safely.

---

## Follow the auth flow

The plugin exposes these auth actions:

- `Login primary Codex account (browser)`
- `Login primary Codex account (headless)`
- `Add pool account (browser)`
- `Add pool account (headless)`
- `Edit pool accounts`

If opencode already has a valid OAuth login for the default `openai` account, `codex-pool` bootstraps that account into SQLite automatically when the plugin starts.

Pool accounts are stored only in SQLite and are represented in auth state through an inert shadow provider.

---

## Follow the request path

At a high level, a prompt attempt looks like this:

1. read the current auth and shared store state
2. collect available accounts from SQLite
3. warm or reuse quota data
4. score the candidate accounts
5. choose the best account
6. optionally enable fast mode for that attempt
7. send the request through the overridden fetch path
8. refresh on `401` or fail over on `429` when needed

Routing happens per attempt, not per session, although sticky affinity can bias the next selection.

---

## Learn the routing model

Routing is quota-aware and priority-based.

It is not round-robin.

Each available account gets a score. Higher score means the account has more useful remaining capacity right now.

The score is influenced by:

- plan weight
- remaining capacity
- time left in the active window
- absolute window size
- recovery horizon
- bounded health adjustments

If scores tie, stored priority order breaks the tie.

Once scores are available, requests are reordered across the full fleet rather than only at a `core` versus `pool` boundary.

---

## Handle multiple windows

When `rate_limit` exposes multiple complete windows with a clear longest span:

- the longest window becomes the main score
- the shorter windows act as guardrails
- the final routing score becomes `main_score * worst_guard_factor`

This keeps a healthy long window from dominating when a shorter guard window is close to exhaustion.

If the windows cannot be reduced cleanly, routing falls back to the more conservative raw-window comparison.

`additional_rate_limits` and `code_review_rate_limit` are ignored for account selection.

---

## Reuse quota data

Quota signals come from `https://chatgpt.com/backend-api/wham/usage`.

The plugin caches raw usage payloads in SQLite so multiple opencode processes can share warm data.

Important behaviors:

- fresh cache is authoritative for 60 seconds
- active accounts are revalidated in the background every 30 seconds once cache age passes 3 minutes
- stale cache can still be reused briefly while background warming starts
- cache is synchronously refreshed when a considered non-dormant window can no longer describe the active state
- per-account usage refreshes are deduplicated with SQLite locks

If a stored account row does not yet know the `ChatGPT-Account-Id`, the plugin still queries usage without that header and persists `account_id` later if the payload returns it.

---

## Understand sticky affinity

Different ChatGPT accounts do not share provider-side prompt cache state.

To reduce unnecessary cache misses, `codex-pool` keeps short-lived per-session affinity for the account that most recently succeeded.

Key behaviors:

- affinity is keyed by `prompt_cache_key`
- the affinity window lasts 5 minutes
- `sticky-mode: "disabled"` turns it off
- `sticky-mode: "always"` holds the sticky account unless it becomes unavailable
- `sticky-mode: "auto"` breaks affinity only when another account is materially better, blocked, or the window expires

`sticky-strength` scales how hard `auto` mode resists switching.

---

## Understand fast mode

Fast mode is a post-selection request decoration in `src/fetch.ts`.

It never changes account ordering or sticky affinity.

When enabled, the plugin adds OpenAI's `service_tier: "priority"` field to the outbound request unless the caller already provided `service_tier` or `serviceTier`.

Modes:

- `auto`: use score-based fast-mode gating
- `always`: force fast mode on when request decoration is possible
- `disabled`: never add plugin-managed fast mode

Fast mode uses the same usage data as routing and stays off when limits are blocked, capacity is too low, or the data is incomplete.

---

## Understand dormant touch

Dormant windows are handled separately from the normal score.

`dormant-touch` modes:

- `always`: promote an account with an untouched dormant `rate_limit` window ahead of normal quota ranking for one successful request
- `new-session-only`: allow that promotion only before the current request has active sticky affinity
- `disabled`: skip dormant-touch promotion entirely

An untouched dormant window means:

- `used_percent = 0`
- `reset_after_seconds === limit_window_seconds`

After the first successful touch, that window is suppressed for 30 minutes in SQLite so other opencode processes do not keep re-prioritizing it.

---

## Understand retries and failure rules

- on `401`, the plugin refreshes the account token and retries once
- on `429`, the account is cooled down and the next eligible account is tried
- an account is disabled only after a durable auth failure: it still returns `401` after refresh and retry
- transient request, refresh, and usage-fetch failures do not disable the account

Request bodies are snapshotted before retries so one attempt's outbound fields do not leak into later attempts.

---

## Read the observability signals

Immediately before an outbound prompt attempt, the plugin shows a compact toast with:

- the chosen account
- a short reason for the choice
- score details
- fast-mode status

When stale quota cache is reused, the toast also includes the cache age.

When reduced multi-window scoring applies, the score summary is shown as:

```text
<score> (<base> * guard x<factor>)
```

---

## Browse the source

```text
src/
  config.ts
  index.ts
  store.ts
  codex.ts
  oauth.ts
  sync.ts
  fetch.ts
  types.ts
test/
  config.test.ts
  index.test.ts
  store.test.ts
  fetch.test.ts
```

Main responsibilities:

- `src/index.ts` — plugin entry, auth actions, loader
- `src/fetch.ts` — routing, failover, refresh, sticky affinity, fast mode
- `src/store.ts` — SQLite CRUD, cooldowns, locks, quota cache
- `src/oauth.ts` — browser flow, device flow, refresh
- `src/sync.ts` — bootstrap existing primary auth into SQLite

---

## Run the checks

```bash
bun run build
bun run typecheck
bun test
```

Tests use real SQLite databases rather than mocks, including multi-connection cases.
