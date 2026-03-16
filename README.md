# codex-pool

`codex-pool` is an external opencode plugin that lets one `openai` provider use multiple ChatGPT Codex OAuth accounts. It keeps the primary account compatible with opencode's built-in Codex behavior, then routes requests across additional accounts with quota-aware ordering, sticky session affinity, and 429 failover.

## What it does

- Mirrors one primary OAuth account into opencode so Codex-specific behavior stays active.
- Stores all account tokens and routing state in SQLite.
- Reorders all currently available accounts by remaining quota score, across both the primary account (`core`) and secondary accounts (`pool`).
- Retries on rate limits by cooling down the current account and moving to the next available one.
- Refreshes expired tokens automatically and coordinates refreshes across processes with SQLite locks.
- Keeps per-session affinity for a short window so prompt-cache warmth is not lost unnecessarily.
- Dynamically injects `service_tier: "priority"` for under-burned requests when cached or freshly warmed usage data shows capacity is ahead of time, with an end-of-window bias that helps spend otherwise stranded capacity before reset.
- Shows a compact selection toast immediately before each outbound prompt attempt, with a `>` marker on the chosen account, whether fast-mode is enabled for that attempt, compared account scores in `[plan] account: score` form with numeric values right-aligned so decimal points line up, the reason that account was chosen, and a compact fast-mode graph that shows the rule label plus `+ left`, `- time`, `+ bonus`, `- margin`, and `= score` for the deciding window when data is available.
- Shows a separate toast when fast-mode flips for the same sticky session without an account switch, using the same compact fast-mode graph format.

## How it works

- **Plugin integration**: The plugin hooks `provider: "openai"` through `auth.loader`. opencode's built-in Codex plugin still runs first, so model filtering and Codex-specific behavior stay intact. This plugin then supplies a dummy OAuth API key plus a replacement fetch layer while leaving the rest of the Codex integration alone.

- **Account model and state**: `core` is the primary mirrored OAuth account that keeps opencode in Codex mode. `pool` is every non-primary account stored in SQLite. SQLite is the runtime source of truth for account tokens, cooldown state, refresh locks, and shared quota cache, while pool auth state is represented with an inert shadow provider marker.

- **Quota-aware routing**: For each request, the router computes a quota score for every currently available account from the ChatGPT usage endpoint, then reorders the full candidate list by score. Higher score means more weighted capacity is worth spending now, and ties fall back to stored priority. The score combines plan weight, remaining capacity, window size, recovery cost, and a bounded health adjustment that lightly favors windows whose remaining capacity is ahead of their remaining time while mildly penalizing ahead-of-time burn. When a limit has both primary and secondary windows, or when additional limits exist, the most conservative score wins. First-use-anchored windows are treated as dormant until their countdown meaningfully starts, so they keep their capacity boost without long-recovery dampening.

- **Sticky affinity**: When a request body includes `prompt_cache_key`, the router remembers which account last succeeded for that session and prefers to stay on it for five minutes. It only switches away when the best currently ranked alternative is materially better, blocked, or no longer available.

- **Dynamic fast-mode**: After the account is chosen, the fetch layer may decorate that attempt with `service_tier: "priority"`. This is intentionally post-ranking: routing uses the shared SQLite quota cache, while fast-mode checks the selected account's separate in-memory usage cache. Fast-mode stays conservative, is span-aware across complete windows, adds an end-of-window burn bonus so near-reset capacity is less likely to be stranded, forces off below a `3%` remaining-capacity floor, turns off when a considered limit is blocked or incomplete, never overrides a caller-provided `service_tier` or `serviceTier`, and now reports the result in the toast as a compact rule label with an ASCII-style `+ / - / =` breakdown for the deciding window when that data exists.

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
- SQLite is the runtime source of truth for accounts, cooldowns, refresh locks, and shared quota cache.
- The database runs in WAL mode so multiple opencode instances can share the same state.
- Quota scores are cached in SQLite for 60 seconds and reused across instances for ranking.
- When shared quota cache data is missing, requests keep current priority order for the foreground request and warm cache data in the background. When shared quota cache data is stale but still within the 24-hour fallback window, requests reuse the stale scores for ordering while warming fresh data in the background.
- Dynamic fast-mode uses a separate in-memory usage cache for the selected account. Fresh usage stays authoritative for 60 seconds; stale cached usage still applies to the current request while a background refresh is started. Only missing usage forces a synchronous warm-up before a single-account prompt attempt.
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
  fetch.ts   - quota-aware routing, request URL rewrite, 429 failover, sticky affinity, token refresh, refresh locking
  store.ts   - SQLite CRUD for accounts, cooldowns, locks, quota cache
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
- Failed usage fetches do not write a negative cache entry; routing falls back to existing order and retries warming later.
- Request bodies are snapshotted before retries so failover and token refresh can replay the same payload safely.
- Dynamic `service_tier` injection only applies to JSON request bodies headed to the rewritten Codex endpoint, and only when the caller did not already set a tier explicitly.
- If every available account is rate limited, the last `429` response is returned.
