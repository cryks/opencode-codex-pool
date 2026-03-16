# codex-pool

External opencode plugin that manages multiple ChatGPT Pro/Plus/Team Codex OAuth accounts with quota-aware core/pool preference and priority-based 429 failover.

## Architecture

This plugin hijacks `provider: "openai"` via `auth.loader`. The built-in Codex plugin runs first (model filtering, cost zeroing), then this plugin supplies a dummy OAuth `apiKey` plus a replacement `fetch` via `mergeDeep`.

Core auth.json stores `type: "oauth"` for the primary account so that `isCodex = true` in opencode's `llm.ts:65`, preserving exact Codex behavior parity (`options.instructions`, system prompt, `maxOutputTokens`).

### Key design decisions

- SQLite (`~/.local/share/opencode/codex-pool.db`) is the sole runtime source of truth for account tokens, cooldown state, and shared usage cache.
- Core `auth.json` is a mirror of the primary account only, kept in sync for `isCodex` activation, while additional accounts stay in SQLite and are represented in auth state through the inert shadow provider.
- Auth methods expose primary login, pool-account addition, and a minimal `Edit pool accounts` manager that lists current non-primary rows and can delete a selected pool account after confirmation.
- The built-in Codex `chat.headers` hook is not duplicated; it runs as-is.
- 429 failover is strict priority-based (not round-robin) after request ordering has been decided.
- The loader also returns `OAUTH_DUMMY_KEY` so the overridden fetch path still satisfies provider auth requirements while keeping Codex OAuth behavior active.

### Remaining-capacity routing

- `core` means the primary mirrored OpenAI OAuth account (`primary_account = 1`); `pool` means every non-primary account in SQLite.
- Routing computes a quota score for every currently available account, then reorders the whole candidate list by score. Higher score goes earlier; equal scores fall back to stored priority order.
- The quota signal comes from `https://chatgpt.com/backend-api/wham/usage`, using the account's bearer token plus `ChatGPT-Account-Id`.
- Each account's burn score is weighted by plan type: Pro = `sqrt(6.7)` (~2.59), Plus/Team/default = 1. The raw ~6.7× capacity ratio between Pro and Plus plans is still the reference observation from published rate-limit tables, but routing intentionally compresses that advantage with a square root so Pro remains favored without monopolizing selection.
- Per-window score is `((plan_weight * (1 - used_percent / 100) * capacity) / (pace * conservation)) * health_factor` once a window is active. `health_factor` is a bounded multiplier derived from `remaining_capacity - remaining_time`, giving healthy windows up to a small bonus and ahead windows up to a slightly larger penalty without overpowering plan weight or window capacity. When `limit_window_seconds` is available, `pace = max(reset_after_seconds / limit_window_seconds, 0.000001)` normalises for elapsed time within the window; otherwise `pace = reset_after_seconds` and conservation and capacity are skipped to avoid double-counting. For first-use-anchored windows that are still dormant (`used_percent = 0` and the reported reset remains effectively at the full span), the router skips conservation and pace urgency, keeping the capacity boost and the same bounded health adjustment so it is willing to start that clock early. Higher score means "this account has more weighted remaining capacity, so burn it first."
- The capacity factor accounts for the absolute size of a rate-limit window: `capacity = sqrt(limit_window_seconds / CAPACITY_REF)`. Larger windows (e.g. 7-day) represent more absolute token capacity than smaller windows (e.g. 5-hour), so the same `used_percent` on a larger window leaves more usable room. The sqrt scaling prevents extreme windows from dominating linearly. A 5-hour window (18,000s) gets `capacity ≈ 3.16`; a 7-day window (604,800s) gets `capacity ≈ 18.33` — a ~5.8× ratio rather than the raw ~33.6× time ratio.
- The conservation factor differentiates tactical (short-recovery) windows from strategic (long-recovery) windows: `conservation = max(1, min(CONSERVATION_CAP, 1 + ln(reset_after_seconds / CONSERVATION_REF)))`. Windows with recovery under 4 hours (`CONSERVATION_REF = 14_400`) receive no dampening. Longer recovery horizons are dampened logarithmically up to a cap derived from a 2-week ceiling (`CONSERVATION_HORIZON = 1_209_600`). Conservation and capacity work as opposing forces after activation: capacity boosts larger windows (more absolute room) while conservation dampens them (longer recovery if exhausted). The health factor then lightly prefers windows whose remaining capacity is ahead of their remaining time, reducing the chance that a mildly ahead large-plan account keeps winning forever on capacity alone. Dormant first-use windows keep the capacity boost without the conservation penalty so the router can touch them early and begin recovery sooner. Once active, moderately-used large windows score well (plenty of absolute capacity despite conservation), while heavily-used large windows still lose to healthier short windows. Near-reset long windows (e.g. a 7-day window with 30 minutes left) receive no conservation dampening and full capacity boost, enabling aggressive use-it-or-lose-it burn.
- If a rate limit reports `allowed = false` or `limit_reached = true`, its score is 0 (fully blocked).
- When both primary and secondary windows exist within `rate_limit`, the **minimum** (most conservative) window score is used. `additional_rate_limits` and `code_review_rate_limit` are ignored for account selection and fast-mode decisions.
- Raw usage payloads are cached in SQLite (`quota_cache`) for 60 seconds so multiple opencode instances share the same warm cache.
- If the shared usage cache is stale but not too old (currently up to 24 hours), keep using the expired cached payloads for the current foreground decision and warm them in the background. `stale` is only a background-refresh signal; it must not change the foreground request into a blocking usage fetch. If the shared usage cache is cold (`missing`) for either side, keep the current priority order and warm in the background. In both cases, do not block the foreground request waiting on usage.
- Once quota scores are available for the full candidate set, reorder requests by score across the entire fleet rather than only at the `core`/`pool` boundary.
- Failed or non-OK usage fetches do not write a negative cache entry. They leave ordering unchanged and allow the next request to retry warming.
- Successful token refresh for an account must invalidate that account's shared usage cache before future ranking, because the old payload may have been computed from stale credentials.
- Cooldowns and disabled-account handling still apply before quota ranking. Only `store.available()` rows participate in this comparison.
- Accounts are only disabled for durable authorization failure: a request that still returns `401` after the plugin refreshes that account and retries once. Transient request, refresh, and usage-fetch errors must not disable the account.

