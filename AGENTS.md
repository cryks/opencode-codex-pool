# codex-pool

External opencode plugin that manages multiple ChatGPT Pro/Plus/Team Codex OAuth accounts with quota-aware core/pool preference and priority-based 429 failover.

## Architecture

This plugin hijacks `provider: "openai"` via `auth.loader`. The built-in Codex plugin runs first (model filtering, cost zeroing), then this plugin supplies a dummy OAuth `apiKey` plus a replacement `fetch` via `mergeDeep`.

Core auth.json stores `type: "oauth"` for the primary account so that `isCodex = true` in opencode's `llm.ts:65`, preserving exact Codex behavior parity (`options.instructions`, system prompt, `maxOutputTokens`).

### Key design decisions

- SQLite (`~/.local/share/opencode/codex-pool.db`) is the sole runtime source of truth for account tokens, cooldown state, and shared quota cache.
- Core `auth.json` is a mirror of the primary account only, kept in sync for `isCodex` activation, while additional accounts stay in SQLite and are represented in auth state through the inert shadow provider.
- The built-in Codex `chat.headers` hook is not duplicated; it runs as-is.
- 429 failover is strict priority-based (not round-robin) after request ordering has been decided.
- The loader also returns `OAUTH_DUMMY_KEY` so the overridden fetch path still satisfies provider auth requirements while keeping Codex OAuth behavior active.

### Remaining-capacity routing

- `core` means the primary mirrored OpenAI OAuth account (`primary_account = 1`); `pool` means every non-primary account in SQLite.
- Routing compares `core` against the highest-priority currently available `pool` account only. Pool accounts keep their internal priority order; the strategy only decides whether `core` stays ahead of the pool group or moves behind it.
- The quota signal comes from `https://chatgpt.com/backend-api/wham/usage`, using the account's bearer token plus `ChatGPT-Account-Id`.
- Each account's burn score is weighted by plan type: Pro = 6.7, Plus/Team/default = 1. The weight reflects the ~6.7× capacity ratio between Pro and Plus plans observed in OpenAI's published rate limit tables, derived from the `plan_type` field in the usage API response.
- Per-window score is `(plan_weight * (1 - used_percent / 100) * capacity) / (pace * conservation)`. When `limit_window_seconds` is available, `pace = max(reset_after_seconds / limit_window_seconds, 0.000001)` normalises for elapsed time within the window; otherwise `pace = reset_after_seconds` and conservation and capacity are skipped to avoid double-counting. Higher score means "this account has more weighted remaining capacity, so burn it first."
- The capacity factor accounts for the absolute size of a rate-limit window: `capacity = sqrt(limit_window_seconds / CAPACITY_REF)`. Larger windows (e.g. 7-day) represent more absolute token capacity than smaller windows (e.g. 5-hour), so the same `used_percent` on a larger window leaves more usable room. The sqrt scaling prevents extreme windows from dominating linearly. A 5-hour window (18,000s) gets `capacity ≈ 3.16`; a 7-day window (604,800s) gets `capacity ≈ 18.33` — a ~5.8× ratio rather than the raw ~33.6× time ratio.
- The conservation factor differentiates tactical (short-recovery) windows from strategic (long-recovery) windows: `conservation = max(1, min(CONSERVATION_CAP, 1 + ln(reset_after_seconds / CONSERVATION_REF)))`. Windows with recovery under 4 hours (`CONSERVATION_REF = 14_400`) receive no dampening. Longer recovery horizons are dampened logarithmically up to a cap derived from a 2-week ceiling (`CONSERVATION_HORIZON = 1_209_600`). Conservation and capacity work as opposing forces: capacity boosts larger windows (more absolute room) while conservation dampens them (longer recovery if exhausted). The net effect is that moderately-used large windows score well (plenty of absolute capacity despite conservation), while heavily-used large windows still lose to healthier short windows. Near-reset long windows (e.g. a 7-day window with 30 minutes left) receive no conservation dampening and full capacity boost, enabling aggressive use-it-or-lose-it burn.
- If a rate limit reports `allowed = false` or `limit_reached = true`, its score is 0 (fully blocked).
- When both primary and secondary windows exist within a single rate limit, the **minimum** (most conservative) window score is used. When additional rate limits exist, the minimum across all limits is taken. A zero in any limit forces the overall score to 0.
- Quota scores are cached in SQLite (`quota_cache`) for 60 seconds so multiple opencode instances share the same warm cache.
- If the quota cache is stale but not too old (currently up to 24 hours), use the expired cached scores for ordering and warm them in the background. If the quota cache is cold (never fetched) for either side, keep the current priority order and warm in the background. In both cases, do not block the foreground request waiting on usage.
- Once both sides have fresh cached scores, reorder requests by score: keep `core` before the pool group when `core >= pool`, otherwise move `core` behind the pool group.
- Failed or non-OK usage fetches do not write a negative cache entry. They leave ordering unchanged and allow the next request to retry warming.
- Successful token refresh for an account must invalidate that account's quota cache before future ranking, because the old score may have been computed from stale credentials.
- Cooldowns and disabled-account handling still apply before quota ranking. Only `store.available()` rows participate in this comparison.

