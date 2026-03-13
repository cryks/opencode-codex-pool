import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { Account } from "./types";

const DEFAULT_PATH = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "codex-pool.db",
);

const ACCOUNT_SQL = `
SELECT
  account.id,
  account.subject,
  account.email,
  account.chatgpt_account_id,
  account.label,
  account.priority,
  account.primary_account AS "primary",
  account.access_token,
  account.refresh_token,
  account.expires_at,
  account.disabled_at,
  account.last_error,
  account.created_at,
  account.updated_at
FROM account
`;

type Num = { value: number };
type Pri = Pick<Account, "priority">;

function file(path?: string) {
  if (!path) return DEFAULT_PATH;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function setup(db: Database) {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA foreign_keys = ON");

  db.run(`
    CREATE TABLE IF NOT EXISTS account (
      id TEXT PRIMARY KEY,
      subject TEXT,
      email TEXT,
      chatgpt_account_id TEXT,
      label TEXT,
      priority INTEGER NOT NULL UNIQUE,
      primary_account INTEGER NOT NULL DEFAULT 0,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      disabled_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS cooldown (
      account_id TEXT PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
      until_at INTEGER NOT NULL,
      retry_after_ms INTEGER,
      status INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS quota_cache (
      account_id TEXT PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
      score REAL NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS "lock" (
      key TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      until_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(
    "CREATE INDEX IF NOT EXISTS account_priority_idx ON account(priority, disabled_at)",
  );
  db.run("CREATE INDEX IF NOT EXISTS cooldown_until_idx ON cooldown(until_at)");
  db.run(
    "CREATE INDEX IF NOT EXISTS quota_cache_updated_idx ON quota_cache(updated_at)",
  );
}

export function open(path?: string) {
  const name = file(path);

  if (name && name !== ":memory:")
    mkdirSync(dirname(name), { recursive: true });

  const db = new Database(name, {
    create: true,
    readwrite: true,
    strict: true,
  });
  setup(db);

  const put = db.prepare<
    unknown,
    {
      access_token: string;
      chatgpt_account_id: string | null;
      created_at: number;
      disabled_at: number | null;
      email: string | null;
      expires_at: number;
      id: string;
      label: string | null;
      last_error: string | null;
      primary: number;
      priority: number;
      refresh_token: string;
      subject: string | null;
      updated_at: number;
    }
  >(`
    INSERT OR REPLACE INTO account (
      id,
      subject,
      email,
      chatgpt_account_id,
      label,
      priority,
      primary_account,
      access_token,
      refresh_token,
      expires_at,
      disabled_at,
      last_error,
      created_at,
      updated_at
    ) VALUES (
      $id,
      $subject,
      $email,
      $chatgpt_account_id,
      $label,
      $priority,
      $primary,
      $access_token,
      $refresh_token,
      $expires_at,
      $disabled_at,
      $last_error,
      $created_at,
      $updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      subject = excluded.subject,
      email = excluded.email,
      chatgpt_account_id = excluded.chatgpt_account_id,
      label = excluded.label,
      priority = excluded.priority,
      primary_account = excluded.primary_account,
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      disabled_at = excluded.disabled_at,
      last_error = excluded.last_error,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `);

  const list = db.prepare<Account, []>(
    `${ACCOUNT_SQL} WHERE account.disabled_at IS NULL ORDER BY account.priority ASC`,
  );
  const get = db.prepare<Account, { id: string }>(
    `${ACCOUNT_SQL} WHERE account.id = $id`,
  );
  const top = db.prepare<Account, []>(
    `${ACCOUNT_SQL} WHERE account.primary_account = 1 LIMIT 1`,
  );
  const old = db.prepare<Pri, { id: string }>(
    "SELECT priority FROM account WHERE id = $id",
  );
  const next = db.prepare<Num, []>(
    "SELECT COALESCE(MAX(priority) + 1, 0) AS value FROM account",
  );
  const bump = db.prepare<
    unknown,
    { id: string; priority: number; span: number }
  >(
    "UPDATE account SET priority = priority + $span WHERE priority >= $priority AND id != $id",
  );
  const settle = db.prepare<unknown, { cut: number; span: number }>(
    "UPDATE account SET priority = priority - $span + 1 WHERE priority >= $cut",
  );
  const clear = db.prepare<unknown, { id: string; now: number }>(
    "UPDATE account SET primary_account = 0, updated_at = $now WHERE primary_account != 0 AND id != $id",
  );
  const mark = db.prepare<unknown, { id: string; now: number }>(
    "UPDATE account SET primary_account = 1, updated_at = $now WHERE id = $id",
  );
  const off = db.prepare<unknown, { err: string; id: string; now: number }>(
    "UPDATE account SET disabled_at = $now, last_error = $err, updated_at = $now WHERE id = $id",
  );
  const on = db.prepare<unknown, { id: string; now: number }>(
    "UPDATE account SET disabled_at = NULL, last_error = NULL, updated_at = $now WHERE id = $id",
  );
  const drop = db.prepare<unknown, { id: string }>(
    "DELETE FROM account WHERE id = $id",
  );
  const count = db.prepare<Num, []>("SELECT COUNT(*) AS value FROM account");
  const token = db.prepare<
    unknown,
    {
      access: string;
      expires: number;
      id: string;
      now: number;
      refresh: string;
    }
  >(
    "UPDATE account SET access_token = $access, refresh_token = $refresh, expires_at = $expires, updated_at = $now WHERE id = $id",
  );
  const cool = db.prepare<
    unknown,
    {
      account_id: string;
      created_at: number;
      reason: string;
      retry_after_ms: number | null;
      status: number;
      until_at: number;
      updated_at: number;
    }
  >(`
    INSERT INTO cooldown (
      account_id,
      until_at,
      retry_after_ms,
      status,
      reason,
      created_at,
      updated_at
    ) VALUES (
      $account_id,
      $until_at,
      $retry_after_ms,
      $status,
      $reason,
      $created_at,
      $updated_at
    )
    ON CONFLICT(account_id) DO UPDATE SET
      until_at = excluded.until_at,
      retry_after_ms = excluded.retry_after_ms,
      status = excluded.status,
      reason = excluded.reason,
      updated_at = excluded.updated_at
  `);
  const warm = db.prepare<unknown, { account_id: string }>(
    "DELETE FROM cooldown WHERE account_id = $account_id",
  );
  const sweep = db.prepare<unknown, { now: number }>(
    "DELETE FROM cooldown WHERE until_at < $now",
  );
  const free = db.prepare<Account, { now: number }>(`
    ${ACCOUNT_SQL}
    LEFT JOIN cooldown ON cooldown.account_id = account.id
    WHERE account.disabled_at IS NULL
      AND (cooldown.account_id IS NULL OR cooldown.until_at < $now)
    ORDER BY account.priority ASC
  `);
  const hold = db.prepare<
    unknown,
    {
      key: string;
      now: number;
      owner: string;
      until_at: number;
      updated_at: number;
    }
  >(`
    INSERT INTO "lock" (
      key,
      owner,
      until_at,
      updated_at
    ) VALUES (
      $key,
      $owner,
      $until_at,
      $updated_at
    )
    ON CONFLICT(key) DO UPDATE SET
      owner = excluded.owner,
      until_at = excluded.until_at,
      updated_at = excluded.updated_at
    WHERE "lock".until_at < $now OR "lock".owner = excluded.owner
  `);
  const release = db.prepare<unknown, { key: string; owner: string }>(
    'DELETE FROM "lock" WHERE key = $key AND owner = $owner',
  );
  const quota = db.prepare<
    { score: number },
    { account_id: string; min_updated_at: number }
  >(
    "SELECT score FROM quota_cache WHERE account_id = $account_id AND updated_at >= $min_updated_at",
  );
  const cache = db.prepare<
    unknown,
    { account_id: string; score: number; updated_at: number }
  >(`
    INSERT INTO quota_cache (
      account_id,
      score,
      updated_at
    ) VALUES (
      $account_id,
      $score,
      $updated_at
    )
    ON CONFLICT(account_id) DO UPDATE SET
      score = excluded.score,
      updated_at = excluded.updated_at
  `);
  const clearQuota = db.prepare<unknown, { account_id: string }>(
    "DELETE FROM quota_cache WHERE account_id = $account_id",
  );

  const upsert = db.transaction((account: Account) => {
    const row = old.get({ id: account.id });

    if (!row || row.priority !== account.priority) {
      const span = (next.get()?.value ?? 0) + 1;
      bump.run({ id: account.id, priority: account.priority, span });
      settle.run({ cut: account.priority + span, span });
    }

    put.run(account);
  });

  const setPrimary = db.transaction((id: string) => {
    const row = get.get({ id });

    if (!row) return false;

    const now = Date.now();
    clear.run({ id, now });
    mark.run({ id, now });
    return true;
  });

  return {
    close() {
      db.close();
    },

    upsert(account: Account) {
      upsert.immediate(account);
    },

    list() {
      return list.all();
    },

    get(id: string) {
      return get.get({ id });
    },

    primary() {
      return top.get();
    },

    setPrimary(id: string) {
      return setPrimary.immediate(id);
    },

    disable(id: string, err: string) {
      const now = Date.now();
      return off.run({ err, id, now }).changes > 0;
    },

    enable(id: string) {
      return on.run({ id, now: Date.now() }).changes > 0;
    },

    remove(id: string) {
      return drop.run({ id }).changes > 0;
    },

    count() {
      return count.get()?.value ?? 0;
    },

    nextPriority() {
      return next.get()?.value ?? 0;
    },

    updateTokens(id: string, access: string, refresh: string, expires: number) {
      const now = Date.now();
      return token.run({ access, expires, id, now, refresh }).changes > 0;
    },

    setCooldown(
      accountId: string,
      untilAt: number,
      status: number,
      reason: string,
      retryAfterMs?: number,
    ) {
      const now = Date.now();
      cool.run({
        account_id: accountId,
        created_at: now,
        reason,
        retry_after_ms: retryAfterMs ?? null,
        status,
        until_at: untilAt,
        updated_at: now,
      });
    },

    clearCooldown(accountId: string) {
      return warm.run({ account_id: accountId }).changes > 0;
    },

    clearExpired() {
      return sweep.run({ now: Date.now() }).changes;
    },

    quota(id: string, maxAgeMs: number) {
      return quota.get({
        account_id: id,
        min_updated_at: Date.now() - maxAgeMs,
      })?.score;
    },

    cacheQuota(id: string, score: number) {
      return cache.run({
        account_id: id,
        score,
        updated_at: Date.now(),
      }).changes > 0;
    },

    clearQuota(id: string) {
      return clearQuota.run({ account_id: id }).changes > 0;
    },

    available() {
      return free.all({ now: Date.now() });
    },

    acquireLock(key: string, owner: string, leaseMs: number) {
      const now = Date.now();
      return (
        hold.run({ key, now, owner, until_at: now + leaseMs, updated_at: now })
          .changes > 0
      );
    },

    releaseLock(key: string, owner: string) {
      return release.run({ key, owner }).changes > 0;
    },
  };
}

export type Store = ReturnType<typeof open>;