### Dynamic fast-mode

- Fast-mode is implemented as post-ranking request decoration inside `src/fetch.ts`; it does **not** change account ordering or sticky affinity.
- The final outbound field is OpenAI's `service_tier`, even though upstream config and provider options may use `serviceTier`.
- Fast-mode uses the same shared SQLite raw usage cache that ranking uses for the current attempt. Fresh usage is authoritative for 60 seconds; stale cached usage may still drive the current foreground decision while a background refresh starts. Only `missing` usage should force a synchronous warm-up before a single-account prompt attempt.
- The trigger is score-based. For every complete considered window, compute the existing selection `windowScore`, then normalize it against a balanced same-window baseline where `remaining_capacity == remaining_time` (`left == time`). The normalized fast-mode window score is `ln(windowScore(actual) / windowScore(balanced))`, so `0` means on-pace, positive means healthier than pace, and negative means ahead of pace. Fast-mode reduces the active account windows into a profile: `floor = min(z_i)`, `spread = max(z_i) - min(z_i)`, `debt = max(0, -floor)`, `gap = debt > 0 ? max(0, z_deciding - floor) : 0`, and `profile_score = floor - 0.35 * debt * spread - 0.25 * debt * gap`. The current attempt enables fast-mode at `profile_score >= 0.05`; a sticky session that was already fast-enabled keeps it until the score falls below `-0.02`.
- Windows with less than `3%` remaining capacity force fast-mode off regardless of score. Missing `rate_limit` data still yields `no data`. Complete `additional_rate_limits` participate in the fast-mode profile so another active ahead window can veto `service_tier: "priority"` even when the deciding `rate_limit` window is healthy. Untouched dormant windows stay out of the profile once any active window exists. `code_review_rate_limit` remains ignored.
- If any considered limit is blocked (`allowed = false` or `limit_reached = true`) or the main `rate_limit` window data is incomplete for fast-mode math, fast-mode stays off.
- Caller-provided `service_tier` or `serviceTier` takes precedence and must not be overridden by the plugin.
- Request bodies remain immutably snapshotted before retries. Each 401 retry or 429 failover rebuilds an attempt-local JSON body so `service_tier: "priority"` never leaks across accounts or attempts.
- The account-selection toast must include `Fast-mode enabled` or `Fast-mode disabled` for the current attempt, identify the selected account with a `>` prefix in the `Account:`/`Accounts:` list, format each row with `[plan] account:` on one line and `[window] score ...` on the next line so all available account-selection window scores are visible (for example `[5h] 10.000 [7d] 23.000`) while ranking still uses the minimum score internally, right-align numeric score text so decimal points line up across rows when practical, include a dedicated fast-mode section that uses compact ASCII-style bars plus `status  enabled` or `status  disabled (<reason>)`, show a single `target` only for non-profile blockers, and otherwise show the profile evidence as per-window normalized scores plus `= base`, any applied `- drift` / `- bias` deductions, and `= final`. The toast must fire immediately before the outbound prompt request for that account. A sticky session must still emit a separate toast when fast-mode flips without an account switch, and that flip toast must use the same fast-mode graph section.

