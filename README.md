# codex-pool

`codex-pool` is an external opencode plugin that lets one `openai` provider use multiple ChatGPT Codex OAuth accounts. It keeps the primary account compatible with opencode's built-in Codex behavior, then routes requests across additional accounts with quota-aware ordering, sticky session affinity, and 429 failover.

## What it does

- Mirrors one primary OAuth account into opencode so Codex-specific behavior stays active.
- Stores all account tokens and routing state in SQLite.
- Reorders all currently available accounts by remaining quota score, across both the primary account (`core`) and secondary accounts (`pool`).
- Retries on rate limits by cooling down the current account and moving to the next available one.
- Refreshes expired tokens automatically and coordinates refreshes across processes with SQLite locks.
- Polls recently active accounts every 30 seconds, revalidates shared usage data in the background once it is older than 3 minutes, and deduplicates those usage fetches across processes with SQLite locks.
- Keeps per-session affinity for a short window so prompt-cache warmth is not lost unnecessarily.
- Dynamically injects `service_tier: "priority"` for requests whose selected account still looks healthy under a longest-window-main, shorter-window-guard fast-mode profile.
- Shows a compact selection toast immediately before each outbound prompt attempt, with a `>` marker on the chosen account, a stale-cache age tag like `(5m ago)` when ranking is using reused usage data, per-account routing summaries that show the reduced score followed by `(<base> * [guard] x<factor>)` when a multi-window `rate_limit` is reduced, the reason that account was chosen, and a one-line fast-mode summary such as `Fast: enabled (+0.806)` or `Fast: disabled (cap<3%, rate.primary)`. When guard debt changes the result, that summary expands inline to include the main window score and guard cost.
- Shows a separate toast when fast-mode flips for the same sticky session without an account switch, using the same one-line fast-mode summary.

## How it works

- **Plugin integration**: The plugin hooks `provider: "openai"` through `auth.loader`. opencode's built-in Codex plugin still runs first, so model filtering and Codex-specific behavior stay intact. This plugin then supplies a dummy OAuth API key plus a replacement fetch layer while leaving the rest of the Codex integration alone.

- **Account model and state**: `core` is the primary mirrored OAuth account that keeps opencode in Codex mode. `pool` is every non-primary account stored in SQLite. SQLite is the runtime source of truth for account tokens, cooldown state, refresh locks, and shared usage cache, while pool auth state is represented with an inert shadow provider marker.

- **Quota-aware routing**: For each request, the router reads cached raw usage payloads from the ChatGPT usage endpoint, derives a quota score for every currently available account, then reorders the full candidate list by score. Higher score means more weighted capacity is worth spending now, and ties fall back to stored priority. The per-window score still combines plan weight, remaining capacity, window size, recovery cost, and a bounded health adjustment. Plan weighting intentionally compresses Pro's published ~6.7x capacity advantage to `sqrt(6.7)` (~2.59). When `rate_limit` exposes multiple complete windows with a clear longest span, the router uses the longest window as the main ranking score and applies shorter windows only as guardrails, multiplying the main score by the worst guard factor derived from ahead-of-time debt and the same `3%` low-cap floor. This keeps 5h windows from owning the rank by default while still letting short-window pressure suppress an account. If the windows cannot be reduced cleanly, ranking falls back to the previous conservative raw-window comparison. `additional_rate_limits` and `code_review_rate_limit` are ignored for ranking. Request-driven warming still applies, and a background poller keeps recently active accounts revalidated between requests.

- **Sticky affinity**: When a request body includes `prompt_cache_key`, the router remembers which account last succeeded for that session and prefers to stay on it for five minutes. It only switches away when the best currently ranked alternative is materially better, blocked, or no longer available.

- **Dynamic fast-mode**: After the account is chosen, the fetch layer may decorate that attempt with `service_tier: "priority"`. This is intentionally post-ranking, but it reads the same shared SQLite raw usage cache that ranking uses. Fast-mode computes a per-window normalized score by comparing the real window score against a balanced same-window baseline (`left == time`). Among the current scored `rate_limit` windows (`rate.primary` / `rate.secondary`), the window with the largest `span` becomes the `main` fast-mode base; if spans tie, the earlier window wins, which currently leaves `primary` as `main`. Every other scored window acts as a guardrail. `additional_rate_limits` are ignored. The final fast-mode score is `main - worst_guard_debt`, where `worst_guard_debt = max(0, -min(guard_scores))`. Windows below the `3%` remaining-capacity floor still force fast-mode off, blocked limits still force it off, missing main `rate_limit` data still yields `no data`, caller-provided `service_tier` or `serviceTier` still wins, and the toast reports a one-line verdict such as `Fast: enabled (+0.592 = main rate.secondary +0.806 - guard 0.214)` or `Fast: disabled (no data)` instead of a multi-line graph.