### Dynamic fast-mode

- Fast-mode is implemented as post-ranking request decoration inside `src/fetch.ts`; it does **not** change account ordering or sticky affinity.
- The final outbound field is OpenAI's `service_tier`, even though upstream config and provider options may use `serviceTier`.
- The feature only considers fresh usage data already warmed in the current fetch instance. The shared SQLite stale-cache fallback remains routing-only and must never enable fast-mode.
- The trigger is conservative: for every complete window in every rate limit, compute `remaining_capacity = 1 - used_percent / 100` and `remaining_time = reset_after_seconds / limit_window_seconds`; enable fast-mode only when the minimum `remaining_capacity - remaining_time` is at least `0.1`.
- If any considered limit is blocked (`allowed = false` or `limit_reached = true`) or any present window is incomplete for fast-mode math, fast-mode stays off.
- Caller-provided `service_tier` or `serviceTier` takes precedence and must not be overridden by the plugin.
- Request bodies remain immutably snapshotted before retries. Each 401 retry or 429 failover rebuilds an attempt-local JSON body so `service_tier: "priority"` never leaks across accounts or attempts.
- The account-selection toast must include `Fast-mode enabled` or `Fast-mode disabled` for the winning attempt, and a sticky session must emit a separate toast when fast-mode flips without an account switch.

### Sticky affinity

- Different ChatGPT accounts are isolated cache scopes on the provider side. OpenAI's server-side prompt cache is not shared between organizations/accounts, so switching accounts mid-session forces a cache miss and increases latency.
- To preserve provider-side prompt cache warmth, the routing layer tracks which account last handled a successful response (`res.ok`) **per session** and prefers that account for subsequent requests within a 5-minute window (`AFFINITY_MS = 300_000`), aligned with OpenAI's in-memory prompt cache retention.
- The session identity is derived from the `prompt_cache_key` field in the JSON request body (set to `sessionID` by opencode). Requests without `prompt_cache_key` receive no affinity and always use standard score-based routing.
- Different sessions maintain independent affinity: Session A may be sticky to core while Session B is sticky to pool. This ensures that cross-session routing remains quota-aware and distributes load across accounts.
- The sticky account is only abandoned when: (a) the alternative's quota score exceeds the sticky account's score by more than the adaptive margin, (b) the sticky account's score is 0 (fully blocked), (c) the sticky account is in cooldown or disabled (already excluded by `store.available()`), or (d) the affinity window has expired.
- The adaptive margin is `SWITCH_MARGIN * (0.5 + 0.5 * min(a, b) / max(a, b))` where `SWITCH_MARGIN = 0.2`. When scores are close (both accounts similarly healthy), the margin approaches the full 20%. When scores diverge (one account is conservation-dampened), the margin shrinks toward 10%, making the router more willing to switch away from a strategically constrained account.
- Affinity state lives inside the `createFetch` closure as a `Map<string, Affinity>` keyed by `prompt_cache_key`. Expired entries are pruned when the map exceeds 50 entries, and the entire map resets when the plugin loader re-creates the fetch function.
- When no affinity is active (first request in a session, after expiry, or no `prompt_cache_key`), the standard score comparison applies: `core >= pool` keeps core first, otherwise pool moves ahead.
- Request bodies are snapshotted before retries so failover and refresh retries can safely replay the same payload.
- When the selected account changes, the success toast includes a compact score summary for the accounts that participated in the selection decision, marks the chosen account with a `>` prefix, pads account and plan columns for readability, includes a short reason string (for example, higher score, quota cache warming, or failover after a `429`), and shows whether fast-mode was enabled for that winning attempt.

### Coexistence with built-in CodexAuthPlugin

- Built-in loader guard: `if (auth.type !== "oauth") return {}` — passes when core auth is OAuth.
- Built-in loader side effects (model filter + cost zero) are desirable and kept.
- This plugin's loader runs after (external > internal), so `apiKey` and `fetch` are merged on top of the built-in Codex loader output.

## File structure

```
src/
  index.ts   — Plugin entry, auth hook, auth methods, loader
  store.ts   — SQLite account/cooldown/lock/quota-cache CRUD (bun:sqlite, WAL)
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

## Future work

- Pool accounts currently keep their internal priority order and only the highest-priority pool account participates in the core-vs-pool comparison (`rank()` compares `core` against the first non-primary row only). When multiple pool accounts are supported, they should be re-ranked by quota score so the most available pool account is always the one competing against core. This would make conservation-aware scoring effective across the full fleet, not just the core/pool boundary.

## Upstream references

Key files in the opencode repo that this plugin interacts with:

- `packages/opencode/src/plugin/codex.ts` — Built-in Codex plugin (OAuth flow, fetch, model shaping)
- `packages/opencode/src/provider/provider.ts:1001-1046` — Plugin loader execution loop
- `packages/opencode/src/session/llm.ts:65` — `isCodex` check (`provider.id === "openai" && auth?.type === "oauth"`)
- `packages/opencode/src/plugin/index.ts:48-103` — Plugin load order (internal first, external second)
- `packages/plugin/src/index.ts` — Plugin type definitions (Hooks, AuthHook, Plugin)