### Sticky affinity

- Different ChatGPT accounts are isolated cache scopes on the provider side. OpenAI's server-side prompt cache is not shared between organizations/accounts, so switching accounts mid-session forces a cache miss and increases latency.
- To preserve provider-side prompt cache warmth, the routing layer tracks which account last handled a successful response (`res.ok`) **per session** and prefers that account for subsequent requests within a 5-minute window (`AFFINITY_MS = 300_000`), aligned with OpenAI's in-memory prompt cache retention.
- The session identity is derived from the `prompt_cache_key` field in the JSON request body (set to `sessionID` by opencode). Requests without `prompt_cache_key` receive no affinity and always use standard score-based routing.
- Different sessions maintain independent affinity: Session A may be sticky to core while Session B is sticky to pool. This ensures that cross-session routing remains quota-aware and distributes load across accounts.
- The sticky account is only abandoned when: (a) the best currently ranked alternative's quota score exceeds the sticky account's score by more than the adaptive margin, (b) the sticky account's score is 0 (fully blocked), (c) the sticky account is in cooldown or disabled (already excluded by `store.available()`), or (d) the affinity window has expired.
- The adaptive margin is `SWITCH_MARGIN * (0.5 + 0.5 * min(a, b) / max(a, b))` where `SWITCH_MARGIN = 0.2`. When scores are close (both accounts similarly healthy), the margin approaches the full 20%. When scores diverge (one account is conservation-dampened), the margin shrinks toward 10%, making the router more willing to switch away from a strategically constrained account.
- Affinity state lives inside the `createFetch` closure as a `Map<string, Affinity>` keyed by `prompt_cache_key`. Expired entries are pruned when the map exceeds 50 entries, and the entire map resets when the plugin loader re-creates the fetch function.
- When no affinity is active (first request in a session, after expiry, or no `prompt_cache_key`), the standard score ordering applies across every available account.
- Request bodies are snapshotted before retries so failover and refresh retries can safely replay the same payload.
- When the selected account changes, the pre-request selection toast includes a compact score summary for the accounts that participated in the selection decision, marks the chosen account with a `>` prefix in the `Account:`/`Accounts:` list, pads the leading `[plan]` column and trailing account column for readability, shows all available account-selection window scores for each account, includes a short reason string (for example, higher score, quota cache warming, or failover after a `429`), shows whether fast-mode is enabled for that attempt, and explains the fast-mode verdict with the current profile windows plus `= base`, `- drift`, `- bias`, and `= final` when profile data is available.

