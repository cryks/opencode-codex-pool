# codex-pool

`codex-pool` is an external opencode plugin that lets one `openai` provider use multiple ChatGPT Codex OAuth accounts. It keeps the primary account compatible with opencode's built-in Codex behavior, then routes requests across additional accounts with quota-aware ordering, sticky session affinity, and 429 failover.

## What it does

- Mirrors one primary OAuth account into opencode so Codex-specific behavior stays active.
- Stores all account tokens and routing state in SQLite.
- Routes requests between the primary account (`core`) and secondary accounts (`pool`) based on remaining quota score.
- Retries on rate limits by cooling down the current account and moving to the next available one.
- Refreshes expired tokens automatically and coordinates refreshes across processes with SQLite locks.
- Keeps per-session affinity for a short window so prompt-cache warmth is not lost unnecessarily.
- Dynamically injects `service_tier: "priority"` for under-burned requests when cached or freshly warmed usage data shows capacity is ahead of time.
- Shows a compact selection toast immediately before each outbound prompt attempt, with a `>` marker on the chosen account, whether fast-mode is enabled for that attempt, aligned compared account scores in `[plan] account: score` form, and the reason that account was chosen.
- Shows a separate toast when fast-mode flips for the same sticky session without an account switch.

## How it works

The plugin hooks `provider: "openai"` through `auth.loader`. opencode's built-in Codex plugin still runs first, so model filtering and Codex-specific behavior stay intact. This plugin then supplies a dummy OAuth API key plus a replacement fetch layer, while leaving the rest of the Codex integration alone.

At runtime, the router compares the primary account against the highest-priority available pool account. Each side gets a quota score derived from the ChatGPT usage endpoint. Higher score means the account has more weighted capacity worth spending now, so it goes first. Scores account for both the absolute capacity of each rate-limit window (larger windows like 7-day limits represent more usable room than smaller 5-hour limits) and a conservation factor that penalizes windows with long recovery times after they have started. Because the 5-hour and 7-day windows are first-use-anchored, untouched windows are treated as dormant: they keep their capacity boost so the router is willing to start their clock early, but they do not receive long-recovery conservation dampening until the countdown has materially moved. Once a window is active, the usual conservation math applies, and near-reset windows of any duration are burned aggressively to avoid waste. If a request gets a `429`, that account is placed on cooldown and the next account is tried. If a request gets a `401`, the plugin refreshes the token and retries once.

When a request body contains `prompt_cache_key`, the router remembers which account last succeeded for that session and prefers to stay on it for a short time. It only abandons that affinity when the alternative account is meaningfully better, blocked, or no longer available.

After the account is chosen, the fetch layer may decorate that attempt with `service_tier: "priority"`. This is intentionally post-ranking: routing still uses the existing quota score, then fast-mode checks fresh usage data for the selected account only. The trigger stays conservative but is now span-aware: for every complete window in every rate limit, it computes `remaining_capacity = 1 - used_percent / 100` and `remaining_time = reset_after_seconds / limit_window_seconds`, then subtracts a required slack that varies by both window size and remaining time. Windows at or below the 5-hour baseline (`18_000s`) require roughly `10%` extra slack early in the window and ease toward `7%` near reset. A 7-day window (`604_800s`) starts around `8%` and eases toward `2%`, with log-scaled interpolation for spans in between. Priority is enabled only when the minimum `remaining_capacity - remaining_time - required_slack` across all complete windows is non-negative. Caller-provided `service_tier` or `serviceTier` always wins, stale quota never enables fast-mode, and each retry/failover rebuilds its body from the immutable base snapshot so one account's tier choice never leaks into another attempt. The account-selection toast includes a `Fast-mode enabled` or `Fast-mode disabled` line for the winning attempt, marks the selected account with `>` in the `Account:`/`Accounts:` list, and sticky sessions emit a separate fast-mode toast if that state flips later without switching accounts.

## Install

1. Install dependencies:

```bash
bun install
```

2. Build the plugin:

```bash
bun run build
```

3. Point opencode at the built entry:

```json
{
  "plugin": ["file:///path/to/codex-pool/dist/index.js"]
}
```

For source-based local development, pointing opencode at `src/index.ts` also works:

```json
{
  "plugin": ["file:///path/to/codex-pool/src/index.ts"]
}
```

## Authentication flows

The plugin exposes four auth methods:

- `Login primary Codex account (browser)`
- `Login primary Codex account (headless)`
- `Add Codex account (browser)`
- `Add Codex account (headless)`

The primary login keeps opencode's main `openai` auth record in OAuth mode so Codex stays active. Additional accounts are stored in SQLite and represented in auth state with an inert shadow provider marker rather than replacing the primary provider.

If the SQLite store is empty but opencode already has a valid primary OAuth record, the plugin bootstraps that primary account into the database automatically.

## Storage and runtime behavior

- Default database path: `~/.local/share/opencode/codex-pool.db`
- SQLite is the runtime source of truth for accounts, cooldowns, refresh locks, and shared quota cache.
- The database runs in WAL mode so multiple opencode instances can share the same state.
- Quota scores are cached for 60 seconds and reused across instances.
- When quota cache data is missing, requests keep current priority order for the foreground request and warm cache data in the background. When cache data is stale but still within the 24-hour fallback window, requests reuse the stale scores for ordering while warming fresh data in the background.
- Dynamic fast-mode uses the selected account's in-memory usage cache. Fresh usage stays authoritative for 60 seconds; older cached usage may still drive `service_tier: "priority"` for the current attempt while a background refresh is started.
- Successful token refresh clears the account's cached quota score so future ranking uses fresh credentials.

## Development

```bash
bun run build
bun run typecheck
bun test
```

Tests use real SQLite databases (`:memory:` or temporary files), including multi-instance sharing behavior.

## Source layout

```text
src/
  index.ts   - plugin entry, auth hook, auth methods, loader
  fetch.ts   - quota-aware routing, 429 failover, sticky affinity, token refresh, refresh locking
  store.ts   - SQLite CRUD for accounts, cooldowns, locks, quota cache
  oauth.ts   - browser OAuth flow, device flow, token refresh
  sync.ts    - bootstrap existing primary auth into SQLite
  codex.ts   - PKCE helpers, JWT parsing, token exchange
  types.ts   - shared types and constants
test/
  fetch.test.ts - routing and failover tests
  store.test.ts - store behavior tests
```

## Notes and caveats

- The primary account is special: it is mirrored back into opencode's `openai` auth so Codex-specific behavior remains enabled.
- Different ChatGPT accounts do not share the same server-side prompt cache, so switching accounts mid-session can increase latency.
- Quota ordering balances absolute window capacity against recovery cost. Larger windows (e.g. 7-day) receive a sqrt-scaled capacity boost reflecting their greater absolute token room. First-use-anchored windows stay dormant until touched, so untouched windows keep that capacity boost without conservation dampening in order to encourage early activation; once a window is active, long-recovery windows (over 4 hours until reset) receive logarithmic conservation dampening capped at a 2-week horizon. The router prefers accounts with more effective remaining capacity, accounting for both window size and whether the recovery clock has started.
- Failed usage fetches do not write a negative cache entry; routing falls back to existing order and retries warming later.
- Request bodies are snapshotted before retries so failover and token refresh can replay the same payload safely.
- Dynamic `service_tier` injection only applies to JSON request bodies headed to the rewritten Codex endpoint, and only when the caller did not already set a tier explicitly.
- If every available account is rate limited, the last `429` response is returned.
