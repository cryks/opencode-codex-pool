import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { open } from "../src/store";
import type { Store } from "../src/store";
import { CAPACITY_REF } from "../src/types";
import type { Account, Usage } from "../src/types";

const PRO_PLAN_WEIGHT = Math.sqrt(6.7);

function row(
  id: string,
  priority: number,
  over: Partial<Account> = {},
): Account {
  const now = Date.now();
  return {
    id,
    subject: `${id}-subject`,
    email: `${id}@example.com`,
    chatgpt_account_id: `${id}-chat`,
    label: id,
    plan_type: null,
    priority,
    primary: 0,
    access_token: `${id}-access`,
    refresh_token: `${id}-refresh`,
    expires_at: now + 3_600_000,
    disabled_at: null,
    last_error: null,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

function scored(score: number, plan = "plus"): Usage {
  if (score === 0) {
    return {
      plan_type: plan,
      rate_limit: {
        allowed: false,
      },
    };
  }

  const weight = plan === "pro" ? PRO_PLAN_WEIGHT : 1;
  const span = CAPACITY_REF * (score / weight) ** 2;
  return {
    plan_type: plan,
    rate_limit: {
      primary_window: {
        used_percent: 0,
        reset_after_seconds: span,
        limit_window_seconds: span,
      },
    },
  };
}

describe("store", () => {
  let store: Store;

  beforeEach(() => {
    store = open(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("handles account crud", () => {
    store.upsert(row("a", 0));
    store.upsert(row("b", 1));

    expect(store.count()).toBe(2);
    expect(store.get("a")).toMatchObject({
      id: "a",
      access_token: "a-access",
      priority: 0,
    });
    expect(store.list().map((item) => item.id)).toEqual(["a", "b"]);

    expect(store.remove("a")).toBe(true);
    expect(store.get("a")).toBeNull();
    expect(store.count()).toBe(1);
    expect(store.list().map((item) => item.id)).toEqual(["b"]);
  });

  test("keeps a single primary account", () => {
    store.upsert(row("a", 0));
    store.upsert(row("b", 1));
    store.upsert(row("c", 2));

    expect(store.setPrimary("b")).toBe(true);
    expect(store.primary()?.id).toBe("b");
    expect(store.get("b")?.primary).toBe(1);

    expect(store.setPrimary("c")).toBe(true);
    expect(store.primary()?.id).toBe("c");
    expect(store.get("b")?.primary).toBe(0);
    expect(store.get("c")?.primary).toBe(1);
    expect(
      store
        .list()
        .filter((item) => item.primary === 1)
        .map((item) => item.id),
    ).toEqual(["c"]);
    expect(store.setPrimary("missing")).toBe(false);
  });

  test("orders accounts by priority across inserts", () => {
    store.upsert(row("a", 0));
    store.upsert(row("b", 1));
    store.upsert(row("c", 1));
    store.upsert(row("d", 0));

    expect(store.list().map((item) => [item.id, item.priority])).toEqual([
      ["d", 0],
      ["a", 1],
      ["c", 2],
      ["b", 3],
    ]);
  });

  test("disables and re-enables accounts", () => {
    store.upsert(row("a", 0));
    store.upsert(row("b", 1));

    expect(store.disable("a", "boom")).toBe(true);

    const off = store.get("a");
    expect(off?.disabled_at === null).toBe(false);
    expect(off?.last_error).toBe("boom");
    expect(store.list().map((item) => item.id)).toEqual(["b"]);

    expect(store.enable("a")).toBe(true);

    const on = store.get("a");
    expect(on?.disabled_at).toBeNull();
    expect(on?.last_error).toBeNull();
    expect(store.list().map((item) => item.id)).toEqual(["a", "b"]);
  });

  test("updates stored tokens", () => {
    store.upsert(row("a", 0));

    expect(
      store.updateTokens("a", "next-access", "next-refresh", 123_456),
    ).toBe(true);
    expect(store.get("a")).toMatchObject({
      access_token: "next-access",
      refresh_token: "next-refresh",
      expires_at: 123_456,
    });
  });

  test("tracks cooldown state and availability", () => {
    store.upsert(row("a", 0));
    store.upsert(row("b", 1));

    store.setCooldown("a", Date.now() + 60_000, 429, "rate", 60_000);
    expect(store.available().map((item) => item.id)).toEqual(["b"]);

    expect(store.clearCooldown("a")).toBe(true);
    expect(store.available().map((item) => item.id)).toEqual(["a", "b"]);

    store.setCooldown("a", Date.now() - 1_000, 429, "expired");
    expect(store.clearExpired()).toBe(1);
    expect(store.available().map((item) => item.id)).toEqual(["a", "b"]);
  });

  test("acquires, expires, and releases locks", async () => {
    expect(store.acquireLock("refresh:a", "one", 20)).toBe(true);
    expect(store.acquireLock("refresh:a", "two", 20)).toBe(false);

    await Bun.sleep(25);

    expect(store.acquireLock("refresh:a", "two", 20)).toBe(true);
    expect(store.releaseLock("refresh:a", "two")).toBe(true);
    expect(store.acquireLock("refresh:a", "one", 20)).toBe(true);
  });

  test("returns the next priority from the highest row", () => {
    expect(store.nextPriority()).toBe(0);

    store.upsert(row("a", 3));

    expect(store.nextPriority()).toBe(4);
  });

  test("shares quota cache across store instances", () => {
    const path = join(tmpdir(), `codex-pool-${crypto.randomUUID()}.db`);
    const a = open(path);
    const b = open(path);
    const at = Date.now();

    try {
      a.upsert(row("shared", 0));
      a.cacheUsage("shared", scored(0.5), at);

      expect(b.usage("shared", 60_000)).toEqual(scored(0.5));
      expect(b.usageInfo("shared", 60_000)).toEqual({
        body: scored(0.5),
        updated_at: at,
      });

      a.clearUsage("shared");

      expect(b.usage("shared", 60_000)).toBeUndefined();
      expect(b.usageInfo("shared", 60_000)).toBeUndefined();
    } finally {
      a.close();
      b.close();
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    }
  });

  test("shares dormant touch state across store instances and expires it", async () => {
    const path = join(tmpdir(), `codex-pool-${crypto.randomUUID()}.db`);
    const a = open(path);
    const b = open(path);

    try {
      a.upsert(row("shared", 0));
      a.touchDormant("shared", "rate.primary", Date.now() + 20);

      expect(b.dormantTouches("shared")).toEqual(["rate.primary"]);

      await Bun.sleep(25);

      expect(a.clearExpired()).toBe(1);
      expect(b.dormantTouches("shared")).toEqual([]);
    } finally {
      a.close();
      b.close();
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    }
  });
});
