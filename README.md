# codex-pool

Use multiple ChatGPT Codex OAuth accounts from one `openai` provider in opencode.

`codex-pool` keeps normal Codex behavior for your primary account, then automatically spreads requests across extra accounts based on available quota. Here, the primary Codex account means your default `openai` account in opencode. The plugin is built for people who already use opencode and want smoother throughput, fewer hard stops on `429`, and less manual account switching.

## Why you would use this

- Keep using opencode's built-in Codex flow for your main account
- Add extra ChatGPT accounts as overflow capacity
- Route requests to the healthiest account automatically
- Retry on `429` by moving to the next available account
- Preserve short-term session affinity so prompt-cache warmth is not thrown away unnecessarily
- Auto-refresh expired tokens and coordinate that safely across multiple opencode processes

## What it feels like in practice

After setup, you keep using opencode normally.

- Your default `openai` account in opencode stays the primary Codex-compatible account
- Extra accounts live in a shared SQLite store as pool accounts
- Before each prompt attempt, the plugin picks the best currently available account
- If one account is rate-limited, the request can fail over to another account
- opencode shows a small toast explaining which account was chosen and why

You do not need to manually rotate accounts during normal use.

## Quick start

### 1. Install dependencies

```bash
bun install
```

### 2. Build the plugin

```bash
bun run build
```

### 3. Point opencode at the plugin

Add the built plugin entry to your opencode config:

```json
{
  "plugin": ["file:///path/to/codex-pool/dist/index.js"]
}
```

For local development, you can also point opencode at the source entry directly:

```json
{
  "plugin": ["file:///path/to/codex-pool/src/index.ts"]
}
```

## First-time setup in opencode

This plugin adds these auth actions:

- `Login primary Codex account (browser)`
- `Login primary Codex account (headless)`
- `Add pool account (browser)`
- `Add pool account (headless)`
- `Edit pool accounts`

Recommended order:

1. Log in your main opencode `openai` account as the primary Codex account
2. Add one or more extra accounts as pool accounts
3. Start using opencode normally

`Edit pool accounts` lets you remove a non-primary pool account from the SQLite store.

If you already have a valid OAuth login for the default `openai` account in opencode, `codex-pool` bootstraps that account into its database automatically the first time it starts.

## How routing works

At a high level, routing is simple:

- Every available account gets a quota score
- Higher remaining useful capacity means a better score
- The plugin picks the best account for the next request
- If a request gets `429`, that account cools down and the next eligible account is tried
- If a request gets `401`, the plugin refreshes the token and retries once

The scoring is quota-aware, not round-robin. That means the plugin tries to spend capacity where it is most available instead of rotating blindly.

## Primary account vs pool accounts

- `primary`: your default `openai` account in opencode, mirrored as the main OAuth account; this is what keeps opencode in Codex mode
- `pool`: every additional non-primary account stored by the plugin

The primary account is special. It is mirrored back into opencode's `openai` auth so built-in Codex behavior stays active.

## Fast mode

When the selected account still looks healthy, the plugin can add `service_tier: "priority"` to that outbound prompt attempt.

- This decision is made after account selection
- It does not change account ordering
- Caller-provided `service_tier` or `serviceTier` always wins
- If the account looks constrained, fast mode stays off

You will see the fast-mode decision in the pre-request toast, using a compact score summary like `Fast: enabled +1.011 (+1.593 - guard 0.582)` when guard pressure applies.

## Sticky session affinity

Different ChatGPT accounts do not share the same upstream prompt cache. Switching accounts too often can increase latency.

To reduce that, the plugin keeps short-lived per-session affinity:

- If a session already succeeded on one account, the plugin prefers to stay there briefly
- It only switches when another account is materially better, blocked, or unavailable

This gives you better cache reuse without ignoring quota health.

## Storage and shared state

- Database path: `~/.local/share/opencode/codex-pool.db`
- SQLite is the runtime source of truth for accounts, cooldowns, token refresh locks, and quota cache
- WAL mode is enabled so multiple opencode processes can share the same state
- Quota data is cached and reused across processes
- When cached quota data is reused, guard calculations age the cached window by the cache elapsed time before applying guard pressure

In short: one shared local database coordinates the whole pool.

## What you will see in opencode

Before a prompt is sent, the plugin shows a compact toast that includes:

- the selected account
- a short reason for the choice
- quota score details
- whether fast mode is enabled or disabled

Reduced multi-window account scores are shown as `<score> (<base> * guard x<factor>)`.

If stale quota cache is temporarily reused, the toast also shows the cache age. Guard-based ranking and fast-mode guard pressure both age cached windows by that elapsed cache time instead of treating the cached reset time as brand new.

## Limits and behavior to know about

- If all available accounts are rate-limited, the last `429` response is returned
- Accounts are only disabled after a durable auth failure: a request still returns `401` after refresh and one retry
- Failed usage fetches do not permanently poison routing; the plugin keeps existing state and retries later
- Request bodies are snapshotted before retries so failover and refresh can safely replay the same payload

## Architecture

For implementation details and internal design notes, see `docs/architecture.md`.