- **Retries and replay safety**: If a request gets a `429`, that account is placed on cooldown and the next ranked account is tried. If a request gets a `401`, the plugin refreshes the token and retries once. Accounts are only disabled after a request still returns `401` after that refresh retry; transient request, refresh, or usage-fetch errors do not disable the account. Request bodies are snapshotted before retries so failover and token refresh can safely replay the same payload without leaking one attempt's `service_tier` decision into another. Selection toasts are emitted immediately before the outbound prompt attempt for the chosen account.

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

The plugin exposes five auth methods:

- `Login primary Codex account (browser)`
- `Login primary Codex account (headless)`
- `Add pool account (browser)`
- `Add pool account (headless)`
- `Edit pool accounts`

The primary login keeps opencode's main `openai` auth record in OAuth mode so Codex stays active. Additional accounts are stored in SQLite and represented in auth state with an inert shadow provider marker rather than replacing the primary provider. `Edit pool accounts` shows the current non-primary rows, lets you choose one, and asks for deletion confirmation before removing it from SQLite.

If the SQLite store is empty but opencode already has a valid primary OAuth record, the plugin bootstraps that primary account into the database automatically.

## Storage and runtime behavior

- Default database path: `~/.local/share/opencode/codex-pool.db`
- SQLite is the runtime source of truth for accounts, cooldowns, refresh locks, and shared usage cache.
- The database runs in WAL mode so multiple opencode instances can share the same state.
- Raw usage payloads are cached in SQLite for 60 seconds and reused across instances for both ranking and fast-mode.
- Recently active accounts are polled every 30 seconds. The poller only revalidates an account when its shared usage cache is older than 3 minutes, and per-account usage refreshes are deduplicated across opencode processes with a shared SQLite lock.
- When shared usage cache data is missing, requests keep current priority order for the foreground request and warm cache data in the background. When shared usage cache data is stale but still within the 1-hour fallback window, requests reuse the stale payloads for the current foreground decision while warming fresh data in the background, and the selection toast labels that account with the cache age like `(5m ago)`. When a cached usage entry exists but is older than that 1-hour fallback window, the foreground request first shows a `Quota cache expired, fetching usage before selection` toast, waits for the available accounts' usage fetches to finish, and only then runs account selection and shows the normal selection toast.
- Only missing usage forces a synchronous warm-up before a single-account prompt attempt that could use fast-mode.
- Successful token refresh clears the account's cached usage payload so future ranking and fast-mode decisions use fresh credentials.

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
  fetch.ts   - quota-aware routing, shared usage-cache reads and polling, request URL rewrite, 429 failover, sticky affinity, token refresh, refresh locking
  store.ts   - SQLite CRUD for accounts, cooldowns, locks, and shared usage cache
  oauth.ts   - browser OAuth flow, device flow, token refresh
  sync.ts    - bootstrap existing primary auth into SQLite
  codex.ts   - PKCE helpers, JWT parsing, token exchange
  types.ts   - shared types and constants
test/
  fetch.test.ts - routing, failover, refresh, affinity, fast-mode, and cache behavior tests
  index.test.ts - pool account editor auth method tests
  store.test.ts - store, cooldown, lock, and shared cache behavior tests
```

## Notes and caveats

- The primary account is special: it is mirrored back into opencode's `openai` auth so Codex-specific behavior remains enabled.
- Different ChatGPT accounts do not share the same server-side prompt cache, so switching accounts mid-session can increase latency.
- Quota ordering still balances absolute window capacity against recovery cost at the per-window level, but multi-window `rate_limit` values are no longer reduced with a hard minimum by default. The longest complete window now supplies the main ranking score, while shorter complete windows act as guardrails that can only shrink that score. This keeps long-horizon capacity in charge of normal ordering while still respecting short-horizon pressure.
- Failed usage fetches do not write a negative cache entry; routing, fast-mode, and background polling keep using existing cache state and retry warming later.
- Request bodies are snapshotted before retries so failover and token refresh can replay the same payload safely.
- Dynamic `service_tier` injection only applies to JSON request bodies headed to the rewritten Codex endpoint, and only when the caller did not already set a tier explicitly.
- If every available account is rate limited, the last `429` response is returned.
