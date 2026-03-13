# codex-pool

External opencode plugin that manages multiple ChatGPT Pro/Plus/Team Codex OAuth accounts with quota-aware core/pool preference and priority-based 429 failover.

## Architecture

This plugin hijacks `provider: "openai"` via `auth.loader`. The built-in Codex plugin runs first (model filtering, cost zeroing), then this plugin overwrites only `fetch` via `mergeDeep`.

Core auth.json stores `type: "oauth"` for the primary account so that `isCodex = true` in opencode's `llm.ts:65`, preserving exact Codex behavior parity (`options.instructions`, system prompt, `maxOutputTokens`).

### Key design decisions

- SQLite (`~/.local/share/opencode/codex-pool.db`) is the sole runtime source of truth for account tokens, cooldown state, and shared quota cache.
- Core `auth.json` is a mirror of the primary account only, kept in sync for `isCodex` activation.
- The built-in Codex `chat.headers` hook is not duplicated; it runs as-is.
- 429 failover is strict priority-based (not round-robin) after request ordering has been decided.

### Remaining-capacity routing

- `core` means the primary mirrored OpenAI OAuth account (`primary_account = 1`); `pool` means every non-primary account in SQLite.
- Routing compares `core` against the highest-priority currently available `pool` account only. Pool accounts keep their internal priority order; the strategy only decides whether `core` stays ahead of the pool group or moves behind it.
- The quota signal comes from `https://chatgpt.com/backend-api/wham/usage`, using the account's bearer token plus `ChatGPT-Account-Id`.
- The decision metric is a burn score computed from any available rate-limit window as `(100 - used_percent) / reset_after_seconds`. Higher score means "this account has more remaining capacity that resets sooner, so burn it first." When both primary and secondary windows exist, use the larger score.
- Quota scores are cached in SQLite (`quota_cache`) for 60 seconds so multiple opencode instances share the same warm cache.
- If the quota cache is missing or stale for either side, do not block the foreground request waiting on usage. Keep the current priority order for that request (which normally means `core` first), and warm the missing usage entries in the background.
- Once both sides have fresh cached scores, reorder requests by score: keep `core` before the pool group when `core >= pool`, otherwise move `core` behind the pool group.
- Failed or non-OK usage fetches do not write a negative cache entry. They leave ordering unchanged and allow the next request to retry warming.
- Successful token refresh for an account must invalidate that account's quota cache before future ranking, because the old score may have been computed from stale credentials.
- Cooldowns and disabled-account handling still apply before quota ranking. Only `store.available()` rows participate in this comparison.

### Coexistence with built-in CodexAuthPlugin

- Built-in loader guard: `if (auth.type !== "oauth") return {}` — passes when core auth is OAuth.
- Built-in loader side effects (model filter + cost zero) are desirable and kept.
- This plugin's loader runs after (external > internal), so `fetch` is overwritten via `mergeDeep`.

## File structure

```
src/
  index.ts   — Plugin entry, auth hook, auth methods, loader
  store.ts   — SQLite account/cooldown/lock/quota-cache CRUD (bun:sqlite, WAL)
  codex.ts   — Codex OAuth constants, PKCE, JWT parsing, token exchange
  oauth.ts   — Browser OAuth flow, headless device flow, token refresh
  sync.ts    — Core auth bootstrap/import, primary mirror sync
  fetch.ts   — Multi-account fetch with quota-aware ordering, 429 failover, token refresh, URL rewrite
  types.ts   — Shared types and constants
```

## Style guide

Follow the opencode repo style (see `/Users/rbr/work/opencode/AGENTS.md`):

- Single-word variable names preferred
- `const` over `let`; ternaries or early returns over reassignment
- Avoid `else`; use early returns
- Avoid unnecessary destructuring; use dot notation
- No `as any`, `@ts-ignore`, or `@ts-expect-error`
- Minimal comments; code should be self-explanatory
- Bun APIs preferred (`bun:sqlite`, `Bun.serve`, `Bun.file`)

## Testing

- Run tests: `bun test` from this directory
- Typecheck: `bunx tsc --noEmit`
- Tests use real SQLite (`:memory:` or temp files), not mocks
- Multi-instance tests use two separate `Database` connections to the same file

## Development

Build the plugin artifact with `bun run build`, then point opencode at the built entry:

```json
{
  "plugin": ["file:///Users/rbr/work/codex-pool/dist/index.js"]
}
```

For source-based local development, pointing at `src/index.ts` still works because Bun can import TypeScript directly.

## Constants

- `CODEX_OAUTH_PORT`: 1456 (differs from built-in 1455 to avoid conflict)
- `CODEX_API_ENDPOINT`: `https://chatgpt.com/backend-api/codex/responses`
- `CODEX_ISSUER`: `https://auth.openai.com`
- `SENTINEL_SHADOW_PROVIDER`: `openai-codex-pool-shadow` (inert auth.json record for additional accounts)
- DB default path: `~/.local/share/opencode/codex-pool.db`

## Upstream references

Key files in the opencode repo that this plugin interacts with:

- `packages/opencode/src/plugin/codex.ts` — Built-in Codex plugin (OAuth flow, fetch, model shaping)
- `packages/opencode/src/provider/provider.ts:1001-1046` — Plugin loader execution loop
- `packages/opencode/src/session/llm.ts:65` — `isCodex` check (`provider.id === "openai" && auth?.type === "oauth"`)
- `packages/opencode/src/plugin/index.ts:48-103` — Plugin load order (internal first, external second)
- `packages/plugin/src/index.ts` — Plugin type definitions (Hooks, AuthHook, Plugin)
