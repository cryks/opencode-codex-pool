# codex-pool

External opencode plugin that manages multiple ChatGPT Pro/Plus/Team Codex OAuth accounts with priority-based 429 failover.

## Architecture

This plugin hijacks `provider: "openai"` via `auth.loader`. The built-in Codex plugin runs first (model filtering, cost zeroing), then this plugin overwrites only `fetch` via `mergeDeep`.

Core auth.json stores `type: "oauth"` for the primary account so that `isCodex = true` in opencode's `llm.ts:65`, preserving exact Codex behavior parity (`options.instructions`, system prompt, `maxOutputTokens`).

### Key design decisions

- SQLite (`~/.local/share/opencode/codex-pool.db`) is the sole runtime source of truth for account tokens and cooldown state.
- Core `auth.json` is a mirror of the primary account only, kept in sync for `isCodex` activation.
- The built-in Codex `chat.headers` hook is not duplicated; it runs as-is.
- 429 failover is strict priority-based (not round-robin). The highest-priority available account is always preferred.

### Coexistence with built-in CodexAuthPlugin

- Built-in loader guard: `if (auth.type !== "oauth") return {}` — passes when core auth is OAuth.
- Built-in loader side effects (model filter + cost zero) are desirable and kept.
- This plugin's loader runs after (external > internal), so `fetch` is overwritten via `mergeDeep`.

## File structure

```
src/
  index.ts   — Plugin entry, auth hook, auth methods, loader
  store.ts   — SQLite account/cooldown/lock CRUD (bun:sqlite, WAL)
  codex.ts   — Codex OAuth constants, PKCE, JWT parsing, token exchange
  oauth.ts   — Browser OAuth flow, headless device flow, token refresh
  sync.ts    — Core auth bootstrap/import, primary mirror sync
  fetch.ts   — Multi-account fetch with 429 failover, token refresh, URL rewrite
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

Load the plugin locally via `file://` URL in opencode config:

```json
{
  "plugin": ["file:///Users/rbr/work/codex-pool/src/index.ts"]
}
```

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
