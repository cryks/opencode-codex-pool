# codex-pool

Use multiple ChatGPT Codex OAuth accounts through a single `openai` provider in opencode.

`codex-pool` keeps your primary account in normal Codex mode, then uses extra accounts as overflow capacity when quota gets tight.

---

## Why use it?

If you already use opencode with Codex, this plugin helps you stay productive longer without manually swapping accounts.

- keep your primary `openai` account as the normal Codex account
- add extra ChatGPT accounts as a shared pool
- route each request to the healthiest account instead of rotating blindly
- fail over on `429` to the next eligible account
- preserve short-lived session affinity to avoid unnecessary prompt-cache misses
- refresh OAuth tokens automatically
- share quota cache, cooldowns, and locks across multiple opencode processes

---

## How it works

`codex-pool` sits on top of opencode's built-in Codex flow.

It mirrors your primary OAuth account so opencode still behaves like normal Codex, then overrides the request fetch path to choose the best account for each prompt attempt.

At a high level:

1. keep the primary account as the Codex-compatible `openai` account
2. store extra accounts in a shared SQLite database
3. score available accounts from current quota data
4. send the request through the best candidate
5. retry after refresh on `401`
6. fail over to the next candidate on `429`

This is quota-aware priority routing, not round-robin rotation.

If you want the internal model, see [docs/architecture.md](docs/architecture.md).

---

## Quick start

### 1. Install dependencies

```bash
bun install
```

### 2. Build the plugin

```bash
bun run build
```

### 3. Register the plugin in opencode

```json
{
  "plugin": ["file:///path/to/codex-pool/dist/index.js"]
}
```

For local development, you can point opencode at the source entry instead:

```json
{
  "plugin": ["file:///path/to/codex-pool/src/index.ts"]
}
```

### 4. Add accounts

The plugin adds these auth actions in opencode:

- `Login primary Codex account (browser)`
- `Login primary Codex account (headless)`
- `Add pool account (browser)`
- `Add pool account (headless)`
- `Edit pool accounts`

Recommended setup order:

1. log in your main `openai` account as the primary account
2. add one or more extra accounts as pool accounts
3. keep using opencode normally

If opencode already has a valid OAuth login for the default `openai` account, `codex-pool` bootstraps it automatically on first load.

---

## What gets configured

On startup, the plugin ensures this config file exists:

`~/.config/opencode/codex-pool.json`

Default config:

```json
{
  "fast-mode": "auto",
  "sticky-mode": "always",
  "sticky-strength": 1,
  "dormant-touch": "new-session-only"
}
```

Restart opencode after editing the file.

### Options

#### `fast-mode`

- `auto`: add `service_tier: "priority"` only when the selected account still looks healthy
- `always`: always add `service_tier: "priority"` when the caller did not already set a tier
- `disabled`: never add plugin-managed fast mode

#### `sticky-mode`

- `auto`: keep short-lived session affinity unless another account is materially better
- `always`: hold the sticky account for the affinity window unless it becomes unavailable
- `disabled`: always use fresh score ordering

#### `sticky-strength`

- `1`: default switching resistance
- `0`: no extra sticky margin
- `>1`: stronger resistance to switching accounts during a sticky session

#### `dormant-touch`

- `always`: start untouched dormant windows once before normal score ordering
- `new-session-only`: allow dormant-touch only before a session has active sticky affinity
- `disabled`: disable that promotion path

If the config file is invalid, the plugin falls back to defaults and shows a warning toast.

---

## Why routing feels better

Most multi-account setups stop at simple failover or manual switching.

`codex-pool` goes further by choosing accounts based on current quota health and keeping short-lived session affinity when it helps.

Highlights:

- **quota-aware routing** instead of blind rotation
- **strict `429` failover** to the next eligible account
- **sticky affinity** to avoid unnecessary prompt-cache misses
- **optional fast mode** for healthy accounts
- **shared SQLite state** across multiple opencode processes

For the internal routing model, storage layout, and retry rules, see [docs/architecture.md](docs/architecture.md).

---

## Development

Run the core checks from this directory:

```bash
bun test
bun run typecheck
bun run build
```

Tests use real SQLite databases rather than mocks.

---

## Limitations

- if all available accounts are rate-limited, the last `429` response is returned
- accounts are disabled only after a durable auth failure, not after transient request issues
- failed quota fetches do not permanently poison routing
- request bodies are snapshotted before retries so refresh and failover can safely replay them

---

## Status

This project is currently marked `private` in `package.json` and is structured as an external opencode plugin.

If you want to publish it as an npm package later, the current README structure should already fit that transition well.
