# codex-pool

An opencode plugin that pools multiple OpenAI Codex accounts and routes requests to whichever account has the most remaining quota.

## Why

ChatGPT Pro and Plus plans have rate limits. If you have multiple accounts, you can use them together. codex-pool scores each account by remaining capacity, picks the best one for every request, fails over to another account when one hits its limit, and toggles fast-mode (OpenAI's priority processing tier) based on real-time quota headroom.

## Features

**Quota-aware routing.** Every account is scored by how much capacity it has left. Plan weights follow the official quota ratios, compressed with a square root so larger plans stay favored without always winning. Current weights are Plus/Team/default = `1`, Pro (5x Plus) = `sqrt(5)`, and Pro (20x Plus) = `sqrt(20)`. The highest-scoring account handles the next request.

Selection toasts use compact internal plan labels to keep columns aligned: `plus`, `team`, `pro5`, and `pro20`.

**Automatic fast-mode.** When quota is healthy enough, the plugin enables OpenAI's priority processing tier for faster responses. When headroom tightens, it drops back to default. The threshold is score-based, not a fixed percentage.

**Dormant window activation.** Rate-limit windows that haven't been touched yet (0% used, full timer remaining) get promoted once to start their timer. This avoids wasting windows that would otherwise sit idle until they expire.

**Sticky sessions.** Once a session uses an account successfully, it sticks to that account for 5 minutes to keep OpenAI's server-side prompt cache warm. It only switches when the quota gap is large enough to justify the cache miss.

**Automatic failover.** If an account hits its rate limit, the request immediately retries on the next-best account. The blocked account is put on cooldown until its limit resets, and selection toasts show the remaining blocked time as `Xh Ym` or `Ym` using the most exhausted blocked window when usage data includes multiple reset timers.

**Cross-process safety.** Account state, usage cache, cooldowns, and token refresh locks live in SQLite. Multiple opencode processes share the same data without redundant API calls or race conditions.

**Multi-window ranking.** When an account has multiple rate-limit windows (e.g. 5-hour and 7-day), the longest window drives the score. Shorter windows act as guardrails, but their pace penalty is scaled by how much earlier they reset than the main window. If both windows reset together, the pace guard drops away; low-cap floors still apply.

## Requirements

- Bun runtime
- opencode with the built-in Codex plugin enabled
- At least one ChatGPT Pro (5x), Pro (20x), or Plus account

## Install

```sh
bun install
bun run build
```

Add to your opencode config (`~/.config/opencode/config.json`):

```json
{
  "plugin": ["file:///path/to/codex-pool/dist/index.js"]
}
```

For development, you can point at the TypeScript source directly since Bun handles it:

```json
{
  "plugin": ["file:///path/to/codex-pool/src/index.ts"]
}
```

## Setup

### Primary account

Your existing opencode Codex OAuth login becomes the primary account. If you haven't logged in yet, use one of the auth methods in opencode:

- **Login primary Codex account (browser)** opens the standard OAuth flow.
- **Login primary Codex account (headless)** uses the device-code flow for headless environments.

### Pool accounts

Add more accounts from the auth menu:

- **Add pool account (browser)**
- **Add pool account (headless)**

Each pool account is stored in SQLite and joins the routing pool alongside the primary.

### Managing accounts

**Edit pool accounts** in the auth menu lists current pool accounts and lets you remove them.

## Configuration

codex-pool reads `~/.config/opencode/codex-pool.json` on startup. Auto-created with defaults if missing.

```json
{
  "fast-mode": "auto",
  "sticky-mode": "always",
  "sticky-strength": 1,
  "dormant-touch": "new-session-only"
}
```

### Options

| Key | Values | Default | Description |
|---|---|---|---|
| `fast-mode` | `"auto"` `"always"` `"disabled"` | `"auto"` | `auto` enables priority tier when quota is healthy. `always` forces it. `disabled` never adds it. |
| `sticky-mode` | `"auto"` `"always"` `"disabled"` | `"always"` | `always` holds the session on its account for the full affinity window. `auto` allows switching when the score gap is large enough. `disabled` routes purely by score. |
| `sticky-strength` | Number >= 0 | `1` | Multiplier for the sticky switch margin in `auto` mode. `0` disables the margin. Higher values make sessions stickier. |
| `dormant-touch` | `"always"` `"new-session-only"` `"disabled"` | `"new-session-only"` | Controls whether untouched quota windows are promoted to start their timer. `new-session-only` only does this before a session has sticky affinity. |

## How it works

codex-pool hooks into opencode's `provider: "openai"` auth loader. The built-in Codex plugin runs first (model filtering, cost zeroing), then codex-pool replaces the `fetch` function.

On each request:

1. **Usage fetch.** Real-time quota is pulled from each account's usage endpoint. Results are cached in SQLite for 60s and shared across processes. A background poller revalidates active accounts every 30s.

2. **Scoring.** Each account's rate-limit windows are scored by remaining capacity, normalized for window size and recovery time. In multi-window cases, the longest window provides the base score, shorter windows contribute weighted guard pressure only when they expire meaningfully earlier, and hard low-cap floors still apply. Highest composite score wins.

3. **Dispatch.** The request goes to the top-scored account (or the sticky account if affinity is active and the gap isn't big enough to justify switching). If the score clears the fast-mode threshold, the priority processing tier is enabled for this request.

4. **Failover.** If the account hits its rate limit, it goes on cooldown and the request retries on the next candidate. If the account's token has expired, it gets refreshed (coordinated via SQLite lock) and retried once before disabling the account.

## Data storage

| Path | Purpose |
|---|---|
| `~/.config/opencode/codex-pool.json` | Plugin configuration |
| `~/.local/share/opencode/codex-pool.db` | Accounts, tokens, cooldowns, locks, usage cache |

The primary account is mirrored to opencode's `auth.json` for `isCodex` detection. Pool accounts live only in SQLite.

## Development

```sh
bun install
bun test           # run tests
bun run typecheck   # type-check
bun run build       # produce dist/
```

Tests use real SQLite (in-memory or temp files), not mocks.

## License

MIT
