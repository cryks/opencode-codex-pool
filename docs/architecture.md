# Architecture

This document covers the internal design of `codex-pool`.

## Overview

`codex-pool` is an external opencode plugin that lets one `openai` provider use multiple ChatGPT Codex OAuth accounts.

- The default `openai` account in opencode is treated as the primary account
- Additional accounts are stored as pool accounts
- Request routing is quota-aware across the full fleet
- SQLite is the shared runtime source of truth

The goal is to preserve normal Codex behavior for the primary account while adding multi-account routing, token refresh coordination, sticky affinity, and `429` failover.

## Integration model

The plugin hooks `provider: "openai"` through `auth.loader`.

- opencode's built-in Codex plugin runs first
- `codex-pool` then layers in a dummy OAuth `apiKey` and a replacement `fetch`
- the default `openai` auth remains OAuth-backed so opencode still sees Codex mode as active

This keeps built-in Codex behavior such as model shaping and Codex-specific handling intact.

## Account model

- `primary`: the default `openai` account in opencode, mirrored into the plugin store and back into opencode auth
- `pool`: every non-primary account stored in SQLite

The primary account is special because it preserves Codex-mode compatibility. Pool accounts do not replace the primary provider; they extend routing capacity.

## Runtime source of truth

SQLite at `~/.local/share/opencode/codex-pool.db` is the only runtime source of truth for:

- account tokens and metadata
- account priority and primary designation
- cooldown state after rate limits
- shared usage cache
- refresh locks and usage-refresh locks across processes

The database runs in WAL mode so multiple opencode processes can coordinate safely.

## Authentication flows

The plugin exposes these auth actions:

- `Login primary Codex account (browser)`
- `Login primary Codex account (headless)`
- `Add pool account (browser)`
- `Add pool account (headless)`
- `Edit pool accounts`

If SQLite is empty but opencode already has a valid OAuth login for the default `openai` account, the plugin bootstraps that account into SQLite automatically.

## Routing model

Routing is quota-aware, not round-robin.

- every available account is scored
- higher score means more useful capacity is available now
- ties fall back to stored priority
- requests are reordered across the entire fleet, not just at a `core` versus `pool` boundary

The scoring model considers plan weight, remaining capacity, time left in the active window, window size, recovery cost, and bounded health adjustments.

### Multi-window handling

When `rate_limit` exposes multiple complete windows with a clear longest span:

- the longest window becomes the main score
- shorter windows act as guardrails
- the final routing score is the main score reduced by the worst guard pressure

If windows cannot be reduced cleanly, routing falls back to the more conservative raw-window comparison.

`additional_rate_limits` and `code_review_rate_limit` are ignored for account selection.

## Shared usage cache

Usage data comes from ChatGPT usage metadata and is cached in SQLite.

- fresh cache is shared across opencode processes
- stale cache may still be reused briefly while background warming runs
- expired cache is synchronously refreshed when it can no longer represent the active quota state
- per-account usage refreshes are deduplicated with SQLite locks

This keeps ranking reasonably fresh without forcing a network fetch before every request.

## Sticky affinity

Different ChatGPT accounts do not share the same upstream prompt cache. To avoid needless cache misses, `codex-pool` keeps short-lived per-session affinity.

- a session prefers the account that most recently succeeded
- the affinity lasts for a short window
- the router abandons affinity when another account is materially healthier, blocked, or unavailable

Affinity is keyed by `prompt_cache_key` in the request body.

## Fast mode

After account selection, the plugin may decorate the request with `service_tier: "priority"`.

- this is a post-selection decision
- it does not affect account ordering
- caller-supplied `service_tier` or `serviceTier` takes precedence
- low remaining capacity, blocked limits, or incomplete data keep fast mode off

Fast mode uses the same shared usage data as routing.

## Retry and failure behavior

- on `429`, the active account is cooled down and the next eligible account is tried
- on `401`, the plugin refreshes the token and retries once
- an account is only disabled after a durable auth failure: it still returns `401` after refresh and retry
- transient request, refresh, or usage-fetch failures do not disable the account

Request bodies are snapshotted before retries so one attempt's outbound fields do not leak into the next attempt.

## Toasts and observability

Immediately before an outbound prompt attempt, the plugin shows a compact selection toast with:

- the chosen account
- score details
- a short reason for the choice
- fast-mode status

If stale cache is reused, the toast includes the cache age.

## Source layout

```text
src/
  index.ts   - plugin entry, auth hook, auth methods, loader
  fetch.ts   - quota-aware routing, failover, sticky affinity, fast mode, token refresh
  store.ts   - SQLite CRUD for accounts, cooldowns, locks, and shared usage cache
  oauth.ts   - browser OAuth flow, device flow, token refresh
  sync.ts    - bootstrap existing primary auth into SQLite
  codex.ts   - PKCE helpers, JWT parsing, token exchange
  types.ts   - shared types and constants
test/
  fetch.test.ts - routing, failover, refresh, affinity, and cache behavior tests
  index.test.ts - auth method and pool account editor tests
  store.test.ts - store, cooldown, lock, and shared cache behavior tests
```

## Development commands

```bash
bun run build
bun run typecheck
bun test
```
