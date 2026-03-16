# codex-pool

`codex-pool` is an external opencode plugin that lets one `openai` provider use multiple ChatGPT Codex OAuth accounts. It keeps the primary account compatible with opencode's built-in Codex behavior, then routes requests across additional accounts with quota-aware ordering, sticky session affinity, and 429 failover.

## What it does

- Mirrors one primary OAuth account into opencode so Codex-specific behavior stays active.
- Stores all account tokens and routing state in SQLite.
- Reorders all currently available accounts by remaining quota score, across both the primary account (`core`) and secondary accounts (`pool`).
- Retries on rate limits by cooling down the current account and moving to the next available one.
- Refreshes expired tokens automatically and coordinates refreshes across processes with SQLite locks.
- Keeps per-session affinity for a short window so prompt-cache warmth is not lost unnecessarily.
- Dynamically injects `service_tier: "priority"` for requests whose selected account still looks healthy under the same score model used for account selection, normalized against a balanced burn rate and reduced into an account-wide fast-mode profile.
- Shows a compact selection toast immediately before each outbound prompt attempt, with a `>` marker on the chosen account, whether fast-mode is enabled for that attempt, compared account scores rendered per account with the account label on one line and all available window scores on the next line in `[window] score` form (for example `[5h] 10.000 [7d] 23.000`) while still choosing by the most conservative window internally, the reason that account was chosen, and a compact fast-mode section that shows `status  enabled` or `status  disabled (<reason>)` plus either a specific blocking target or a profile summary with per-window normalized scores, `= base`, any applied `- drift` / `- bias` deductions, and `= final`.
- Shows a separate toast when fast-mode flips for the same sticky session without an account switch, using the same compact fast-mode graph format.

## How it works

- **Plugin integration**: The plugin hooks `provider: "openai"` through `auth.loader`. opencode's built-in Codex plugin still runs first, so model filtering and Codex-specific behavior stay intact. This plugin then supplies a dummy OAuth API key plus a replacement fetch layer while leaving the rest of the Codex integration alone.

- **Account model and state**: `core` is the primary mirrored OAuth account that keeps opencode in Codex mode. `pool` is every non-primary account stored in SQLite. SQLite is the runtime source of truth for account tokens, cooldown state, refresh locks, and shared usage cache, while pool auth state is represented with an inert shadow provider marker.

- **Quota-aware routing**: For each request, the router reads cached raw usage payloads from the ChatGPT usage endpoint, derives a quota score for every currently available account, then reorders the full candidate list by score. Higher score means more weighted capacity is worth spending now, and ties fall back to stored priority. The score combines plan weight, remaining capacity, window size, recovery cost, and a bounded health adjustment that lightly favors windows whose remaining capacity is ahead of their remaining time while mildly penalizing ahead-of-time burn. Within `rate_limit`, the most conservative of the primary and secondary windows wins. `additional_rate_limits` and `code_review_rate_limit` are ignored.

- **Sticky affinity**: When a request body includes `prompt_cache_key`, the router remembers which account last succeeded for that session and prefers to stay on it for five minutes. It only switches away when the best currently ranked alternative is materially better, blocked, or no longer available.

- **Dynamic fast-mode**: After the account is chosen, the fetch layer may decorate that attempt with `service_tier: "priority"`. This is intentionally post-ranking, but it now reads the same shared SQLite raw usage cache that ranking uses instead of keeping a separate fast-mode-only cache. Fast-mode computes a per-window normalized score by comparing the selected scoring formula's real window score against a balanced same-window baseline (`left == time`), then reduces the active windows into an account-wide profile. The lowest normalized window becomes the `base` value; when any active window is already ahead of time, additional deductions from overall window `drift` and deciding-window `bias` make fast-mode more conservative. Untouched dormant windows stay out of the way once any active window exists, complete `additional_rate_limits` participate in this profile, `code_review_rate_limit` stays ignored, windows below the `3%` remaining-capacity floor still force fast-mode off, missing `rate_limit` data still yields `no data`, caller-provided `service_tier` or `serviceTier` still wins, and the toast reports either the specific blocking target or, for profile-based decisions, the per-window normalized scores plus the final `= base`, applied `- drift` / `- bias`, and `= final` breakdown.

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
- When shared usage cache data is missing, requests keep current priority order for the foreground request and warm cache data in the background. When shared usage cache data is stale but still within the 24-hour fallback window, requests reuse the stale payloads for the current foreground decision while warming fresh data in the background.
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
  fetch.ts   - quota-aware routing, shared usage-cache reads, request URL rewrite, 429 failover, sticky affinity, token refresh, refresh locking
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
- Quota ordering balances absolute window capacity against recovery cost. Larger windows (e.g. 7-day) receive a sqrt-scaled capacity boost reflecting their greater absolute token room. First-use-anchored windows stay dormant until touched, so untouched windows keep that capacity boost without conservation dampening in order to encourage early activation; once a window is active, long-recovery windows (over 4 hours until reset) receive logarithmic conservation dampening capped at a 2-week horizon. The router then applies a bounded health multiplier based on `remaining_capacity - remaining_time`, giving healthy windows up to a small bonus and ahead windows up to a slightly larger penalty without overwhelming plan weight or window capacity. The router prefers accounts with more effective remaining capacity, accounting for both window size and whether the recovery clock has started.
- Failed usage fetches do not write a negative cache entry; routing and fast-mode keep using existing cache state and retry warming later.
- Request bodies are snapshotted before retries so failover and token refresh can replay the same payload safely.
- Dynamic `service_tier` injection only applies to JSON request bodies headed to the rewritten Codex endpoint, and only when the caller did not already set a tier explicitly.
- If every available account is rate limited, the last `429` response is returned.