### Coexistence with built-in CodexAuthPlugin

- Built-in loader guard: `if (auth.type !== "oauth") return {}` — passes when core auth is OAuth.
- Built-in loader side effects (model filter + cost zero) are desirable and kept.
- This plugin's loader runs after (external > internal), so `apiKey` and `fetch` are merged on top of the built-in Codex loader output.

## File structure

```
src/
  index.ts   — Plugin entry, auth hook, auth methods, loader
  store.ts   — SQLite account/cooldown/lock/shared-usage-cache CRUD (bun:sqlite, WAL)
  codex.ts   — Codex OAuth constants, PKCE, JWT parsing, token exchange
  oauth.ts   — Browser OAuth flow, headless device flow, token refresh
  sync.ts    — Bootstrap an existing primary OAuth auth record into SQLite
  fetch.ts   — Multi-account fetch with quota-aware ordering, sticky affinity, 429 failover, refresh locking, and request URL rewrite
  types.ts   — Shared types and constants
test/
  fetch.test.ts — Routing, failover, refresh, affinity, and quota-cache behavior
  store.test.ts — SQLite store, cooldown, lock, and shared-cache behavior
```

## Agent rules

- When an agent changes the program's specification — including behavior, architecture, design decisions, routing logic, constants, file structure, or any other documented contract — the agent MUST update both this AGENTS.md and README.md to reflect the change before considering the task complete.

## Style guide

Follow the opencode repo style:

- Single-word variable names preferred
- `const` over `let`; ternaries or early returns over reassignment
- Avoid `else`; use early returns
- Avoid unnecessary destructuring; use dot notation
- No `as any`, `@ts-ignore`, or `@ts-expect-error`
- Minimal comments; code should be self-explanatory
- Bun APIs preferred (`bun:sqlite`, `Bun.serve`, `Bun.file`)

## Testing

- Run tests: `bun test` from this directory
- Typecheck: `bun run typecheck`
- Tests use real SQLite (`:memory:` or temp files), not mocks
- Multi-instance tests use two separate `Database` connections to the same file

## Development

Build the plugin artifact with `bun run build`, then point opencode at the built entry:

```json
{
  "plugin": ["file:///path/to/codex-pool/dist/index.js"]
}
```

For source-based local development, pointing at `src/index.ts` still works because Bun can import TypeScript directly.

## Constants

- `CODEX_OAUTH_PORT`: 1455
- `CODEX_API_ENDPOINT`: `https://chatgpt.com/backend-api/codex/responses`
- `CODEX_ISSUER`: `https://auth.openai.com`
- `SENTINEL_SHADOW_PROVIDER`: `openai-codex-pool-shadow` (inert auth.json record for additional accounts)
- `OAUTH_DUMMY_KEY`: `OAUTH_DUMMY_KEY` (dummy key returned by the loader alongside the custom fetch)
- `REFRESH_LEASE_MS`: `30_000` (SQLite refresh lock lease shared across processes)
- `CONSERVATION_REF`: `14_400` (4 hours — tactical/strategic boundary)
- `CONSERVATION_HORIZON`: `1_209_600` (2 weeks — conservation cap ceiling)
- `CAPACITY_REF`: `1_800` (30 minutes — capacity normalization baseline)
- Stale quota fallback horizon: `86_400_000` ms (24 hours)
- DB default path: `~/.local/share/opencode/codex-pool.db`


## Upstream references

Key files in the opencode repo that this plugin interacts with:

- `packages/opencode/src/plugin/codex.ts` — Built-in Codex plugin (OAuth flow, fetch, model shaping)
- `packages/opencode/src/provider/provider.ts:1001-1046` — Plugin loader execution loop
- `packages/opencode/src/session/llm.ts:65` — `isCodex` check (`provider.id === "openai" && auth?.type === "oauth"`)
- `packages/opencode/src/plugin/index.ts:48-103` — Plugin load order (internal first, external second)
- `packages/plugin/src/index.ts` — Plugin type definitions (Hooks, AuthHook, Plugin)
